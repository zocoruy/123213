// Explicit opt-in end-to-end import benchmark; does not touch personal photos.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { LibraryService } = require('../dist-electron/electron/library.js');

(async () => {
  const count = Number(process.argv[2] || 2100);
  if (!Number.isInteger(count) || count < 1 || count > 10000) throw new Error('Choose 1–10000 sample photos.');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sprintselect-benchmark-'));
  try {
    const source = path.join(root, 'photos');
    await fs.mkdir(source);
    const samples = ['sports-01.jpg', 'sports-03.jpg', 'football-01.jpg'].map((name) => path.join(__dirname, '../public/demo', name));
    for (let index = 0; index < count; index++) {
      await fs.copyFile(samples[index % samples.length], path.join(source, `${String(index).padStart(5, '0')}.jpg`));
    }
    let last = -1;
    const library = new LibraryService(path.join(root, 'data'), (progress) => {
      if (progress?.stage === 'import' && Math.floor(progress.current / 250) !== last) {
        last = Math.floor(progress.current / 250);
        console.log(`Imported ${progress.current}/${progress.total}`);
      }
    });
    let started = performance.now();
    const imported = await library.importFolder(source);
    const importSeconds = (performance.now() - started) / 1000;
    if (imported.photos.length !== count || imported.errors.length) throw new Error('Incomplete import.');
    await library.updatePhotos([imported.photos[0].id], { decision: 'keep', bibNumbers: ['00127'], athleteTags: ['示例选手'] });
    started = performance.now();
    const resumed = await new LibraryService(path.join(root, 'data')).importFolder(source);
    if (resumed.photos[0].decision !== 'keep') throw new Error('Decisions were lost.');
    const result = {
      samplePhotos: count, uniqueImages: samples.length, maxSourceDimensions: '1280x720',
      importSeconds: Math.round(importSeconds * 100) / 100,
      cachedReimportSeconds: Math.round((performance.now() - started) / 10) / 100,
      peakRssMb: Math.round(process.resourceUsage().maxRSS / 1024),
      errors: imported.errors.length,
      note: 'Repeated small sample images; this does not predict full-resolution camera RAW/JPEG performance.',
    };
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
