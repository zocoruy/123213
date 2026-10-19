import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Photo, Progress } from '../shared/types';
import { extractBibNumbers, getOcrAssetPaths, recognizeBibs } from './ocr';

describe('bib candidate filtering', () => {
  it('keeps leading zeros, deduplicates, and rejects low-confidence noise', () => {
    expect(extractBibNumbers([
      { text: '00127', confidence: 96 },
      { text: '00127\n4827', confidence: 88 },
      { text: '23', confidence: 64 },
      { text: '7 1234567 A123 -12 12.5', confidence: 99 },
      { text: '101', confidence: Number.NaN },
      { text: '00 123456', confidence: 65 },
    ])).toEqual(['00127', '4827', '00', '123456']);
  });

  it('does not convert an uncertain letter O to zero or join distant numbers', () => {
    expect(extractBibNumbers([
      { text: 'OO127 1 2 3', confidence: 99 },
      { text: '123O', confidence: 99 },
    ])).toEqual([]);
  });
});

describe('local offline OCR', () => {
  let directory: string;
  beforeAll(async () => { directory = await mkdtemp(path.join(os.tmpdir(), 'sprintselect-ocr-')); });
  afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

  const photo = (filePath: string, id: string): Photo => ({
    id, path: filePath, fileName: path.basename(filePath), relativePath: path.basename(filePath),
    bytes: 0, width: 1000, height: 700, capturedAt: '', timeSource: 'file', thumbnailUrl: '', previewUrl: '',
    decision: 'unreviewed', rating: 0, bibNumbers: ['manual-keep'], athleteTags: [],
    perceptualHash: '', sharpness: 0, isBlurry: false, similarGroupId: null, ocrStatus: 'pending',
  });

  const makeBib = async (name: string, number: string): Promise<string> => {
    const filePath = path.join(directory, name);
    await sharp(Buffer.from(`<svg width="1000" height="700" xmlns="http://www.w3.org/2000/svg">
      <rect width="1000" height="700" fill="white"/>
      <text x="500" y="425" text-anchor="middle" font-family="Arial, DejaVu Sans, sans-serif" font-weight="bold" font-size="156" fill="black">${number}</text>
    </svg>`)).png().toFile(filePath);
    return filePath;
  };

  it('resolves worker, WASM, and language assets from installed local packages', () => {
    const assets = getOcrAssetPaths();
    expect(path.isAbsolute(assets.workerPath)).toBe(true);
    expect(path.isAbsolute(assets.corePath)).toBe(true);
    expect(path.isAbsolute(assets.langPath)).toBe(true);
    expect(JSON.stringify(assets)).not.toMatch(/https?:\/\//);
  });

  it('recognizes real generated bib images and continues after a corrupt photo', async () => {
    const first = await makeBib('leading-zero.png', '00127');
    const second = await makeBib('another-runner.png', '4827');
    const broken = path.join(directory, 'corrupt.jpg');
    await writeFile(broken, 'this is not a photograph');
    const input = [photo(first, 'first'), photo(broken, 'broken'), photo(second, 'second')];
    const progress: (Progress | null)[] = [];
    const saved: { id: string; numbers: string[]; error?: string }[] = [];

    const result = await recognizeBibs(input, {
      onProgress: (value) => { progress.push(value); },
      onResult: (id, numbers, error) => { saved.push({ id, numbers, error }); },
    });

    expect(result[0]).toEqual({ id: 'first', numbers: ['00127'] });
    expect(result[1].id).toBe('broken');
    expect(result[1].error).toMatch(/unsupported|invalid|corrupt|image|format/i);
    expect(result[2]).toEqual({ id: 'second', numbers: ['4827'] });
    expect(saved).toHaveLength(3);
    expect(progress.filter((value) => value?.current === 3)).toHaveLength(1);
    expect(progress.at(-1)).toBeNull();
    expect(input.every((item) => item.bibNumbers[0] === 'manual-keep' && item.ocrStatus === 'pending')).toBe(true);
    // Native image caches must not keep original photos locked on Windows.
    await rename(first, `${first}.moved`);
    await rename(`${first}.moved`, first);
  }, 90_000);

  it('cancels between photos and leaves unprocessed photos untouched', async () => {
    const first = await makeBib('cancel-first.png', '9362');
    const controller = new AbortController();
    const result = await recognizeBibs([photo(first, 'one'), photo(first, 'two')], {
      signal: controller.signal,
      onResult: () => { controller.abort(); },
    });
    expect(result).toEqual([{ id: 'one', numbers: ['9362'] }]);
  }, 90_000);

  it('terminates a real recognition job while it is running', async () => {
    const filePath = await makeBib('cancel-inflight.png', '27048');
    const controller = new AbortController();
    let sawRunningJob = false;
    let finalProgress: Progress | null | undefined;
    const result = await recognizeBibs([photo(filePath, 'running')], {
      signal: controller.signal,
      onProgress: (value) => {
        finalProgress = value;
        if (value?.message.startsWith('识别中')) {
          sawRunningJob = true;
          controller.abort();
        }
      },
    });
    expect(sawRunningJob).toBe(true);
    expect(result).toEqual([]);
    expect(finalProgress).toBeNull();
  }, 30_000);

  it('returns immediately for an already cancelled or empty batch', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await recognizeBibs([photo('does-not-exist', 'skip')], { signal: controller.signal })).toEqual([]);
    expect(await recognizeBibs([])).toEqual([]);
  });
});
