import sharp from 'sharp';
import type { AnalysisSettings, Photo } from '../shared/types';

/** A 64-bit horizontal difference hash, stored as hex to keep JSON portable. */
export async function differenceHash(input: Buffer | string): Promise<string> {
  const pixels = await sharp(input).greyscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer();
  let bits = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      bits = (bits << 1n) | (pixels[y * 9 + x] > pixels[y * 9 + x + 1] ? 1n : 0n);
    }
  }
  return bits.toString(16).padStart(16, '0');
}

/** Variance of a Laplacian at a fixed analysis size; a useful, approximate blur signal. */
export async function sharpnessScore(input: Buffer | string): Promise<number> {
  const { data, info } = await sharp(input).greyscale()
    .resize({ width: 256, height: 256, fit: 'inside', withoutEnlargement: true })
    .raw().toBuffer({ resolveWithObject: true });
  let total = 0;
  let totalSquared = 0;
  let count = 0;
  for (let y = 1; y < info.height - 1; y++) {
    for (let x = 1; x < info.width - 1; x++) {
      const i = y * info.width + x;
      const value = data[i - 1] + data[i + 1] + data[i - info.width] + data[i + info.width] - 4 * data[i];
      total += value;
      totalSquared += value * value;
      count++;
    }
  }
  return count ? Math.round(Math.max(0, totalSquared / count - (total / count) ** 2) * 100) / 100 : 0;
}

export function hammingDistance(a: string, b: string): number {
  if (!/^[0-9a-f]{16}$/i.test(a) || !/^[0-9a-f]{16}$/i.test(b)) return 65;
  const countBits = (input: number) => {
    let value = input - ((input >>> 1) & 0x55555555);
    value = (value & 0x33333333) + ((value >>> 2) & 0x33333333);
    return (((value + (value >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
  };
  return countBits(parseInt(a.slice(0, 8), 16) ^ parseInt(b.slice(0, 8), 16)) +
    countBits(parseInt(a.slice(8), 16) ^ parseInt(b.slice(8), 16));
}

interface HashNode { hash: string; representative: number; children: Map<number, HashNode> }

/** Only group around representatives: A≈B and B≈C cannot pull unrelated A/C together. */
export function applyAnalysis(photos: Photo[], settings: AnalysisSettings): void {
  for (const _ of analysisSteps(photos, settings)) { /* synchronous helper for tests and small batches */ }
}

export async function applyAnalysisAsync(photos: Photo[], settings: AnalysisSettings): Promise<void> {
  let completed = 0;
  for (const _ of analysisSteps(photos, settings)) {
    if (++completed % 64 === 0) await new Promise<void>(resolve => setImmediate(resolve));
  }
}

function* analysisSteps(photos: Photo[], settings: AnalysisSettings): Generator<void> {
  if (!Number.isFinite(settings.blurThreshold) || settings.blurThreshold < 0 || settings.blurThreshold > 1_000_000) {
    throw new Error('模糊阈值必须是 0 至 1000000 的有限数值。');
  }
  if (!Number.isInteger(settings.similarityDistance) || settings.similarityDistance < 0 || settings.similarityDistance > 20) {
    throw new Error('相似度距离必须是 0 至 20 的整数。');
  }
  let root: HashNode | undefined;
  const members = new Map<number, number[]>();
  const order = photos.map((photo, index) => ({ photo, index }))
    .sort((a, b) => b.photo.sharpness - a.photo.sharpness || a.photo.id.localeCompare(b.photo.id));
  for (const { photo, index } of order) {
    yield;
    photo.isBlurry = photo.sharpness < settings.blurThreshold;
    photo.similarGroupId = null;
    if (!/^[0-9a-f]{16}$/i.test(photo.perceptualHash)) continue;
    if (!root) {
      root = { hash: photo.perceptualHash, representative: index, children: new Map() };
      members.set(index, [index]);
      continue;
    }
    const stack = [root];
    let best: { index: number; distance: number } | undefined;
    while (stack.length) {
      const node = stack.pop()!;
      const distance = hammingDistance(photo.perceptualHash, node.hash);
      if (distance <= settings.similarityDistance && (!best || distance < best.distance)) {
        best = { index: node.representative, distance };
      }
      for (const [edge, child] of node.children) {
        if (edge >= distance - settings.similarityDistance && edge <= distance + settings.similarityDistance) stack.push(child);
      }
    }
    if (best) members.get(best.index)!.push(index);
    else {
      let node = root;
      for (;;) {
        const distance = hammingDistance(photo.perceptualHash, node.hash);
        const child = node.children.get(distance);
        if (child) node = child;
        else { node.children.set(distance, { hash: photo.perceptualHash, representative: index, children: new Map() }); break; }
      }
      members.set(index, [index]);
    }
  }
  for (const [representative, group] of members) {
    if (group.length < 2) continue;
    const groupId = `similar-${photos[representative].id}`;
    for (const index of group) photos[index].similarGroupId = groupId;
  }
}
