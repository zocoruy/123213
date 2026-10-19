import type { Album, AlbumApi, AnalysisSettings, PhotoPatch, Progress } from '../shared/types';
import { createDemoAlbum } from './demo';

declare global {
  interface Window { albumApi?: AlbumApi; }
  interface ImportMeta { readonly env: { BASE_URL: string }; }
}

const STORAGE_KEY = 'sprintselect-demo-v1';
let demo: Album;
try {
  const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
  demo = saved?.id === 'demo-sports' && Array.isArray(saved.photos) ? saved : createDemoAlbum();
} catch { demo = createDemoAlbum(); }
const listeners = new Set<(progress: Progress | null) => void>();

function snapshot(): Album { return structuredClone(demo); }
function save(): Album {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(demo)); } catch { /* private browsing may disable storage */ }
  return snapshot();
}

const browserApi: AlbumApi = {
  platform: 'browser',
  async getAlbum() { return snapshot(); },
  async importFolder() {
    throw new Error('当前是界面演示。请在 Windows 客户端中导入本地照片文件夹；原片会始终保留在原位置。');
  },
  async updatePhotos(ids: string[], patch: PhotoPatch) {
    const selected = new Set(ids);
    demo.photos = demo.photos.map((photo) => selected.has(photo.id) ? { ...photo, ...patch } : photo);
    return save();
  },
  async analyze(settings: AnalysisSettings) {
    for (const photo of demo.photos) photo.isBlurry = photo.sharpness < settings.blurThreshold;
    // Demo groups show the interaction only. Actual dHash analysis runs in the desktop engine.
    demo.photos.forEach((photo, index) => {
      photo.similarGroupId = index < 16 && settings.similarityDistance > 0 ? `demo-group-${Math.floor(index / 4) + 1}` : null;
    });
    return save();
  },
  async recognizeBibs() {
    throw new Error('号码识别需要 Windows 客户端读取原片。演示相册中的号码和人物标签为手工示例。');
  },
  async cancelOperation() { listeners.forEach((listener) => listener(null)); },
  async exportPhotos() {
    throw new Error('当前是演示相册，没有可导出的原片。请在 Windows 客户端导入照片后使用批量导出。');
  },
  async showInFolder() { throw new Error('在 Windows 客户端中可打开原片所在文件夹。'); },
  onProgress(callback) { listeners.add(callback); return () => { listeners.delete(callback); }; },
};

export const api: AlbumApi = window.albumApi ?? browserApi;
