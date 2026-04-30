'use strict';

const { BrowserWindow, session } = require('electron');
const { EventEmitter } = require('events');

const CLAUDE_SESSION = 'persist:claude-tracker';
const CLAUDE_URL = 'https://claude.ai';

class ApiService extends EventEmitter {
  constructor() {
    super();
    this._session = session.fromPartition(CLAUDE_SESSION);
    this._window = null;
    this._isReady = false;
    this._orgId = null;
    this._sessionActive = false;
  }

  init() {
    this._window = new BrowserWindow({
      show: false,
      width: 1200,
      height: 800,
      webPreferences: {
        session: this._session,
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    this._window.webContents.on('did-finish-load', () => {
      this._isReady = true;
    });

    this._window.webContents.on('did-navigate', () => {
      this._isReady = false;
    });

    this._session.cookies.on('changed', (event, cookie, cause, removed) => {
      if (cookie.name === 'sessionKey' && cookie.domain.includes('claude.ai')) {
        if (!removed && !this._sessionActive) {
          this._sessionActive = true;
          this.emit('session-found');
        } else if (removed && this._sessionActive) {
          this._sessionActive = false;
          this._orgId = null;
          this.emit('session-lost');
        }
      }
    });

    this._window.loadURL(CLAUDE_URL);
  }

  getSession() {
    return this._session;
  }

  async _waitReady(maxWaitMs = 15000) {
    if (this._isReady) return;
    const start = Date.now();
    while (!this._isReady && Date.now() - start < maxWaitMs) {
      await new Promise(r => setTimeout(r, 200));
    }
    if (!this._isReady) throw new Error('WebView not ready');
  }

  async _fetch(endpoint) {
    await this._waitReady();
    const result = await this._window.webContents.executeJavaScript(`
      (async () => {
        try {
          const r = await fetch('${endpoint}', {
            credentials: 'include',
            headers: { 'Accept': 'application/json' }
          });
          if (!r.ok) return { __error: 'HTTP_' + r.status };
          return await r.json();
        } catch (e) {
          return { __error: e.message };
        }
      })()
    `);
    if (result && result.__error) throw new Error(result.__error);
    return result;
  }

  async checkSession() {
    try {
      const cookies = await this._session.cookies.get({ name: 'sessionKey' });
      const hasCookie = cookies.some(c => c.domain.includes('claude.ai') || c.domain.includes('anthropic.com'));
      if (!hasCookie) return false;
      const data = await this._fetch('/api/account');
      return !!data && !data.__error;
    } catch {
      return false;
    }
  }

  async getAccount() {
    return this._fetch('/api/account');
  }

  async _resolveOrgId() {
    if (this._orgId) return this._orgId;
    const orgs = await this._fetch('/api/organizations');
    if (!Array.isArray(orgs) || orgs.length === 0) throw new Error('No organizations');
    this._orgId = orgs[0].uuid;
    return this._orgId;
  }

  async getUsage() {
    const orgId = await this._resolveOrgId();
    return this._fetch(`/api/organizations/${orgId}/usage`);
  }

  async signOut() {
    this._orgId = null;
    this._sessionActive = false;
    this._isReady = false;
    await this._session.clearStorageData();
    await this._session.clearCache();
    this._window.loadURL(CLAUDE_URL);
  }

  clearOrgCache() {
    this._orgId = null;
  }
}

module.exports = ApiService;
