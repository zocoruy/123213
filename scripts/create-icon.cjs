const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');
(async () => {
  const sizes = [16, 32, 48, 64, 128, 256];
  const source = path.resolve(__dirname, '../public/icon.svg');
  const images = await Promise.all(sizes.map((size) => sharp(source).resize(size, size).png().toBuffer()));
  const header = Buffer.alloc(6 + sizes.length * 16);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((size, index) => {
    const entry = 6 + index * 16;
    header[entry] = size === 256 ? 0 : size; header[entry + 1] = header[entry];
    header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(images[index].length, entry + 8); header.writeUInt32LE(offset, entry + 12);
    offset += images[index].length;
  });
  await fs.mkdir(path.resolve(__dirname, '../resources'), { recursive: true });
  await fs.writeFile(path.resolve(__dirname, '../resources/icon.ico'), Buffer.concat([header, ...images]));
})().catch((error) => { console.error(error); process.exitCode = 1; });
