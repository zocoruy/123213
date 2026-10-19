import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { applyAnalysis, applyAnalysisAsync, differenceHash, hammingDistance, sharpnessScore } from './analysis';
import type { Photo } from '../shared/types';

function checkerboard(size = 256): Buffer {
  const pixels = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const value = ((Math.floor(x / 8) + Math.floor(y / 8)) % 2) * 255;
    pixels.fill(value, (y * size + x) * 3, (y * size + x) * 3 + 3);
  }
  return pixels;
}

const photo = (id: string, hash: string, sharpness: number) => ({ id, perceptualHash: hash, sharpness, decision: 'keep' } as Photo);

describe('image analysis', () => {
  it('measures blur using actual image pixels and finds exact duplicate hashes', async () => {
    const image = await sharp(checkerboard(), { raw: { width: 256, height: 256, channels: 3 } }).png().toBuffer();
    const blurred = await sharp(image).blur(8).png().toBuffer();
    expect(await sharpnessScore(image)).toBeGreaterThan((await sharpnessScore(blurred)) * 10);
    expect(await differenceHash(image)).toMatch(/^[a-f0-9]{16}$/);
    expect(await differenceHash(image)).toBe(await differenceHash(image));
    expect(hammingDistance('0000000000000000', '000000000000000f')).toBe(4);
  });

  it('uses a sharp representative and avoids transitive similarity chains', () => {
    const photos = [photo('a', '0000000000000000', 200), photo('b', '0000000000000001', 100), photo('c', '0000000000000003', 50)];
    applyAnalysis(photos, { blurThreshold: 65, similarityDistance: 1 });
    expect(photos[0].similarGroupId).toBe(photos[1].similarGroupId);
    expect(photos[2].similarGroupId).toBeNull();
    expect(photos[2].isBlurry).toBe(true);
    expect(photos.every(item => item.decision === 'keep')).toBe(true);
    applyAnalysis(photos, { blurThreshold: 0, similarityDistance: 0 });
    expect(photos.every(item => !item.isBlurry && item.similarGroupId === null)).toBe(true);
  });

  it('rejects invalid or excessively expensive analysis thresholds', () => {
    expect(() => applyAnalysis([], { blurThreshold: Number.NaN, similarityDistance: 2 })).toThrow();
    expect(() => applyAnalysis([], { blurThreshold: 65, similarityDistance: 64 })).toThrow();
  });

  it('groups 2000 photos with bounded representatives and yields to the desktop event loop', async () => {
    const photos = Array.from({ length: 2000 }, (_, index) => photo(
      String(index), createHash('sha256').update(String(Math.floor(index / 4))).digest('hex').slice(0, 16), 1000 - index / 4,
    ));
    let eventLoopResponsive = false;
    setImmediate(() => { eventLoopResponsive = true; });
    const started = performance.now();
    await applyAnalysisAsync(photos, { blurThreshold: 65, similarityDistance: 8 });
    const elapsed = performance.now() - started;
    const groups = new Map<string, number>();
    for (const item of photos) if (item.similarGroupId) groups.set(item.similarGroupId, (groups.get(item.similarGroupId) ?? 0) + 1);
    expect(groups.size).toBe(500);
    expect([...groups.values()].every(size => size === 4)).toBe(true);
    expect(eventLoopResponsive).toBe(true);
    console.info(`2000-photo metadata grouping: ${Math.round(elapsed)} ms; ${groups.size} groups; event loop responsive`);
  });
});
