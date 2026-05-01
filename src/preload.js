'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('claude', {
  getState:       ()          => ipcRenderer.invoke('get-state'),
  getSettings:    ()          => ipcRenderer.invoke('get-settings'),
  setSetting:     (k, v)      => ipcRenderer.invoke('set-setting', k, v),
  refresh:        ()          => ipcRenderer.invoke('refresh'),
  quit:           ()          => ipcRenderer.invoke('quit'),
  checkUpdates:   ()          => ipcRenderer.invoke('check-updates'),

  // Notifications test
  testFiveHourNotification: () => ipcRenderer.invoke('test-five-hour-notification'),
  testSevenDayNotification: () => ipcRenderer.invoke('test-seven-day-notification'),
  testPaceNotification:     () => ipcRenderer.invoke('test-pace-notification'),

  // Multi-account
  addAccount:     ()          => ipcRenderer.invoke('add-account'),
  removeAccount:  (id)        => ipcRenderer.invoke('remove-account', id),
  switchAccount:  (id)        => ipcRenderer.invoke('switch-account', id),
  signOutAccount: (id)        => ipcRenderer.invoke('sign-out-account', id),
  signInAccount:  (id)        => ipcRenderer.invoke('sign-in-account', id),

  onStateUpdate:    (cb) => { ipcRenderer.on('state-update',    (_e, s) => cb(s)); },
  onSettingsUpdate: (cb) => { ipcRenderer.on('settings-update', (_e, s) => cb(s)); },
  onShowSettings:   (cb) => { ipcRenderer.on('show-settings',   ()      => cb());  },
});
