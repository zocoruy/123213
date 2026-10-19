const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('albumApi', {
  getAlbum: () => ipcRenderer.invoke('album:get'),
  importFolder: () => ipcRenderer.invoke('album:import'),
  updatePhotos: (ids, patch) => ipcRenderer.invoke('album:update', ids, patch),
  analyze: (settings) => ipcRenderer.invoke('album:analyze', settings),
  recognizeBibs: (ids) => ipcRenderer.invoke('album:ocr', ids),
  cancelOperation: () => ipcRenderer.invoke('album:cancel'),
  exportPhotos: (options) => ipcRenderer.invoke('album:export', options),
  showInFolder: (id) => ipcRenderer.invoke('album:show', id),
  onProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('album:progress', listener);
    return () => ipcRenderer.removeListener('album:progress', listener);
  },
  platform: process.platform,
});
