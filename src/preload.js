'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('claude', {
  getState: () => ipcRenderer.invoke('get-state'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSetting: (key, value) => ipcRenderer.invoke('set-setting', key, value),
  signIn: () => ipcRenderer.invoke('open-login'),
  signOut: () => ipcRenderer.invoke('sign-out'),
  openSettings: () => ipcRenderer.invoke('open-settings'),
  refresh: () => ipcRenderer.invoke('refresh'),
  quit: () => ipcRenderer.invoke('quit'),
  onStateUpdate: (cb) => {
    ipcRenderer.on('state-update', (_e, state) => cb(state));
  },
});
