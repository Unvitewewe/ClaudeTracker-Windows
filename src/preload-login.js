'use strict';

const { ipcRenderer } = require('electron');

// No contextBridge needed — this is a regular web page (claude.ai)
// We just listen for the session-found signal from main
ipcRenderer.on('login-close', () => {
  window.close();
});
