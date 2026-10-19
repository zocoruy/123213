export type Decision = 'unreviewed' | 'keep' | 'reject';
export type OcrStatus = 'pending' | 'done' | 'error';

export interface Photo {
  id: string;
  path: string;
  fileName: string;
  relativePath: string;
  bytes: number;
  width: number;
  height: number;
  capturedAt: string;
  timeSource: 'exif' | 'file';
  thumbnailUrl: string;
  previewUrl: string;
  decision: Decision;
  rating: number;
  bibNumbers: string[];
  athleteTags: string[];
  perceptualHash: string;
  sharpness: number;
  isBlurry: boolean;
  similarGroupId: string | null;
  ocrStatus: OcrStatus;
  ocrError?: string;
}

export interface Album {
  id: string;
  name: string;
  sourceDir: string;
  importedAt: string;
  photos: Photo[];
  errors: { path: string; message: string }[];
}

export interface AnalysisSettings {
  blurThreshold: number;
  similarityDistance: number;
}

export interface Progress {
  stage: 'import' | 'ocr' | 'export';
  current: number;
  total: number;
  message: string;
}

export interface ExportOptions {
  photoIds: string[];
  groupBy: 'none' | 'athlete' | 'time';
}

export interface ExportResult {
  directory: string;
  copied: number;
  errors: { path: string; message: string }[];
}

export type PhotoPatch = Partial<Pick<Photo, 'decision' | 'rating' | 'bibNumbers' | 'athleteTags'>>;

export interface AlbumApi {
  getAlbum(): Promise<Album | null>;
  importFolder(): Promise<Album | null>;
  updatePhotos(ids: string[], patch: PhotoPatch): Promise<Album>;
  analyze(settings: AnalysisSettings): Promise<Album>;
  recognizeBibs(ids?: string[]): Promise<Album>;
  cancelOperation(): Promise<void>;
  exportPhotos(options: ExportOptions): Promise<ExportResult | null>;
  showInFolder(photoId: string): Promise<void>;
  onProgress(callback: (progress: Progress | null) => void): () => void;
  platform: string;
}

export const DEFAULT_ANALYSIS: AnalysisSettings = { blurThreshold: 65, similarityDistance: 8 };
