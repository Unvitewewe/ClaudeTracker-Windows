'use strict';

const {
  app, BrowserWindow, Tray, Menu, nativeImage,
  ipcMain, screen, shell, Notification
} = require('electron');
const path = require('path');
const https = require('https');
const ApiService = require('./api-service');
const store = require('./store');

// Single instance guard
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// ══════════════════════════════════════════════
// Constants
// ══════════════════════════════════════════════
const POPUP_BASE_W = 390;
const POPUP_BASE_H = 540;
const SETTINGS_W = 420;
const SETTINGS_H = 680;
const HISTORY_MAX = 2016; // 7 days at 5-min intervals
const HISTORY_INTERVAL = 5 * 60 * 1000; // 5 min
const GITHUB_REPO = 'Unvitewewe/ClaudeTracker-Windows';

// ══════════════════════════════════════════════
// Globals
// ══════════════════════════════════════════════
let tray = null;
let popupWindow = null;
let loginWindow = null;
let settingsWindow = null;
let iconWindow = null;
let pollingTimer = null;
let historyTimer = null;

const apiService = new ApiService();

let appState = {
  isAuthenticated: false,
  isLoading: false,
  error: null,
  accountInfo: null,
  usage: null,
  lastUpdated: null,
  history: store.get('usageHistory', []),
};

// ══════════════════════════════════════════════
// App lifecycle
// ══════════════════════════════════════════════
app.whenReady().then(async () => {
  app.setLoginItemSettings({ openAtLogin: store.get('openAtLogin', false) });

  initIconWindow();
  await createTray();
  createPopupWindow();

  apiService.init();
  apiService.on('session-found', onSessionFound);
  apiService.on('session-lost', onSessionLost);

  appState.isLoading = true;
  pushStateUpdate();

  const hasSession = await apiService.checkSession();
  if (hasSession) {
    await onSessionFound();
  } else {
    appState.isLoading = false;
    appState.isAuthenticated = false;
    pushStateUpdate();
  }
});

app.on('second-instance', () => {
  if (popupWindow) {
    if (popupWindow.isMinimized()) popupWindow.restore();
    popupWindow.focus();
  }
});

// Prevent quitting when all windows closed (this is a tray app)
app.on('window-all-closed', e => e.preventDefault());

// ══════════════════════════════════════════════
// Tray icon
// ══════════════════════════════════════════════
async function createTray() {
  const icon = await generateTrayIcon(null, null);
  tray = new Tray(icon);
  tray.setToolTip('Claude Tracker');
  tray.on('click', togglePopup);
  tray.on('right-click', () => {
    const menu = Menu.buildFromTemplate([
      { label: 'Open', click: showPopup },
      { label: 'Settings', click: openSettings },
      { type: 'separator' },
      { label: 'Quit Claude Tracker', click: () => app.exit(0) },
    ]);
    tray.popUpContextMenu(menu);
  });
}

async function updateTrayIcon(usage) {
  if (!tray || tray.isDestroyed()) return;
  try {
    const win = store.get('menuBarWindow', 'five_hour') === 'seven_day'
      ? usage?.seven_day
      : usage?.five_hour;

    const pct = win ? Math.round(win.utilization * 100) : null;
    const color = win ? urgencyColorHex(win.utilization) : '#8e8e93';
    const icon = await generateTrayIcon(pct, color);
    tray.setImage(icon);

    const tooltip = pct != null
      ? `Claude Tracker — ${pct}% (${store.get('menuBarWindow') === 'seven_day' ? '7-day' : '5-hr'})`
      : 'Claude Tracker';
    tray.setToolTip(tooltip);
  } catch (e) {
    console.error('Tray icon update failed', e);
  }
}

function urgencyColorHex(util) {
  const u = Math.min(1.0, Math.max(0, util));
  const hue = Math.round((1 - u) * 120);
  return hslToHex(hue, 70, 50);
}

function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = n => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * c).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

// ══════════════════════════════════════════════
// Icon generation (offscreen canvas)
// ══════════════════════════════════════════════
function initIconWindow() {
  iconWindow = new BrowserWindow({
    show: false,
    width: 32, height: 32,
    frame: false,
    webPreferences: { offscreen: true, nodeIntegration: false, contextIsolation: true },
  });
  iconWindow.loadFile(path.join(__dirname, 'renderer/icon-gen.html'));
}

async function generateTrayIcon(percentage, color) {
  const fallback = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAANklEQVR42mNk' +
    'YGBg+M9AACAAAA//8DAQAFAAHgAGQAAAABJRU5ErkJggg=='
  );

  if (!iconWindow || iconWindow.isDestroyed()) return fallback;

  try {
    await new Promise(r => setTimeout(r, 100)); // ensure page loaded
    const text = percentage != null ? (percentage > 99 ? '!!' : percentage + '%') : 'CT';
    const col = color || '#8e8e93';

    const dataUrl = await iconWindow.webContents.executeJavaScript(`
      (() => {
        const c = document.getElementById('c');
        const ctx = c.getContext('2d');
        ctx.clearRect(0, 0, 32, 32);
        ctx.beginPath();
        ctx.arc(16, 16, 14, 0, Math.PI * 2);
        ctx.strokeStyle = '${col}';
        ctx.lineWidth = 2;
        ctx.stroke();
        const txt = '${text}';
        const fs = txt.length > 3 ? 8 : txt.length > 2 ? 10 : 12;
        ctx.font = 'bold ' + fs + 'px Arial';
        ctx.fillStyle = '${col}';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(txt, 16, 16);
        return c.toDataURL('image/png');
      })()
    `);
    return nativeImage.createFromDataURL(dataUrl);
  } catch (e) {
    return fallback;
  }
}

// ══════════════════════════════════════════════
// Windows
// ══════════════════════════════════════════════
function createPopupWindow() {
  const scale = store.get('popupScale', 1.0);
  popupWindow = new BrowserWindow({
    width: Math.round(POPUP_BASE_W * scale),
    height: Math.round(POPUP_BASE_H * scale),
    show: false,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  popupWindow.loadFile(path.join(__dirname, 'renderer/popup.html'));

  popupWindow.on('blur', () => {
    // Hide when focus is lost (unless settings/login are open)
    if (!settingsWindow || settingsWindow.isDestroyed()) {
      if (!loginWindow || loginWindow.isDestroyed()) {
        popupWindow.hide();
      }
    }
  });
}

function positionPopup() {
  if (!popupWindow || popupWindow.isDestroyed() || !tray) return;
  const trayBounds = tray.getBounds();
  const popBounds = popupWindow.getBounds();
  const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y });
  const work = display.workArea;

  let x = Math.round(trayBounds.x - popBounds.width / 2 + trayBounds.width / 2);
  let y = Math.round(trayBounds.y - popBounds.height - 8);

  // If tray is at the top (macOS-style), flip downward
  if (trayBounds.y < work.y + work.height / 2) {
    y = trayBounds.y + trayBounds.height + 8;
  }

  x = Math.max(work.x + 4, Math.min(x, work.x + work.width - popBounds.width - 4));
  y = Math.max(work.y + 4, Math.min(y, work.y + work.height - popBounds.height - 4));
  popupWindow.setPosition(x, y);
}

function showPopup() {
  if (!popupWindow || popupWindow.isDestroyed()) createPopupWindow();
  positionPopup();
  popupWindow.show();
  popupWindow.focus();
}

function hidePopup() {
  if (popupWindow && !popupWindow.isDestroyed()) popupWindow.hide();
}

function togglePopup() {
  if (popupWindow && popupWindow.isVisible()) hidePopup();
  else showPopup();
}

function openSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: SETTINGS_W,
    height: SETTINGS_H,
    title: 'Claude Tracker Settings',
    resizable: false,
    skipTaskbar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-settings.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  settingsWindow.loadFile(path.join(__dirname, 'renderer/settings.html'));
  settingsWindow.setMenu(null);
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

function openLogin() {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.focus();
    return;
  }
  loginWindow = new BrowserWindow({
    width: 900, height: 700,
    title: 'Sign in to Claude',
    webPreferences: {
      session: apiService.getSession(),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  loginWindow.loadURL('https://claude.ai/login');
  loginWindow.setMenu(null);
  loginWindow.on('closed', () => { loginWindow = null; });
}

// ══════════════════════════════════════════════
// Session handlers
// ══════════════════════════════════════════════
async function onSessionFound() {
  appState.isAuthenticated = true;
  appState.isLoading = true;
  pushStateUpdate();

  if (loginWindow && !loginWindow.isDestroyed()) {
    setTimeout(() => {
      if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close();
    }, 1500);
  }

  await refreshUsage();
  startPolling();
  startHistoryCollection();
}

function onSessionLost() {
  appState.isAuthenticated = false;
  appState.usage = null;
  appState.accountInfo = null;
  appState.error = null;
  stopPolling();
  pushStateUpdate();
  updateTrayIcon(null);
}

// ══════════════════════════════════════════════
// Polling
// ══════════════════════════════════════════════
function startPolling() {
  stopPolling();
  const interval = store.get('refreshInterval', 30) * 1000;
  pollingTimer = setInterval(refreshUsage, interval);
}

function stopPolling() {
  if (pollingTimer) { clearInterval(pollingTimer); pollingTimer = null; }
}

function restartPolling() {
  if (appState.isAuthenticated) startPolling();
}

function startHistoryCollection() {
  if (historyTimer) return;
  historyTimer = setInterval(collectHistoryPoint, HISTORY_INTERVAL);
}

function collectHistoryPoint() {
  if (!appState.usage) return;
  const point = {
    timestamp: Date.now(),
    fiveHour: appState.usage.five_hour?.utilization ?? null,
    sevenDay: appState.usage.seven_day?.utilization ?? null,
  };
  appState.history.push(point);
  if (appState.history.length > HISTORY_MAX) {
    appState.history = appState.history.slice(-HISTORY_MAX);
  }
  store.set('usageHistory', appState.history);
}

// ══════════════════════════════════════════════
// Data refresh
// ══════════════════════════════════════════════
let prevUsage = null;

async function refreshUsage() {
  if (!appState.isAuthenticated) return;
  appState.isLoading = true;
  pushStateUpdate();

  try {
    const [account, usage] = await Promise.all([
      apiService.getAccount(),
      apiService.getUsage(),
    ]);

    if (account.__error || usage.__error) {
      const errMsg = account.__error || usage.__error;
      if (errMsg.includes('401') || errMsg.includes('403')) {
        onSessionLost();
        return;
      }
      appState.error = 'Failed to fetch data';
      appState.isLoading = false;
      pushStateUpdate();
      return;
    }

    // Parse account info
    const membership = account.memberships?.[0];
    const org = membership?.organization;
    const capabilities = org?.capabilities || [];
    const slugs = capabilities.map(c => (c.name || '').toLowerCase());
    let plan = 'Unknown';
    if (slugs.some(s => s.includes('max'))) plan = 'Max';
    else if (slugs.some(s => s.includes('pro'))) plan = 'Pro';
    else if (slugs.some(s => s.includes('enterprise'))) plan = 'Enterprise';
    else if (slugs.some(s => s.includes('team'))) plan = 'Team';

    appState.accountInfo = {
      fullName: account.full_name || null,
      emailAddress: account.email_address || '',
      plan,
    };

    // Detect resets for notifications
    if (prevUsage && usage) {
      checkForReset('five_hour', prevUsage.five_hour, usage.five_hour, '5-Hour Window');
      checkForReset('seven_day', prevUsage.seven_day, usage.seven_day, '7-Day Window');
    }
    prevUsage = usage;

    appState.usage = usage;
    appState.error = null;
    appState.isLoading = false;
    appState.lastUpdated = new Date().toISOString();

    pushStateUpdate();
    await updateTrayIcon(usage);

    // Pace alert check
    checkPaceAlert();

  } catch (e) {
    appState.error = e.message;
    appState.isLoading = false;
    pushStateUpdate();
  }
}

function checkForReset(key, prev, curr, label) {
  if (!prev || !curr) return;
  const wasHigh = prev.utilization > 0.05;
  const nowLow = curr.utilization <= 0.05;
  const resetChanged = prev.resets_at !== curr.resets_at;
  if (wasHigh && nowLow && resetChanged) {
    fireNotification(
      `${label} Reset`,
      `Your ${label.toLowerCase()} usage has reset.`,
      store.get('notifyToastDuration', 5),
      store.get('notifySound', true),
      key === 'five_hour' ? store.get('notifyFiveHourReset', true) : store.get('notifySevenDayReset', true)
    );
  }
}

let lastPaceAlert = 0;

function checkPaceAlert() {
  if (!store.get('paceAlertEnabled', true)) return;
  if (!appState.history || appState.history.length < 2) return;
  const now = Date.now();
  if (now - lastPaceAlert < 5 * 60 * 1000) return; // cooldown 5 min

  const threshold = store.get('paceAlertThreshold', 30) * 60; // seconds
  const win = appState.usage?.five_hour;
  if (!win || win.utilization >= 1.0) return;

  const pace = computePaceNode(appState.history, 'fiveHour');
  if (pace?.timeToFull != null && pace.timeToFull < threshold) {
    lastPaceAlert = now;
    fireNotification(
      'Pace Alert — 5-Hour Window',
      `Limit reached in ~${fmtDurationNode(pace.timeToFull)}`,
      store.get('paceAlertToastDuration', 5),
      store.get('paceAlertSound', true),
      true
    );
  }
}

function computePaceNode(history, key) {
  const maxAgeMs = store.get('paceRateWindow', 300) * 1000;
  const now = Date.now();
  const pts = history
    .filter(p => (now - p.timestamp) < maxAgeMs && p[key] != null)
    .map(p => ({ t: p.timestamp / 1000, v: p[key] }));
  if (pts.length < 2) return null;
  const span = pts[pts.length - 1].t - pts[0].t;
  if (span < 15) return null;
  const lambda = Math.log(2) / ((maxAgeMs / 1000) / 2);
  let sw = 0, swx = 0, swy = 0, swxx = 0, swxy = 0;
  for (const { t, v } of pts) {
    const age = now / 1000 - t;
    const w = Math.exp(-lambda * age);
    sw += w; swx += w * t; swy += w * v; swxx += w * t * t; swxy += w * t * v;
  }
  const denom = sw * swxx - swx * swx;
  if (Math.abs(denom) < 1e-10) return null;
  const slope = (sw * swxy - swx * swy) / denom;
  const cur = pts[pts.length - 1].v;
  const timeToFull = slope > 0 ? ((1 - cur) / slope) : null;
  return { ratePerHour: slope * 3600, timeToFull };
}

function fmtDurationNode(seconds) {
  if (seconds <= 0) return 'now';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// ══════════════════════════════════════════════
// Notifications
// ══════════════════════════════════════════════
function fireNotification(title, body, duration, sound, enabled) {
  if (!enabled) return;
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, silent: !sound });
  n.show();
  if (duration > 0) setTimeout(() => n.close(), duration * 1000);
}

// ══════════════════════════════════════════════
// State broadcasting
// ══════════════════════════════════════════════
function pushStateUpdate() {
  const state = getSerializableState();
  if (popupWindow && !popupWindow.isDestroyed()) {
    popupWindow.webContents.send('state-update', state);
  }
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('state-update', state);
  }
}

function getSerializableState() {
  return {
    isAuthenticated: appState.isAuthenticated,
    isLoading: appState.isLoading,
    error: appState.error,
    accountInfo: appState.accountInfo,
    usage: appState.usage,
    lastUpdated: appState.lastUpdated,
    history: appState.history.slice(-500), // last ~42h of 5-min points
  };
}

// ══════════════════════════════════════════════
// Updates
// ══════════════════════════════════════════════
function checkUpdates() {
  return new Promise(resolve => {
    const url = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
    const req = https.get(url, { headers: { 'User-Agent': 'ClaudeTracker-Windows' } }, res => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => {
        try {
          const rel = JSON.parse(data);
          const latest = rel.tag_name?.replace(/^v/, '');
          const current = app.getVersion();
          const hasUpdate = isNewer(latest, current);
          resolve({ hasUpdate, version: latest, url: rel.html_url });
        } catch {
          resolve({ hasUpdate: false });
        }
      });
    });
    req.on('error', () => resolve({ hasUpdate: false }));
  });
}

function isNewer(a, b) {
  if (!a || !b) return false;
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

// ══════════════════════════════════════════════
// IPC handlers
// ══════════════════════════════════════════════
ipcMain.handle('get-state', () => getSerializableState());

function getAllSettings() {
  return {
    refreshInterval: store.get('refreshInterval', 30),
    menuBarWindow: store.get('menuBarWindow', 'five_hour'),
    popupScale: store.get('popupScale', 1.0),
    showChartsTab: store.get('showChartsTab', true),
    showPaceIndicator: store.get('showPaceIndicator', true),
    paceRateWindow: store.get('paceRateWindow', 300),
    notifyFiveHourReset: store.get('notifyFiveHourReset', true),
    notifySevenDayReset: store.get('notifySevenDayReset', true),
    notifyToastDuration: store.get('notifyToastDuration', 5),
    notifySound: store.get('notifySound', true),
    paceAlertEnabled: store.get('paceAlertEnabled', true),
    paceAlertThreshold: store.get('paceAlertThreshold', 30),
    paceAlertToastDuration: store.get('paceAlertToastDuration', 5),
    paceAlertSound: store.get('paceAlertSound', true),
    openAtLogin: store.get('openAtLogin', false),
  };
}

ipcMain.handle('get-settings', () => getAllSettings());

ipcMain.handle('set-setting', (e, key, value) => {
  store.set(key, value);
  // Side effects
  if (key === 'refreshInterval') restartPolling();
  if (key === 'openAtLogin') app.setLoginItemSettings({ openAtLogin: !!value });
  if (key === 'menuBarWindow') updateTrayIcon(appState.usage);
  if (key === 'popupScale' && popupWindow && !popupWindow.isDestroyed()) {
    const s = Number(value);
    popupWindow.setSize(Math.round(POPUP_BASE_W * s), Math.round(POPUP_BASE_H * s));
    popupWindow.webContents.setZoomFactor(s);
  }
  // Broadcast settings update to settings window
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('settings-update', getAllSettings());
  }
  return store.store;
});

ipcMain.handle('open-login', () => openLogin());
ipcMain.handle('sign-out', async () => {
  await apiService.signOut();
  onSessionLost();
});
ipcMain.handle('open-settings', () => openSettings());
ipcMain.handle('refresh', () => refreshUsage());
ipcMain.handle('quit', () => app.exit(0));

ipcMain.handle('test-reset-notification', () => {
  fireNotification(
    '5-Hour Window Reset',
    'Your 5-hour usage window has reset — test notification.',
    store.get('notifyToastDuration', 5),
    store.get('notifySound', true),
    true
  );
});

ipcMain.handle('test-pace-notification', () => {
  fireNotification(
    'Pace Alert — 5-Hour Window',
    'Limit reached in ~15m — test notification.',
    store.get('paceAlertToastDuration', 5),
    store.get('paceAlertSound', true),
    true
  );
});

ipcMain.handle('check-updates', async () => {
  const result = await checkUpdates();
  if (result.hasUpdate && result.url) {
    shell.openExternal(result.url);
  }
  return result;
});
