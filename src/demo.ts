import type { Album, Photo } from '../shared/types';

const examples = [
  { image: 'sports-03.jpg', width: 640, height: 429, bib: '13', tag: '蓝队 · 示例' },
  { image: 'sports-01.jpg', width: 640, height: 425, bib: '08', tag: '雪场 · 示例' },
  { image: 'football-01.jpg', width: 1280, height: 720, bib: '10', tag: '球场 · 示例' },
];

export function createDemoAlbum(): Album {
  const photos: Photo[] = Array.from({ length: 24 }, (_, index) => {
    const example = examples[Math.floor(index / 4) % examples.length];
    const url = `${import.meta.env.BASE_URL}demo/${example.image}`;
    return {
      id: `demo-${String(index + 1).padStart(3, '0')}`,
      path: `示例照片/DSC_${1041 + index}.jpg`, fileName: `DSC_${1041 + index}.jpg`,
      relativePath: `DSC_${1041 + index}.jpg`, bytes: 4_259_200 + index * 109_200,
      width: example.width, height: example.height,
      capturedAt: new Date(Date.UTC(2026, 9, 18, 0, 30 + Math.floor(index / 6) * 15, index % 6)).toISOString(),
      timeSource: 'exif', thumbnailUrl: url, previewUrl: url,
      decision: index === 2 || index === 7 || index === 15 ? 'reject' : index % 5 === 0 ? 'keep' : 'unreviewed',
      rating: index % 5 === 0 ? 4 : 0,
      bibNumbers: index % 4 !== 3 ? [example.bib] : [],
      athleteTags: index % 4 !== 3 ? [example.tag] : [],
      perceptualHash: BigInt(index % 3).toString(16).padStart(16, '0'),
      sharpness: index % 7 === 2 ? 28 : 190 + index * 9,
      isBlurry: index % 7 === 2,
      similarGroupId: index < 16 ? `demo-group-${Math.floor(index / 4) + 1}` : null,
      ocrStatus: 'pending',
    };
  });
  return {
    id: 'demo-sports', name: '周末赛场 · 示例相册', sourceDir: 'demo://sports',
    importedAt: '2026-10-18T00:30:00.000Z', photos, errors: [],
  };
}
