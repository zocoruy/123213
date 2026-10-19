const fs = require('node:fs');
const path = require('node:path');
const destination = path.join(__dirname, '../dist-electron/electron');
fs.mkdirSync(destination, { recursive: true });
fs.copyFileSync(path.join(__dirname, '../electron/preload.cjs'), path.join(destination, 'preload.cjs'));
