import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { LibraryService } from './library';
import type { Progress } from '../shared/types';

let temporaryRoot: string;
let source: string;
let data: string;

async function image(filePath: string, color: string = '#1449dd'): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await sharp({ create: { width: 300, height: 200, channels: 3, background: color } }).jpeg().toFile(filePath);
}

const checksum = async (file: string) => createHash('sha256').update(await fs.readFile(file)).digest('hex');

beforeEach(async () => {
  temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sprintselect-library-'));
  source = path.join(temporaryRoot, 'event');
  data = path.join(temporaryRoot, 'user-data');
  await fs.mkdir(source);
});
afterEach(async () => { await fs.rm(temporaryRoot, { recursive: true, force: true }); });

describe('LibraryService integration with real images', () => {
  it('recursively imports, handles corrupt/RAW files, creates previews, and keeps originals intact', async () => {
    const file = path.join(source, 'nested', 'race.jpg');
    await image(file);
    await fs.writeFile(path.join(source, 'unsupported.nef'), 'raw-example');
    await fs.writeFile(path.join(source, 'corrupt.jpg'), 'broken-image');
    const before = await checksum(file);
    const library = new LibraryService(data);
    const album = await library.importFolder(source);
    expect(album.photos).toHaveLength(1);
    expect(album.errors).toHaveLength(2);
    expect(album.errors.some(error => error.message.includes('RAW'))).toBe(true);
    const photo = album.photos[0];
    expect(photo.width).toBe(300);
    expect(photo.height).toBe(200);
    expect(photo.timeSource).toBe('file');
    expect(photo.relativePath).toBe(path.join('nested', 'race.jpg'));
    expect(photo.perceptualHash).toMatch(/^[a-f0-9]{16}$/);
    const thumbnail = library.getImagePath(photo.id, 'thumbnail');
    expect(thumbnail).not.toBeNull();
    expect((await sharp(thumbnail!).metadata()).format).toBe('jpeg');
    expect(library.getImagePath('../album', 'preview')).toBeNull();
    expect(await checksum(file)).toBe(before);
  });

  it('honors EXIF shooting date and rotates portrait previews correctly', async () => {
    await sharp({ create: { width: 300, height: 200, channels: 3, background: 'red' } })
      .withMetadata({ orientation: 6 })
      .withExif({ IFD0: { DateTime: '2026:01:02 03:04:05' }, IFD2: { DateTimeOriginal: '2026:01:02 03:04:05' } })
      .jpeg().toFile(path.join(source, 'rotated.jpg'));
    const library = new LibraryService(data);
    const album = await library.importFolder(source);
    expect(album.photos[0].width).toBe(200);
    expect(album.photos[0].height).toBe(300);
    expect(album.photos[0].timeSource).toBe('exif');
    expect(album.photos[0].capturedAt).toContain('2026-01-02');
    const preview = await sharp(library.getImagePath(album.photos[0].id, 'preview')!).metadata();
    expect(preview.width).toBe(200);
    expect(preview.height).toBe(300);
  });

  it('persists ratings and tags across restart and repeated import, even when a file changes', async () => {
    const file = path.join(source, 'race.jpg');
    await image(file);
    const library = new LibraryService(data);
    const album = await library.importFolder(source);
    const id = album.photos[0].id;
    await library.updatePhotos([id], { decision: 'keep', rating: 5, bibNumbers: ['128', '128'], athleteTags: [' 李明 '] });
    const restarted = new LibraryService(data);
    expect((await restarted.getAlbum())!.photos[0]).toMatchObject({ decision: 'keep', rating: 5, bibNumbers: ['128'], athleteTags: ['李明'] });
    expect((await restarted.importFolder(source)).photos).toHaveLength(1);
    await image(file, '#dfee00');
    const reimported = await restarted.importFolder(source);
    expect(reimported.photos[0]).toMatchObject({ id, decision: 'keep', rating: 5, athleteTags: ['李明'] });
    const files = await fs.readdir(data);
    expect(files.filter(file => file.endsWith('.tmp'))).toHaveLength(0);
    await expect(restarted.updatePhotos([id], { rating: 6 })).rejects.toThrow();
    await expect(restarted.updatePhotos([id], { decision: 'erase' } as never)).rejects.toThrow();
    await expect(restarted.updatePhotos([id], { path: '/other' } as never)).rejects.toThrow();
  });

  it('restores independent event decisions when switching A → B → A across restart', async () => {
    await image(path.join(source, 'a.jpg'));
    const secondSource = path.join(temporaryRoot, 'second-event');
    await image(path.join(secondSource, 'b.jpg'), '#ee1717');
    const library = new LibraryService(data);
    const first = await library.importFolder(source);
    await library.updatePhotos([first.photos[0].id], { decision: 'keep', rating: 5, athleteTags: ['陈一'], bibNumbers: ['0072'] });
    await library.analyze({ blurThreshold: 0, similarityDistance: 0 });
    const second = await library.importFolder(secondSource);
    await library.updatePhotos([second.photos[0].id], { decision: 'reject', rating: 2, athleteTags: ['王二'] });
    await library.analyze({ blurThreshold: 100, similarityDistance: 8 });
    const restarted = new LibraryService(data);
    const restoredFirst = await restarted.importFolder(source);
    expect(restoredFirst.id).toBe(first.id);
    expect(restoredFirst.photos[0]).toMatchObject({ decision: 'keep', rating: 5, athleteTags: ['陈一'], bibNumbers: ['0072'], isBlurry: false });
    const restoredSecond = await restarted.importFolder(secondSource);
    expect(restoredSecond.id).toBe(second.id);
    expect(restoredSecond.photos[0]).toMatchObject({ decision: 'reject', rating: 2, athleteTags: ['王二'], isBlurry: true });
    expect((await fs.readdir(path.join(data, 'albums'))).filter(file => file.endsWith('.json'))).toHaveLength(2);
  });

  it('migrates a legacy single-album library before changing the active folder', async () => {
    await image(path.join(source, 'a.jpg'));
    const secondSource = path.join(temporaryRoot, 'second-event');
    await image(path.join(secondSource, 'b.jpg'));
    const initial = new LibraryService(data);
    const first = await initial.importFolder(source);
    await initial.updatePhotos([first.photos[0].id], { decision: 'keep', athleteTags: ['历史标记'] });
    await fs.rm(path.join(data, 'albums'), { recursive: true });
    const legacy = JSON.parse(await fs.readFile(path.join(data, 'album.json'), 'utf8'));
    delete legacy.analysisSettings;
    await fs.writeFile(path.join(data, 'album.json'), JSON.stringify(legacy));
    const restarted = new LibraryService(data);
    await restarted.importFolder(secondSource);
    const restored = await restarted.importFolder(source);
    expect(restored.photos[0]).toMatchObject({ decision: 'keep', athleteTags: ['历史标记'] });
  });

  it('exports duplicate names without overwriting originals and writes a CSV manifest', async () => {
    const first = path.join(source, 'one', 'race.jpg');
    const second = path.join(source, 'two', 'race.jpg');
    await image(first);
    await image(second, '#12ff45');
    const checksums = await Promise.all([checksum(first), checksum(second)]);
    const library = new LibraryService(data);
    const album = await library.importFolder(source);
    const output = path.join(temporaryRoot, 'exports');
    const result = await library.exportPhotos(output, { photoIds: album.photos.map(photo => photo.id), groupBy: 'none' });
    expect(result.copied).toBe(2);
    expect(result.errors).toEqual([]);
    const files = await fs.readdir(output);
    expect(files).toContain('race.jpg');
    expect(files).toContain('race (1).jpg');
    expect(files.some(file => file.endsWith('.csv'))).toBe(true);
    expect(await Promise.all([checksum(first), checksum(second)])).toEqual(checksums);
    const inSource = await library.exportPhotos(path.dirname(first), { photoIds: [album.photos.find(photo => photo.path === first)!.id], groupBy: 'none' });
    expect(inSource.copied).toBe(1);
    expect(await checksum(first)).toBe(checksums[0]);
  });

  it('sanitizes athlete folders and rejects a directory link that escapes the export root', async () => {
    await image(path.join(source, 'race.jpg'));
    const library = new LibraryService(data);
    const album = await library.importFolder(source);
    const id = album.photos[0].id;
    await library.updatePhotos([id], { athleteTags: ['../../escape'] });
    const output = path.join(temporaryRoot, 'exports');
    const result = await library.exportPhotos(output, { photoIds: [id], groupBy: 'athlete' });
    expect(result.copied).toBe(1);
    const entries = await fs.readdir(output, { withFileTypes: true });
    expect(entries.some(entry => entry.isDirectory() && !entry.name.includes('/'))).toBe(true);
    await library.updatePhotos([id], { athleteTags: ['linked'] });
    const outside = path.join(temporaryRoot, 'outside');
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(output, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const blocked = await library.exportPhotos(output, { photoIds: [id], groupBy: 'athlete' });
    expect(blocked.copied).toBe(0);
    expect(blocked.errors).toHaveLength(1);
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it('exports a shared photo to every athlete, deduplicates sanitized labels, and falls back to all bib numbers', async () => {
    const original = path.join(source, 'race.jpg');
    await image(original);
    const progress: Progress[] = [];
    const library = new LibraryService(data, event => { if (event) progress.push(event); });
    const album = await library.importFolder(source);
    const id = album.photos[0].id;
    const originalHash = await checksum(original);
    await library.updatePhotos([id], { athleteTags: ['陈一', '王二', '陈一.', '王二 '], bibNumbers: ['001', '002'] });
    const output = path.join(temporaryRoot, 'shared-athletes');
    const result = await library.exportPhotos(output, { photoIds: [id], groupBy: 'athlete' });
    expect(result.copied).toBe(2);
    expect(result.errors).toEqual([]);
    expect(await checksum(path.join(output, '陈一', 'race.jpg'))).toBe(originalHash);
    expect(await checksum(path.join(output, '王二', 'race.jpg'))).toBe(originalHash);
    expect((await fs.readdir(output)).filter(name => ['001', '002'].includes(name))).toEqual([]);
    expect(progress.filter(event => event.stage === 'export')).toMatchObject([{ current: 1, total: 1 }]);
    await library.updatePhotos([id], { athleteTags: [] });
    const numbers = await library.exportPhotos(output, { photoIds: [id], groupBy: 'athlete' });
    expect(numbers.copied).toBe(2);
    expect(await checksum(path.join(output, '001', 'race.jpg'))).toBe(originalHash);
    expect(await checksum(path.join(output, '002', 'race.jpg'))).toBe(originalHash);
    expect(await checksum(original)).toBe(originalHash);
  });

  it('exports by local shooting date across UTC midnight and handles invalid timestamps', async () => {
    const previousTimezone = process.env.TZ;
    process.env.TZ = 'Asia/Shanghai';
    try {
      const original = path.join(source, 'midnight.jpg');
      await sharp({ create: { width: 300, height: 200, channels: 3, background: 'green' } })
        .withExif({ IFD2: { DateTimeOriginal: '2026:01:02 00:15:00' } })
        .jpeg().toFile(original);
      const library = new LibraryService(data);
      const album = await library.importFolder(source);
      const photo = album.photos[0];
      expect(photo.timeSource).toBe('exif');
      expect(photo.capturedAt).toBe('2026-01-01T16:15:00.000Z');
      const output = path.join(temporaryRoot, 'date-export');
      const result = await library.exportPhotos(output, { photoIds: [photo.id], groupBy: 'time' });
      expect(result.copied).toBe(1);
      expect(await checksum(path.join(output, '2026-01-02', 'midnight.jpg'))).toBe(await checksum(original));
      photo.capturedAt = 'invalid-date';
      await library.saveAlbum(album);
      const invalid = await library.exportPhotos(output, { photoIds: [photo.id], groupBy: 'time' });
      expect(invalid.copied).toBe(1);
      expect(await checksum(path.join(output, 'unknown', 'midnight.jpg'))).toBe(await checksum(original));
    } finally {
      if (previousTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimezone;
    }
  });

  it('returns completed export work on cancellation and preserves current album on cancelled new import', async () => {
    for (let i = 0; i < 4; i++) await image(path.join(source, `${i}.jpg`));
    const controller = new AbortController();
    let importing = false;
    const progress: Progress[] = [];
    const library = new LibraryService(data, event => {
      if (event) progress.push(event);
      if (event?.stage === 'export' && event.current === 1) controller.abort();
      if (importing && event?.stage === 'import') controller.abort();
    });
    const album = await library.importFolder(source);
    await library.updatePhotos([album.photos[0].id], { decision: 'keep' });
    const result = await library.exportPhotos(path.join(temporaryRoot, 'exports'), { photoIds: album.photos.map(photo => photo.id), groupBy: 'none' }, controller.signal);
    expect(result.copied).toBe(1);
    expect(progress.some(event => event.stage === 'export' && event.current === 1)).toBe(true);
    const newFolder = path.join(temporaryRoot, 'other-event');
    await image(path.join(newFolder, 'new.jpg'));
    importing = true;
    const cancelled = await library.importFolder(newFolder, controller.signal);
    expect(cancelled.sourceDir).toBe(source);
    expect(cancelled.photos).toHaveLength(4);
    expect(cancelled.photos[0].decision).toBe('keep');
  });

  it('resumes a cancelled import after restart and reuses its completed image cache', async () => {
    await Promise.all(Array.from({ length: 18 }, (_, index) => image(path.join(source, `${index}.jpg`))));
    const controller = new AbortController();
    const library = new LibraryService(data, progress => {
      if (progress?.stage === 'import' && progress.current >= 10) controller.abort();
    });
    const partial = await library.importFolder(source, controller.signal);
    expect(partial.photos.length).toBeGreaterThanOrEqual(10);
    expect(partial.photos.length).toBeLessThan(18);
    const first = partial.photos[0];
    await library.updatePhotos([first.id], { decision: 'keep' });
    const preview = library.getImagePath(first.id, 'preview')!;
    const oldDate = new Date('2000-01-01T00:00:00Z');
    await fs.utimes(preview, oldDate, oldDate);
    const restarted = new LibraryService(data);
    const completed = await restarted.importFolder(source);
    expect(completed.photos).toHaveLength(18);
    expect(completed.photos.find(photo => photo.id === first.id)?.decision).toBe('keep');
    expect((await fs.stat(preview)).mtime.toISOString()).toBe(oldDate.toISOString());
  });
});
