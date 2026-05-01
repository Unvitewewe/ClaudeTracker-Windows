'use strict';

const {
  app, BrowserWindow, Tray, Menu, nativeImage,
  ipcMain, screen, shell, Notification, crypto: electronCrypto,
} = require('electron');
const path          = require('path');
const https         = require('https');
const crypto        = require('crypto');
const { exec }      = require('child_process');
const ApiService    = require('./api-service');
const store         = require('./store');

// Required on Windows for toast notifications to appear in the Action Center
app.setAppUserModelId('com.unvitewewe.claude-tracker');

// Single instance guard
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

// ══════════════════════════════════════════════
// Constants
// ══════════════════════════════════════════════
const POPUP_BASE_W  = 390;
const POPUP_BASE_H  = 560;   // slightly taller to fit account bar
const HISTORY_MAX   = 2016;
const HISTORY_INT   = 5 * 60 * 1000;
const LEGACY_PART   = 'persist:claude-tracker'; // original single-account partition
const GITHUB_REPO   = 'Unvitewewe/ClaudeTracker-Windows';

// ══════════════════════════════════════════════
// Multi-account state
// ══════════════════════════════════════════════
let accounts       = [];        // [{ id, sessionPartition, email, name }]
let activeAccountId = null;

const apiServices   = new Map(); // accountId -> ApiService
const accountStates = new Map(); // accountId -> state object
const prevUsages    = new Map(); // accountId -> last usage (for reset detection)
const lastPaceAlerts = new Map();// accountId -> timestamp

// ── Windows
let tray          = null;
let popupWindow   = null;
let loginWindows  = new Map(); // accountId -> BrowserWindow
let iconWindow    = null;
let pollingTimer  = null;
let historyTimer  = null;

// ══════════════════════════════════════════════
// Account helpers
// ══════════════════════════════════════════════
function mkState(accountId) {
  return {
    id: accountId,
    isAuthenticated: false,
    isLoading: false,
    error: null,
    accountInfo: null,
    usage: null,
    lastUpdated: null,
    history: store.get(`history_${accountId}`, []),
  };
}

function getActiveState() {
  return accountStates.get(activeAccountId) || null;
}

function getAccount(id) {
  return accounts.find(a => a.id === id);
}

/** Initialise ApiService for one account and wire events. */
function initAccountService(account) {
  if (apiServices.has(account.id)) return;

  const svc = new ApiService(account.sessionPartition);
  apiServices.set(account.id, svc);

  if (!accountStates.has(account.id)) {
    accountStates.set(account.id, mkState(account.id));
  }

  svc.on('session-found', () => onSessionFound(account.id));
  svc.on('session-lost',  () => onSessionLost(account.id));
  svc.init();
}

/** Migrate legacy single-account setup → account array. */
async function ensureAccounts() {
  accounts = store.get('accounts', []);

  if (accounts.length === 0) {
    // First run or migration from v1.0.0 single-account
    const id = crypto.randomUUID();
    accounts = [{ id, sessionPartition: LEGACY_PART, email: null, name: null }];
    store.set('accounts', accounts);
    store.set('activeAccountId', id);
  }

  activeAccountId = store.get('activeAccountId', accounts[0].id);
  // Guard: activeAccountId must be a known account
  if (!accounts.find(a => a.id === activeAccountId)) {
    activeAccountId = accounts[0].id;
    store.set('activeAccountId', activeAccountId);
  }
}

// ══════════════════════════════════════════════
// App lifecycle
// ══════════════════════════════════════════════
app.whenReady().then(async () => {
  app.setLoginItemSettings({ openAtLogin: store.get('openAtLogin', false) });

  await ensureAccounts();
  initIconWindow();
  await createTray();
  createPopupWindow();

  // Init all accounts
  for (const acc of accounts) initAccountService(acc);

  // Check sessions
  for (const acc of accounts) {
    const svc = apiServices.get(acc.id);
    const st  = accountStates.get(acc.id);
    st.isLoading = true;
    const ok = await svc.checkSession();
    if (ok) await onSessionFound(acc.id);
    else { st.isLoading = false; st.isAuthenticated = false; }
  }

  pushStateUpdate();
  startPolling();
  startHistoryCollection();

  if (store.get('autoInstallUpdates', false)) {
    checkUpdates().then(r => { if (r.hasUpdate && r.url) shell.openExternal(r.url); }).catch(() => {});
  }
});

app.on('second-instance', () => {
  if (popupWindow && !popupWindow.isDestroyed()) popupWindow.focus();
});

app.on('window-all-closed', e => e.preventDefault());

// ══════════════════════════════════════════════
// Tray
// ══════════════════════════════════════════════
async function createTray() {
  const icon = await generateTrayIcon(null, null);
  tray = new Tray(icon);
  tray.setToolTip('Claude Tracker');
  tray.on('click', togglePopup);
  tray.on('right-click', () => {
    tray.popUpContextMenu(Menu.buildFromTemplate([
      { label: 'Open',     click: showPopup },
      { label: 'Settings', click: showSettings },
      { type: 'separator' },
      { label: 'Quit Claude Tracker', click: () => app.exit(0) },
    ]));
  });
}

async function updateTrayIcon() {
  if (!tray || tray.isDestroyed()) return;
  try {
    const st  = getActiveState();
    const win = store.get('menuBarWindow', 'five_hour') === 'seven_day'
      ? st?.usage?.seven_day : st?.usage?.five_hour;
    const pct   = win ? Math.round(win.utilization * 100) : null;
    const color = win ? urgencyColorHex(win.utilization) : '#8e8e93';

    tray.setImage(await generateTrayIcon(pct, color));
    tray.setToolTip(buildTooltip());
  } catch { /* silently ignore icon errors */ }
}

function buildTooltip() {
  const lines = accounts.map(acc => {
    const st = accountStates.get(acc.id);
    if (!st?.isAuthenticated || !st.usage) {
      const label = acc.email ? acc.email.split('@')[0] : 'Account';
      return `${label}: —`;
    }
    const label = acc.email ? acc.email.split('@')[0] : 'Account';
    const fh = st.usage.five_hour  ? Math.round(st.usage.five_hour.utilization  * 100) + '%' : '—';
    const sd = st.usage.seven_day  ? Math.round(st.usage.seven_day.utilization  * 100) + '%' : '—';
    const plan = st.accountInfo?.plan && st.accountInfo.plan !== 'Unknown'
      ? `[${st.accountInfo.plan}] ` : '';
    return `${plan}${label}: ${fh} 5h · ${sd} 7d`;
  });
  return lines.join('\n');
}

// ══════════════════════════════════════════════
// Icon generation
// ══════════════════════════════════════════════
function initIconWindow() {
  iconWindow = new BrowserWindow({
    show: false, width: 32, height: 32, frame: false,
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
    await new Promise(r => setTimeout(r, 100));
    const text  = percentage != null ? (percentage > 99 ? '!!' : percentage + '%') : 'CT';
    const col   = color || '#8e8e93';
    const dataUrl = await iconWindow.webContents.executeJavaScript(`
      (() => {
        const c = document.getElementById('c'), ctx = c.getContext('2d');
        ctx.clearRect(0,0,32,32);
        ctx.beginPath(); ctx.arc(16,16,14,0,Math.PI*2);
        ctx.strokeStyle='${col}'; ctx.lineWidth=2; ctx.stroke();
        const txt='${text}';
        ctx.font='bold '+(txt.length>3?8:txt.length>2?10:12)+'px Arial';
        ctx.fillStyle='${col}'; ctx.textAlign='center'; ctx.textBaseline='middle';
        ctx.fillText(txt,16,16);
        return c.toDataURL('image/png');
      })()`);
    return nativeImage.createFromDataURL(dataUrl);
  } catch { return fallback; }
}

function urgencyColorHex(util) {
  const u = Math.min(1, Math.max(0, util));
  const h = Math.round((1 - u) * 120);
  return hslToHex(h, 70, 50);
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
// Popup window
// ══════════════════════════════════════════════
function createPopupWindow() {
  const scale = store.get('popupScale', 1.0);
  popupWindow = new BrowserWindow({
    width: Math.round(POPUP_BASE_W * scale),
    height: Math.round(POPUP_BASE_H * scale),
    show: false, frame: false, resizable: false,
    skipTaskbar: true, alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false, contextIsolation: true,
    },
  });
  popupWindow.loadFile(path.join(__dirname, 'renderer/popup.html'));
  popupWindow.on('blur', () => {
    // Small delay needed on Windows with alwaysOnTop — without it the window
    // can immediately regain focus and the hide never fires.
    setTimeout(() => {
      if (!popupWindow || popupWindow.isDestroyed()) return;
      if (!Array.from(loginWindows.values()).some(w => w && !w.isDestroyed())) {
        popupWindow.hide();
      }
    }, 150);
  });
}

function positionPopup() {
  if (!popupWindow || popupWindow.isDestroyed() || !tray) return;
  const tb   = tray.getBounds();
  const pb   = popupWindow.getBounds();
  const work = screen.getDisplayNearestPoint({ x: tb.x, y: tb.y }).workArea;
  let x = Math.round(tb.x - pb.width / 2 + tb.width / 2);
  let y = tb.y < work.y + work.height / 2
    ? tb.y + tb.height + 8
    : tb.y - pb.height - 8;
  x = Math.max(work.x + 4, Math.min(x, work.x + work.width  - pb.width  - 4));
  y = Math.max(work.y + 4, Math.min(y, work.y + work.height - pb.height - 4));
  popupWindow.setPosition(x, y);
}

function showPopup()   { if (!popupWindow || popupWindow.isDestroyed()) createPopupWindow(); positionPopup(); popupWindow.show(); popupWindow.focus(); }
function hidePopup()   { if (popupWindow && !popupWindow.isDestroyed()) popupWindow.hide(); }
function togglePopup() { popupWindow && popupWindow.isVisible() ? hidePopup() : showPopup(); }

function showSettings() {
  showPopup();
  if (popupWindow && !popupWindow.isDestroyed()) {
    popupWindow.webContents.send('show-settings');
  }
}

function openLoginForAccount(accountId) {
  const existing = loginWindows.get(accountId);
  if (existing && !existing.isDestroyed()) { existing.focus(); return; }

  const svc = apiServices.get(accountId);
  if (!svc) return;

  const win = new BrowserWindow({
    width: 900, height: 700,
    title: 'Sign in to Claude',
    webPreferences: { session: svc.getSession(), nodeIntegration: false, contextIsolation: true },
  });
  win.loadURL('https://claude.ai/login');
  win.setMenu(null);
  loginWindows.set(accountId, win);
  win.on('closed', () => loginWindows.delete(accountId));
}

// ══════════════════════════════════════════════
// Session handlers
// ══════════════════════════════════════════════
async function onSessionFound(accountId) {
  const st = accountStates.get(accountId);
  if (!st) return;
  st.isAuthenticated = true;
  st.isLoading = true;
  pushStateUpdate();

  // Close login window if open
  const lw = loginWindows.get(accountId);
  if (lw && !lw.isDestroyed()) setTimeout(() => { if (!lw.isDestroyed()) lw.close(); }, 1500);

  await refreshAccount(accountId);
}

function onSessionLost(accountId) {
  const st = accountStates.get(accountId);
  if (!st) return;
  st.isAuthenticated = false;
  st.usage = null;
  st.accountInfo = null;
  st.error = null;

  // Clear stored email/name
  const acc = getAccount(accountId);
  if (acc) { acc.email = null; acc.name = null; store.set('accounts', accounts); }

  pushStateUpdate();
  if (accountId === activeAccountId) updateTrayIcon();
}

// ══════════════════════════════════════════════
// Polling
// ══════════════════════════════════════════════
function startPolling() {
  stopPolling();
  const interval = store.get('refreshInterval', 30) * 1000;
  pollingTimer = setInterval(refreshAllAccounts, interval);
}
function stopPolling()    { if (pollingTimer) { clearInterval(pollingTimer); pollingTimer = null; } }
function restartPolling() { startPolling(); }

function startHistoryCollection() {
  if (historyTimer) return;
  historyTimer = setInterval(() => {
    for (const acc of accounts) {
      const st = accountStates.get(acc.id);
      if (!st?.usage) continue;
      const point = {
        timestamp: Date.now(),
        fiveHour: st.usage.five_hour?.utilization ?? null,
        sevenDay: st.usage.seven_day?.utilization ?? null,
      };
      st.history.push(point);
      if (st.history.length > HISTORY_MAX) st.history = st.history.slice(-HISTORY_MAX);
      store.set(`history_${acc.id}`, st.history);
    }
  }, HISTORY_INT);
}

async function refreshAllAccounts() {
  for (const acc of accounts) {
    const st = accountStates.get(acc.id);
    if (st?.isAuthenticated) await refreshAccount(acc.id);
  }
}

// ══════════════════════════════════════════════
// Data refresh
// ══════════════════════════════════════════════
async function refreshAccount(accountId) {
  const svc = apiServices.get(accountId);
  const st  = accountStates.get(accountId);
  const acc = getAccount(accountId);
  if (!svc || !st || !acc) return;

  st.isLoading = true;
  pushStateUpdate();

  try {
    const [account, usage, orgs] = await Promise.all([svc.getAccount(), svc.getUsage(), svc.getOrganizations()]);

    // Parse plan — check account memberships AND org capabilities AND direct org plan fields
    const membershipCaps = account.memberships?.[0]?.organization?.capabilities || [];
    const orgCaps        = Array.isArray(orgs) ? (orgs[0]?.capabilities || []) : [];
    const allCaps        = [...membershipCaps, ...orgCaps];
    const capSlugs       = allCaps.map(c => (c.name || c.type || '').toLowerCase());
    const orgPlanSlug    = (orgs?.[0]?.plan_type || orgs?.[0]?.plan || '').toLowerCase();
    const slugs          = [...capSlugs, orgPlanSlug];
    let plan = 'Unknown';
    if      (slugs.some(s => s.includes('max')))        plan = 'Max';
    else if (slugs.some(s => s.includes('pro')))        plan = 'Pro';
    else if (slugs.some(s => s.includes('enterprise'))) plan = 'Enterprise';
    else if (slugs.some(s => s.includes('team')))       plan = 'Team';

    st.accountInfo = { fullName: account.full_name || null, emailAddress: account.email_address || '', plan };

    // Persist email/name on account record for switcher
    if (acc.email !== account.email_address || acc.name !== account.full_name) {
      acc.email = account.email_address || null;
      acc.name  = account.full_name     || null;
      store.set('accounts', accounts);
    }

    // Reset detection (compare on normalized 0–1 scale)
    const normUsage = normalizeUsage(usage);
    const prev = prevUsages.get(accountId);
    if (prev) {
      checkForReset(accountId, 'five_hour', prev.five_hour,  normUsage.five_hour,  '5-Hour Window');
      checkForReset(accountId, 'seven_day', prev.seven_day,  normUsage.seven_day,  '7-Day Window');
    }
    prevUsages.set(accountId, normUsage);

    st.usage       = normUsage;
    st.error       = null;
    st.isLoading   = false;
    st.lastUpdated = new Date().toISOString();

    pushStateUpdate();
    if (accountId === activeAccountId) await updateTrayIcon();
    checkPaceAlert(accountId);

  } catch (e) {
    if (e.message?.includes('401') || e.message?.includes('403')) {
      onSessionLost(accountId);
      return;
    }
    st.error     = e.message;
    st.isLoading = false;
    pushStateUpdate();
  }
}

// ══════════════════════════════════════════════
// Notifications
// ══════════════════════════════════════════════
function checkForReset(accountId, key, prev, curr, label) {
  if (!prev || !curr) return;
  const isFiveHour   = key === 'five_hour';
  const enabledKey   = isFiveHour ? 'notifyFiveHourReset'    : 'notifySevenDayReset';
  const soundKey     = isFiveHour ? 'notifyFiveHourSound'    : 'notifySevenDaySound';
  const durationKey  = isFiveHour ? 'notifyFiveHourDuration' : 'notifySevenDayDuration';
  if (!store.get(enabledKey, true)) return;
  if (prev.utilization > 0.05 && curr.utilization <= 0.05 && prev.resets_at !== curr.resets_at) {
    fireNotification(`${label} Reset${accountTag(accountId)}`, `Your ${label.toLowerCase()} has reset.`,
      store.get(durationKey, 5), store.get(soundKey, true));
  }
}

function checkPaceAlert(accountId) {
  if (!store.get('paceAlertEnabled', true)) return;
  const st = accountStates.get(accountId);
  if (!st?.history?.length || !st.usage?.five_hour) return;
  const now = Date.now();
  if (now - (lastPaceAlerts.get(accountId) || 0) < 5 * 60 * 1000) return;

  const pace = computePaceNode(st.history, 'fiveHour');
  const threshold = store.get('paceAlertThreshold', 30) * 60;
  if (pace?.timeToFull != null && pace.timeToFull < threshold && st.usage.five_hour.utilization < 1) {
    lastPaceAlerts.set(accountId, now);
    fireNotification(`Pace Alert${accountTag(accountId)}`, `Limit in ~${fmtDur(pace.timeToFull)}`,
      store.get('paceAlertToastDuration', 5), store.get('paceAlertSound', true));
  }
}

// Returns " (username)" when there are multiple accounts, empty string otherwise
function accountTag(accountId) {
  if (accounts.length <= 1) return '';
  const acc = getAccount(accountId);
  return acc?.email ? ` (${acc.email.split('@')[0]})` : '';
}

function fireNotification(title, body, duration, sound) {
  if (!Notification.isSupported()) return;
  try {
    const n = new Notification({ title, body, silent: true, timeoutType: duration === 0 ? 'never' : 'default' });
    n.show();
    if (sound) playSound();
    if (duration > 0) setTimeout(() => { try { n.close(); } catch {} }, duration * 1000);
  } catch(e) {
    console.error('[notify] error:', e.message);
  }
}

function playSound() {
  // Play Windows system notification sound via PowerShell (reliable cross-version)
  exec('powershell -NoProfile -Command "[System.Media.SystemSounds]::Asterisk.Play()"');
}

function computePaceNode(history, key) {
  const maxAgeMs = store.get('paceRateWindow', 300) * 1000;
  const now = Date.now();
  const pts = history.filter(p => (now - p.timestamp) < maxAgeMs && p[key] != null)
                     .map(p => ({ t: p.timestamp / 1000, v: p[key] }));
  if (pts.length < 2 || pts[pts.length-1].t - pts[0].t < 15) return null;
  const lambda = Math.log(2) / ((maxAgeMs / 1000) / 2);
  let sw=0, swx=0, swy=0, swxx=0, swxy=0;
  for (const {t,v} of pts) {
    const w = Math.exp(-lambda * (now/1000 - t));
    sw+=w; swx+=w*t; swy+=w*v; swxx+=w*t*t; swxy+=w*t*v;
  }
  const d = sw*swxx - swx*swx;
  if (Math.abs(d) < 1e-10) return null;
  const slope = (sw*swxy - swx*swy) / d;
  const cur = pts[pts.length-1].v;
  return { ratePerHour: slope*3600, timeToFull: slope > 0 ? (1-cur)/slope : null };
}

function fmtDur(s) {
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function normalizeUsage(raw) {
  if (!raw) return raw;
  // API returns utilization as 0–100; UI expects 0–1 fraction
  const normW = w => (!w || w.utilization == null) ? w
    : { ...w, utilization: w.utilization > 1 ? w.utilization / 100 : w.utilization };
  const normE = e => (!e || e.utilization == null) ? e
    : { ...e, utilization: e.utilization > 1 ? e.utilization / 100 : e.utilization };
  return { ...raw, five_hour: normW(raw.five_hour), seven_day: normW(raw.seven_day), extra_usage: normE(raw.extra_usage) };
}

// ══════════════════════════════════════════════
// State serialization
// ══════════════════════════════════════════════
function getSerializableState() {
  const active = getActiveState();

  // Summary for each account (for the switcher bar)
  const accountSummaries = accounts.map(acc => {
    const st = accountStates.get(acc.id);
    return {
      id:              acc.id,
      email:           acc.email || null,
      name:            acc.name  || null,
      isAuthenticated: st?.isAuthenticated || false,
      plan:            st?.accountInfo?.plan || null,
      fiveHourPct:     st?.usage?.five_hour  ? Math.round(st.usage.five_hour.utilization  * 100) : null,
      sevenDayPct:     st?.usage?.seven_day  ? Math.round(st.usage.seven_day.utilization  * 100) : null,
    };
  });

  return {
    // Multi-account
    accounts:        accountSummaries,
    activeAccountId,

    // Active account full detail (same shape as before for backward compat)
    isAuthenticated: active?.isAuthenticated || false,
    isLoading:       active?.isLoading       || false,
    error:           active?.error           || null,
    accountInfo:     active?.accountInfo     || null,
    usage:           active?.usage           || null,
    lastUpdated:     active?.lastUpdated     || null,
    history:         active?.history || [],
  };
}

function pushStateUpdate() {
  const state = getSerializableState();
  if (popupWindow && !popupWindow.isDestroyed()) popupWindow.webContents.send('state-update', state);
}

// ══════════════════════════════════════════════
// Updates
// ══════════════════════════════════════════════
function checkUpdates() {
  return new Promise(resolve => {
    const req = https.get(
      `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
      { headers: { 'User-Agent': 'ClaudeTracker-Windows' } },
      res => {
        let data = '';
        res.on('data', d => { data += d; });
        res.on('end', () => {
          try {
            const rel = JSON.parse(data);
            const latest  = rel.tag_name?.replace(/^v/, '');
            const hasUpdate = isNewer(latest, app.getVersion());
            resolve({ hasUpdate, version: latest, url: rel.html_url });
          } catch { resolve({ hasUpdate: false }); }
        });
      });
    req.on('error', () => resolve({ hasUpdate: false }));
  });
}

function isNewer(a, b) {
  if (!a || !b) return false;
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i]||0) > (pb[i]||0)) return true;
    if ((pa[i]||0) < (pb[i]||0)) return false;
  }
  return false;
}

function getAllSettings() {
  return {
    refreshInterval: store.get('refreshInterval', 30),
    menuBarWindow:   store.get('menuBarWindow',   'five_hour'),
    popupScale:      store.get('popupScale',      1.0),
    showChartsTab:   store.get('showChartsTab',   true),
    showPaceIndicator:      store.get('showPaceIndicator',      true),
    paceRateWindow:         store.get('paceRateWindow',         300),
    notifyFiveHourReset:    store.get('notifyFiveHourReset',    true),
    notifyFiveHourSound:    store.get('notifyFiveHourSound',    true),
    notifyFiveHourDuration: store.get('notifyFiveHourDuration', 5),
    notifySevenDayReset:    store.get('notifySevenDayReset',    true),
    notifySevenDaySound:    store.get('notifySevenDaySound',    true),
    notifySevenDayDuration: store.get('notifySevenDayDuration', 5),
    paceAlertEnabled:       store.get('paceAlertEnabled',       true),
    paceAlertThreshold:     store.get('paceAlertThreshold',     30),
    paceAlertToastDuration: store.get('paceAlertToastDuration', 5),
    paceAlertSound:         store.get('paceAlertSound',         true),
    openAtLogin:            store.get('openAtLogin',            false),
    autoInstallUpdates:     store.get('autoInstallUpdates',     false),
    language:               store.get('language',               'en'),
  };
}

// ══════════════════════════════════════════════
// IPC
// ══════════════════════════════════════════════
ipcMain.handle('get-state',    () => getSerializableState());
ipcMain.handle('get-settings', () => getAllSettings());

ipcMain.handle('set-setting', (e, key, value) => {
  store.set(key, value);
  if (key === 'refreshInterval') restartPolling();
  if (key === 'openAtLogin') app.setLoginItemSettings({ openAtLogin: !!value });
  if (key === 'menuBarWindow') updateTrayIcon();
  if (key === 'popupScale' && popupWindow && !popupWindow.isDestroyed()) {
    const s = Number(value);
    popupWindow.setSize(Math.round(POPUP_BASE_W * s), Math.round(POPUP_BASE_H * s));
    popupWindow.webContents.setZoomFactor(s);
  }
  if (popupWindow && !popupWindow.isDestroyed()) {
    popupWindow.webContents.send('settings-update', getAllSettings());
  }
});

// ── Account IPC ────────────────────────────────
ipcMain.handle('add-account', async () => {
  const id  = crypto.randomUUID();
  const acc = { id, sessionPartition: `persist:claude-tracker-${id}`, email: null, name: null };
  accounts.push(acc);
  store.set('accounts', accounts);
  accountStates.set(id, mkState(id));
  initAccountService(acc);
  openLoginForAccount(id);
  pushStateUpdate();
});

ipcMain.handle('remove-account', async (e, accountId) => {
  if (accounts.length <= 1) return; // keep at least one

  const svc = apiServices.get(accountId);
  if (svc) { try { await svc.signOut(); } catch {} svc.destroy(); apiServices.delete(accountId); }
  accountStates.delete(accountId);
  prevUsages.delete(accountId);
  store.delete(`history_${accountId}`);

  accounts = accounts.filter(a => a.id !== accountId);
  store.set('accounts', accounts);

  if (activeAccountId === accountId) {
    activeAccountId = accounts[0].id;
    store.set('activeAccountId', activeAccountId);
  }
  pushStateUpdate();
  updateTrayIcon();
});

ipcMain.handle('switch-account', (e, accountId) => {
  if (!accounts.find(a => a.id === accountId)) return;
  activeAccountId = accountId;
  store.set('activeAccountId', activeAccountId);
  pushStateUpdate();
  updateTrayIcon();
});

ipcMain.handle('sign-out-account', async (e, accountId) => {
  const svc = apiServices.get(accountId);
  if (svc) await svc.signOut();
  onSessionLost(accountId);
});

ipcMain.handle('sign-in-account', (e, accountId) => {
  openLoginForAccount(accountId);
});

ipcMain.handle('open-settings', () => showSettings());
ipcMain.handle('refresh',       () => refreshAllAccounts());
ipcMain.handle('quit',          () => app.exit(0));

ipcMain.handle('test-five-hour-notification', () =>
  fireNotification(`5-Hour Window Reset${accountTag(activeAccountId)}`, 'Your 5-hour window has reset — test.',
    store.get('notifyFiveHourDuration', 5), store.get('notifyFiveHourSound', true)));

ipcMain.handle('test-seven-day-notification', () =>
  fireNotification(`7-Day Window Reset${accountTag(activeAccountId)}`, 'Your 7-day window has reset — test.',
    store.get('notifySevenDayDuration', 5), store.get('notifySevenDaySound', true)));

ipcMain.handle('test-pace-notification', () =>
  fireNotification(`Pace Alert${accountTag(activeAccountId)}`, 'Limit in ~15m — test.',
    store.get('paceAlertToastDuration', 5), store.get('paceAlertSound', true)));

ipcMain.handle('check-updates', async () => {
  const r = await checkUpdates();
  if (r.hasUpdate && r.url) shell.openExternal(r.url);
  return r;
});
