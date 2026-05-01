'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('claude', {
  getState:       ()          => ipcRenderer.invoke('get-state'),
  getSettings:    ()          => ipcRenderer.invoke('get-settings'),
  setSetting:     (k, v)      => ipcRenderer.invoke('set-setting', k, v),
  refresh:        ()          => ipcRenderer.invoke('refresh'),
  quit:           ()          => ipcRenderer.invoke('quit'),
  openSettings:   ()          => ipcRenderer.invoke('open-settings'),

  // Multi-account
  addAccount:     ()          => ipcRenderer.invoke('add-account'),
  removeAccount:  (id)        => ipcRenderer.invoke('remove-account', id),
  switchAccount:  (id)        => ipcRenderer.invoke('switch-account', id),
  signOutAccount: (id)        => ipcRenderer.invoke('sign-out-account', id),
  signInAccount:  (id)        => ipcRenderer.invoke('sign-in-account', id),

  onStateUpdate: (cb) => { ipcRenderer.on('state-update', (_e, s) => cb(s)); },
});
