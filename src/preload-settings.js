'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('claude', {
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSetting: (key, value) => ipcRenderer.invoke('set-setting', key, value),
  getState: () => ipcRenderer.invoke('get-state'),
  signOut: () => ipcRenderer.invoke('sign-out'),
  testResetNotification: () => ipcRenderer.invoke('test-reset-notification'),
  testPaceNotification: () => ipcRenderer.invoke('test-pace-notification'),
  checkUpdates: () => ipcRenderer.invoke('check-updates'),
  onSettingsUpdate: (cb) => {
    ipcRenderer.on('settings-update', (_e, s) => cb(s));
  },
  onStateUpdate: (cb) => {
    ipcRenderer.on('state-update', (_e, s) => cb(s));
  },
});
