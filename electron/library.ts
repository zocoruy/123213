import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import exifr from 'exifr';
import type { Album, AnalysisSettings, ExportOptions, ExportResult, Photo, PhotoPatch, Progress } from '../shared/types';
import { DEFAULT_ANALYSIS } from '../shared/types';
import { applyAnalysis, applyAnalysisAsync, differenceHash, sharpnessScore } from './analysis';

const SUPPORTED = new Set(['.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff', '.avif']);
const RAW = new Set(['.raw', '.cr2', '.cr3', '.nef', '.nrw', '.arw', '.raf', '.rw2', '.orf', '.dng', '.pef', '.srw']);
const MAX_PHOTOS = 100_000;
const MAX_PATCH_IDS = 10_000;
const MAX_ERRORS = 1000;
type StoredAlbum = Album & { analysisSettings?: AnalysisSettings };
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
const clone = <T>(value: T): T => structuredClone(value);
const idFor = (filePath: string) => createHash('sha256').update(process.platform === 'win32' ? filePath.toLowerCase() : filePath).digest('hex').slice(0, 32);
const csvCell = (value: string | number) => {
  // Excel can execute formulas in imported CSV cells, including file names.
  const safe = typeof value === 'string' && /^[=+\-@\t\r]/.test(value) ? `'${value}` : String(value);
  return `"${safe.replace(/"/g, '""')}"`;
};
const safeSegment = (value: string) => {
  let result = value.normalize('NFKC').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').slice(0, 100);
  if (!result || /^\.+$/.test(result)) result = '未分类';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(result)) result = `_${result}`;
  return result;
};

export class LibraryService {
  private album: Album | null = null;
  private loaded = false;
  private persistence: Promise<void> = Promise.resolve();
  private settings: AnalysisSettings = { ...DEFAULT_ANALYSIS };
  readonly cacheDir: string;
  private readonly metadataPath: string;
  private readonly archiveDir: string;

  constructor(private readonly dataDir: string, private readonly onProgress: (progress: Progress | null) => void = () => {}) {
    this.cacheDir = path.join(dataDir, 'photo-cache');
    this.metadataPath = path.join(dataDir, 'album.json');
    this.archiveDir = path.join(dataDir, 'albums');
  }

  async getAlbum(): Promise<Album | null> {
    await this.load();
    return this.album ? clone(this.album) : null;
  }

  getImagePath(id: string, kind: 'thumbnail' | 'preview'): string | null {
    if (!/^[a-f0-9]{32}$/.test(id) || !this.album?.photos.some(photo => photo.id === id)) return null;
    return path.join(this.cacheDir, `${id}-${kind}.jpg`);
  }

  async getPhoto(id: string): Promise<Photo | null> {
    await this.load();
    const photo = this.album?.photos.find(item => item.id === id);
    return photo ? clone(photo) : null;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    await fs.mkdir(this.cacheDir, { recursive: true });
    try {
      const album = this.parseAlbum(await fs.readFile(this.metadataPath, 'utf8'));
      this.album = album;
      const saved = album.analysisSettings;
      if (saved) {
        try { applyAnalysis([], saved); this.settings = saved; } catch { /* use safe defaults */ }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.loaded = true;
  }

  private parseAlbum(text: string): StoredAlbum {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as Album).photos) || (parsed as Album).photos.length > MAX_PHOTOS || typeof (parsed as Album).sourceDir !== 'string') {
      throw new Error('照片库元数据格式错误，请保留照片库文件后重新导入。');
    }
    const album = parsed as StoredAlbum;
    if (!path.isAbsolute(album.sourceDir) || album.photos.some(photo => typeof photo.id !== 'string' || !/^[a-f0-9]{32}$/.test(photo.id) || typeof photo.path !== 'string' || !path.isAbsolute(photo.path))) {
      throw new Error('照片库路径或照片编号无效。');
    }
    return album;
  }

  private async getArchivedAlbum(sourceDir: string): Promise<StoredAlbum | null> {
    try {
      const album = this.parseAlbum(await fs.readFile(path.join(this.archiveDir, `${idFor(sourceDir)}.json`), 'utf8'));
      if (album.sourceDir !== sourceDir) throw new Error('历史照片库与所选文件夹不匹配。');
      return album;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async saveAlbum(album: Album): Promise<Album> {
    await this.load();
    if (!album || !Array.isArray(album.photos) || album.photos.length > MAX_PHOTOS) throw new Error('照片数量超出照片库上限。');
    this.album = clone(album);
    await this.persist();
    return clone(this.album);
  }

  private async persist(): Promise<void> {
    if (!this.album) return;
    (this.album as StoredAlbum).analysisSettings = { ...this.settings };
    const payload = JSON.stringify({ ...this.album, analysisSettings: this.settings });
    const sourceDir = this.album.sourceDir;
    const operation = this.persistence.catch(() => {}).then(async () => {
      const atomicWrite = async (target: string) => {
        const temporaryPath = `${target}.${randomUUID()}.tmp`;
        try {
          const handle = await fs.open(temporaryPath, 'wx', 0o600);
          try { await handle.writeFile(payload, 'utf8'); await handle.sync(); } finally { await handle.close(); }
          await fs.rename(temporaryPath, target);
        } finally { await fs.unlink(temporaryPath).catch(() => {}); }
      };
      await fs.mkdir(this.archiveDir, { recursive: true });
      await atomicWrite(path.join(this.archiveDir, `${idFor(sourceDir)}.json`));
      await atomicWrite(this.metadataPath);
    });
    this.persistence = operation;
    await operation;
  }

  async importFolder(directory: string, signal?: AbortSignal): Promise<Album> {
    await this.load();
    const sourceDir = await fs.realpath(directory);
    if (!(await fs.stat(sourceDir)).isDirectory()) throw new Error('请选择照片文件夹。');
    const sameAlbum = this.album?.sourceDir === sourceDir;
    // Migrate a legacy single-album file before switching to another event.
    if (!sameAlbum && this.album) await this.persist();
    const historicalAlbum = sameAlbum ? this.album as StoredAlbum : await this.getArchivedAlbum(sourceDir);
    const previous = new Map((historicalAlbum?.photos ?? []).map(photo => [photo.path, photo]));
    let analysisSettings = this.settings;
    if (historicalAlbum?.analysisSettings) {
      try { applyAnalysis([], historicalAlbum.analysisSettings); analysisSettings = historicalAlbum.analysisSettings; } catch { /* use current valid settings */ }
    }
    const errors: Album['errors'] = [];
    const files: string[] = [];
    const addError = (filePath: string, message: string) => { if (errors.length < MAX_ERRORS) errors.push({ path: filePath, message }); };
    const walk = async (dir: string): Promise<void> => {
      if (signal?.aborted) return;
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); }
      catch (error) { addError(dir, messageOf(error)); return; }
      for (const entry of entries) {
        if (signal?.aborted) break;
        const fullPath = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          // Never re-import the application's own generated cache.
          if (fullPath !== this.dataDir && fullPath !== this.cacheDir && entry.name !== '.git' && entry.name !== 'node_modules') await walk(fullPath);
        } else if (entry.isFile()) {
          const extension = path.extname(entry.name).toLowerCase();
          if (SUPPORTED.has(extension)) {
            if (files.length >= MAX_PHOTOS) throw new Error(`单个照片库最多支持 ${MAX_PHOTOS} 张照片。`);
            files.push(fullPath);
          } else if (RAW.has(extension)) addError(fullPath, '暂不支持 RAW 原始格式，请先导出为 JPEG、PNG、WebP、TIFF 或 AVIF。');
        }
      }
    };
    await walk(sourceDir);
    files.sort((a, b) => a.localeCompare(b));
    const photos: (Photo | undefined)[] = new Array(files.length);
    let cursor = 0;
    let completed = 0;
    const emit = () => this.onProgress({ stage: 'import', current: completed, total: files.length, message: signal?.aborted ? `已取消，保留 ${completed} 张已处理照片` : '正在建立缩略图与画质索引' });
    emit();
    const worker = async () => {
      while (!signal?.aborted) {
        const index = cursor++;
        if (index >= files.length) break;
        const filePath = files[index];
        try { photos[index] = await this.processPhoto(filePath, sourceDir, previous.get(filePath)); }
        catch (error) { addError(filePath, messageOf(error)); }
        completed++;
        if (completed % 10 === 0 || completed === files.length) emit();
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(3, files.length) }, worker));
      // Cancelling a different folder must never replace the current event and its decisions.
      if (signal?.aborted && !sameAlbum && this.album) {
        emit();
        return clone(this.album);
      }
      let imported = photos.filter((photo): photo is Photo => Boolean(photo));
      if (signal?.aborted && sameAlbum && this.album) {
        const seen = new Set(imported.map(photo => photo.path));
        imported = [...imported, ...this.album.photos.filter(photo => !seen.has(photo.path))];
      }
      const album: Album = {
        id: historicalAlbum?.id ?? randomUUID(),
        name: path.basename(sourceDir), sourceDir,
        importedAt: new Date().toISOString(), photos: imported, errors,
      };
      await applyAnalysisAsync(album.photos, analysisSettings);
      this.settings = { ...analysisSettings };
      await this.saveAlbum(album);
      emit();
      return clone(album);
    } finally { this.onProgress(null); }
  }

  private async processPhoto(filePath: string, sourceDir: string, previous?: Photo): Promise<Photo> {
    const stat = await fs.stat(filePath);
    const id = idFor(filePath);
    const thumbnailPath = path.join(this.cacheDir, `${id}-thumbnail.jpg`);
    const previewPath = path.join(this.cacheDir, `${id}-preview.jpg`);
    const fileTime = stat.mtime.toISOString();
    // Cache validity records are separate from exported/persisted user decisions.
    const stampPath = path.join(this.cacheDir, `${id}.json`);
    let unchanged = false;
    let cachedPhoto: Photo | undefined;
    try {
      const stamp = JSON.parse(await fs.readFile(stampPath, 'utf8')) as { bytes: number; mtimeMs: number; photo?: Photo };
      unchanged = stamp.bytes === stat.size && stamp.mtimeMs === stat.mtimeMs;
      await Promise.all([fs.access(thumbnailPath), fs.access(previewPath)]);
      if (stamp.photo?.id === id && stamp.photo.path === filePath && /^[0-9a-f]{16}$/.test(stamp.photo.perceptualHash)) cachedPhoto = stamp.photo;
    } catch { unchanged = false; }
    if (unchanged && cachedPhoto) {
      return {
        ...clone(cachedPhoto), relativePath: path.relative(sourceDir, filePath),
        decision: previous?.decision ?? 'unreviewed', rating: previous?.rating ?? 0,
        bibNumbers: clone(previous?.bibNumbers ?? []), athleteTags: clone(previous?.athleteTags ?? []),
        ocrStatus: previous?.ocrStatus ?? 'pending', ocrError: previous?.ocrError,
      };
    }
    // libvips can retain/memory-map filename inputs on Windows after processing.
    // fs.readFile closes the original handle before native decoding starts; only
    // the three active workers retain compressed inputs, never the whole album.
    const input = await fs.readFile(filePath);
    const metadata = await sharp(input, { limitInputPixels: 150_000_000 }).metadata();
    const { data: preview, info } = await sharp(input, { limitInputPixels: 150_000_000 }).rotate()
      .resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 }).toBuffer({ resolveWithObject: true });
    const [hash, sharpness, thumbnail] = await Promise.all([
      differenceHash(preview), sharpnessScore(preview),
      sharp(preview).resize({ width: 480, height: 360, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 78 }).toBuffer(),
    ]);
    await Promise.all([fs.writeFile(previewPath, preview), fs.writeFile(thumbnailPath, thumbnail)]);
    let capturedAt = fileTime;
    let timeSource: Photo['timeSource'] = 'file';
    try {
      const exif = await exifr.parse(input, { pick: ['DateTimeOriginal', 'CreateDate'] });
      const date = exif?.DateTimeOriginal ?? exif?.CreateDate;
      if (date instanceof Date && Number.isFinite(date.getTime())) { capturedAt = date.toISOString(); timeSource = 'exif'; }
    } catch { /* Images without EXIF remain usable. */ }
    const rotated = metadata.orientation !== undefined && metadata.orientation >= 5;
    const photo: Photo = {
      id, path: filePath, fileName: path.basename(filePath), relativePath: path.relative(sourceDir, filePath), bytes: stat.size,
      width: (rotated ? metadata.height : metadata.width) ?? info.width,
      height: (rotated ? metadata.width : metadata.height) ?? info.height,
      capturedAt, timeSource,
      thumbnailUrl: `sprintselect://image/thumbnail/${id}`, previewUrl: `sprintselect://image/preview/${id}`,
      decision: previous?.decision ?? 'unreviewed', rating: previous?.rating ?? 0,
      bibNumbers: previous?.bibNumbers ?? [], athleteTags: previous?.athleteTags ?? [],
      perceptualHash: hash, sharpness, isBlurry: false, similarGroupId: null,
      ocrStatus: unchanged && previous ? previous.ocrStatus : 'pending',
    };
    // A cancelled/closed import can reuse completed image work on the next attempt.
    await fs.writeFile(stampPath, JSON.stringify({ bytes: stat.size, mtimeMs: stat.mtimeMs, photo }));
    return photo;
  }

  async updatePhotos(ids: string[], patch: PhotoPatch): Promise<Album> {
    await this.load();
    if (!this.album) throw new Error('请先导入照片。');
    if (!Array.isArray(ids) || ids.length > MAX_PATCH_IDS || ids.some(id => typeof id !== 'string')) throw new Error(`每次最多更新 ${MAX_PATCH_IDS} 张照片。`);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('照片更新内容无效。');
    const keys = Object.keys(patch);
    if (keys.some(key => !['decision', 'rating', 'bibNumbers', 'athleteTags'].includes(key))) throw new Error('不允许修改照片文件路径或分析数据。');
    if (patch.decision !== undefined && !['unreviewed', 'keep', 'reject'].includes(patch.decision)) throw new Error('照片筛选状态无效。');
    if (patch.rating !== undefined && (!Number.isInteger(patch.rating) || patch.rating < 0 || patch.rating > 5)) throw new Error('星级必须为 0 至 5 的整数。');
    for (const field of ['bibNumbers', 'athleteTags'] as const) {
      const value = patch[field];
      if (value !== undefined && (!Array.isArray(value) || value.length > 20 || value.some(item => typeof item !== 'string' || item.length > 80 || /[\u0000-\u001f]/.test(item)))) throw new Error('号码和运动员标签最多 20 个，每项最多 80 个字符。');
    }
    const cleanPatch = clone(patch);
    for (const field of ['bibNumbers', 'athleteTags'] as const) {
      if (cleanPatch[field]) cleanPatch[field] = [...new Set(cleanPatch[field]!.map(value => value.trim()).filter(Boolean))];
    }
    const selected = new Set(ids);
    if (selected.size && this.album.photos.filter(photo => selected.has(photo.id)).length !== selected.size) throw new Error('部分照片已不在当前照片库中，请刷新后重试。');
    for (const photo of this.album.photos) if (selected.has(photo.id)) Object.assign(photo, clone(cleanPatch));
    await this.persist();
    return clone(this.album);
  }

  async analyze(settings: AnalysisSettings): Promise<Album> {
    await this.load();
    if (!this.album) throw new Error('请先导入照片。');
    await applyAnalysisAsync(this.album.photos, settings);
    this.settings = { ...settings };
    await this.persist();
    return clone(this.album);
  }

  async exportPhotos(directory: string, options: ExportOptions, signal?: AbortSignal): Promise<ExportResult> {
    await this.load();
    if (!this.album) throw new Error('请先导入照片。');
    if (!options || !Array.isArray(options.photoIds) || options.photoIds.length > MAX_PHOTOS || !['none', 'athlete', 'time'].includes(options.groupBy)) throw new Error('导出选项无效。');
    const selected = new Set(options.photoIds);
    const photos = this.album.photos.filter(photo => selected.has(photo.id));
    if (photos.length !== selected.size) throw new Error('部分导出照片已不在当前照片库中。');
    await fs.mkdir(directory, { recursive: true });
    const destination = await fs.realpath(directory);
    const result: ExportResult = { directory: destination, copied: 0, errors: [] };
    const manifestRows: (string | number)[][] = [['exportedFile', 'originalFile', 'capturedAt', 'decision', 'rating', 'bibNumbers', 'athleteTags']];
    let completed = 0;
    try {
      for (const photo of photos) {
        if (signal?.aborted) break;
        try {
          let groups = [''];
          if (options.groupBy === 'athlete') {
            const labels = photo.athleteTags.length ? photo.athleteTags : photo.bibNumbers.length ? photo.bibNumbers : ['未分类'];
            groups = [...new Set(labels.map(safeSegment))];
          } else if (options.groupBy === 'time') {
            const date = new Date(photo.capturedAt);
            groups = [Number.isFinite(date.getTime())
              ? `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
              : 'unknown'];
          }
          const sourceReal = await fs.realpath(photo.path);
          const parsed = path.parse(safeSegment(photo.fileName));
          for (const group of groups) {
            if (signal?.aborted) break;
            try {
              const targetDir = path.join(destination, group);
              await fs.mkdir(targetDir, { recursive: true });
              const realTargetDir = await fs.realpath(targetDir);
              if (realTargetDir !== destination && !realTargetDir.startsWith(`${destination}${path.sep}`)) throw new Error('导出目录包含指向外部的链接，已跳过。');
              let copiedPath = '';
              for (let suffix = 0; suffix < 100_000; suffix++) {
                const name = suffix === 0 ? `${parsed.name}${parsed.ext}` : `${parsed.name} (${suffix})${parsed.ext}`;
                const candidate = path.join(realTargetDir, name);
                if (candidate === sourceReal) continue;
                try { await fs.copyFile(sourceReal, candidate, constants.COPYFILE_EXCL); copiedPath = candidate; break; }
                catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
              }
              if (!copiedPath) throw new Error('同名文件过多，无法创建唯一导出文件名。');
              result.copied++;
              manifestRows.push([path.relative(destination, copiedPath), photo.path, photo.capturedAt, photo.decision, photo.rating, photo.bibNumbers.join(';'), photo.athleteTags.join(';')]);
            } catch (error) {
              if (result.errors.length < MAX_ERRORS) result.errors.push({ path: photo.path, message: `${group ? `${group}: ` : ''}${messageOf(error)}` });
            }
          }
        } catch (error) { if (result.errors.length < MAX_ERRORS) result.errors.push({ path: photo.path, message: messageOf(error) }); }
        completed++;
        this.onProgress({ stage: 'export', current: completed, total: photos.length, message: '正在复制原片并写入筛选清单' });
      }
      if (result.copied) {
        const csv = '\uFEFF' + manifestRows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        await fs.writeFile(path.join(destination, `SprintSelect-${stamp}-${randomUUID().slice(0, 8)}.csv`), csv, { flag: 'wx' });
      }
      return result;
    } finally { this.onProgress(null); }
  }
}
