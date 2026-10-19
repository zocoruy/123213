import { existsSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { createWorker, OEM, PSM, type Worker } from 'tesseract.js';
import type { Photo, Progress } from '../shared/types';

export interface BibCandidate {
  text: string;
  confidence: number;
}

export interface BibRecognitionResult {
  id: string;
  numbers: string[];
  error?: string;
}

export interface BibRecognitionOptions {
  onProgress?: (progress: Progress | null) => void;
  signal?: AbortSignal;
  onResult?: (id: string, numbers: string[], error?: string) => void | Promise<void>;
}

// Conservative defaults: small single digits are usually jersey logos or noise.
// Keep strings throughout, because 00127 and 127 can be different race numbers.
export const MIN_BIB_CONFIDENCE = 65;

export function extractBibNumbers(
  candidates: readonly BibCandidate[],
  minConfidence = MIN_BIB_CONFIDENCE,
): string[] {
  const numbers = new Set<string>();
  for (const candidate of candidates) {
    if (!Number.isFinite(candidate.confidence) || candidate.confidence < minConfidence) continue;
    for (const token of candidate.text.trim().split(/\s+/)) {
      if (/^\d{2,6}$/.test(token)) numbers.add(token);
    }
  }
  return [...numbers];
}

/** Worker threads and WASM need real files outside Electron's virtual ASAR. */
function unpackedPath(filePath: string): string {
  const unpacked = filePath.replace(/\.asar([\\/])/, '.asar.unpacked$1');
  return unpacked !== filePath && existsSync(unpacked) ? unpacked : filePath;
}

export function getOcrAssetPaths(): { workerPath: string; corePath: string; langPath: string } {
  const workerPath = unpackedPath(require.resolve('tesseract.js/src/worker-script/node/index.js'));
  const corePath = unpackedPath(path.dirname(require.resolve('tesseract.js-core/package.json')));
  const languageRoot = unpackedPath(path.dirname(require.resolve('@tesseract.js-data/eng/package.json')));
  const langPath = ['4.0.0_best_int', '4.0.0']
    .map((directory) => path.join(languageRoot, directory))
    .find((directory) => existsSync(path.join(directory, 'eng.traineddata.gz')));
  if (!langPath || !existsSync(workerPath) || !existsSync(corePath)) {
    throw new Error('本地 OCR 引擎或英语数字模型缺失，请重新安装完整应用。');
  }
  return { workerPath, corePath, langPath };
}

interface OcrWord {
  text: string;
  confidence: number;
}

interface OcrData {
  text: string;
  confidence: number;
  blocks: { paragraphs: { lines: { words: OcrWord[] }[] }[] }[] | null;
}

function candidatesFromData(data: OcrData): BibCandidate[] {
  const words = data.blocks?.flatMap((block) => block.paragraphs.flatMap((paragraph) =>
    paragraph.lines.flatMap((line) => line.words.map((word) => ({
      text: word.text,
      confidence: word.confidence,
    }))),
  )) ?? [];
  return words.length ? words : [{ text: data.text, confidence: data.confidence }];
}

/**
 * Real, local OCR. Each batch shares one worker and processes one photograph at
 * a time so importing several thousand high-resolution files stays bounded.
 * Cancellation returns completed results; untouched photos stay pending.
 */
export async function recognizeBibs(
  photos: Photo[],
  options: BibRecognitionOptions = {},
): Promise<BibRecognitionResult[]> {
  const results: BibRecognitionResult[] = [];
  const { signal, onProgress, onResult } = options;
  if (!photos.length || signal?.aborted) return results;

  let worker: Worker | undefined;
  let termination: Promise<unknown> | undefined;
  let activePhotoName = '';
  let lastProgressAt = 0;
  const cancelled = Symbol('OCR cancelled');
  let notifyCancelled: (value: typeof cancelled) => void = () => {};
  const cancellation = new Promise<typeof cancelled>((resolve) => { notifyCancelled = resolve; });
  const terminate = () => {
    if (worker && !termination) termination = worker.terminate().catch(() => undefined);
    return termination;
  };
  const onAbort = () => {
    notifyCancelled(cancelled);
    void terminate();
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    onProgress?.({ stage: 'ocr', current: 0, total: photos.length, message: '正在加载本地号码识别模型…' });
    worker = await createWorker('eng', OEM.LSTM_ONLY, {
      ...getOcrAssetPaths(),
      gzip: true,
      // Reading packaged models directly avoids downloading or writing a cache
      // beside user photographs, in the CWD, or under Program Files on Windows.
      cacheMethod: 'none',
      workerBlobURL: false,
      errorHandler: () => {},
      logger: (event) => {
        if (signal?.aborted || !activePhotoName || event.status !== 'recognizing text') return;
        const now = Date.now();
        if (now - lastProgressAt < 120 && event.progress !== 1) return;
        lastProgressAt = now;
        onProgress?.({
          stage: 'ocr', current: results.length, total: photos.length,
          message: `识别中 ${activePhotoName}（${Math.round(event.progress * 100)}%）`,
        });
      },
    });
    if (signal?.aborted) return results;
    const configured = await Promise.race([
      worker.setParameters({
        tessedit_char_whitelist: '0123456789',
        tessedit_pageseg_mode: PSM.SPARSE_TEXT,
        preserve_interword_spaces: '1',
        user_defined_dpi: '200',
      }),
      cancellation,
    ]);
    if (configured === cancelled || signal?.aborted) return results;

    for (const photo of photos) {
      if (signal?.aborted) break;
      activePhotoName = photo.fileName;
      lastProgressAt = 0;
      let result: BibRecognitionResult;
      try {
        // Auto-orient before cropping; camera EXIF rotation otherwise moves the
        // bib outside the crop. Decode only one source photo at a time.
        const image = await sharp(photo.path, { failOn: 'error', limitInputPixels: 120_000_000 })
          .rotate()
          .resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true })
          .flatten({ background: '#ffffff' })
          .grayscale()
          .normalize()
          .png()
          .toBuffer({ resolveWithObject: true });
        if (signal?.aborted) break;

        // Bibs usually occupy the middle/lower torso. Try that larger crop
        // first. A full-frame fallback catches athletes away from the centre.
        const left = Math.floor(image.info.width * 0.12);
        const top = Math.floor(image.info.height * 0.22);
        const crop = await sharp(image.data)
          .extract({
            left,
            top,
            width: Math.max(1, Math.floor(image.info.width * 0.76)),
            height: Math.max(1, Math.floor(image.info.height * 0.64)),
          })
          .resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true })
          .sharpen()
          .png()
          .toBuffer();
        if (signal?.aborted) break;
        const croppedRecognition = await Promise.race([
          worker.recognize(crop, {}, { text: true, blocks: true }),
          cancellation,
        ]);
        if (croppedRecognition === cancelled) break;
        let numbers = extractBibNumbers(candidatesFromData(croppedRecognition.data));

        if (!numbers.length) {
          const fullFrame = await sharp(image.data)
            .resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true })
            .sharpen()
            .png()
            .toBuffer();
          if (signal?.aborted) break;
          const fullRecognition = await Promise.race([
            worker.recognize(fullFrame, {}, { text: true, blocks: true }),
            cancellation,
          ]);
          if (fullRecognition === cancelled) break;
          numbers = extractBibNumbers(candidatesFromData(fullRecognition.data));
        }
        if (signal?.aborted) break;
        result = { id: photo.id, numbers };
      } catch (error) {
        if (signal?.aborted) break;
        result = {
          id: photo.id,
          numbers: [],
          error: error instanceof Error ? error.message : String(error),
        };
      }
      results.push(result);
      // The caller owns persistence and merging with manually entered numbers.
      // Do not mutate the input Photo objects or silently swallow save errors.
      await onResult?.(result.id, result.numbers, result.error);
      onProgress?.({
        stage: 'ocr',
        current: results.length,
        total: photos.length,
        message: `${result.error ? '无法识别' : '已识别'} ${photo.fileName}`,
      });
    }
    return results;
  } catch (error) {
    if (signal?.aborted) return results;
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await terminate();
    onProgress?.(null);
  }
}
