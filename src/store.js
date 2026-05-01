'use strict';

const Store = require('electron-store');

const schema = {
  // ── Multi-account ──────────────────────────────────────────────
  accounts: {
    type: 'array',
    default: [],
    items: {
      type: 'object',
      properties: {
        id:               { type: 'string' },
        sessionPartition: { type: 'string' },
        email:            { type: ['string', 'null'] },
        name:             { type: ['string', 'null'] },
      },
    },
  },
  activeAccountId: { type: ['string', 'null'], default: null },

  // ── Global settings ────────────────────────────────────────────
  refreshInterval:        { type: 'number', minimum: 1,  maximum: 60,   default: 30 },
  menuBarWindow:          { type: 'string', enum: ['five_hour', 'seven_day'], default: 'five_hour' },
  popupScale:             { type: 'number', minimum: 0.75, maximum: 1.5, default: 1.0 },
  showChartsTab:          { type: 'boolean', default: true },
  showPaceIndicator:      { type: 'boolean', default: true },
  paceRateWindow:         { type: 'number', minimum: 30, maximum: 1800, default: 300 },

  notifyFiveHourReset:    { type: 'boolean', default: true },
  notifySevenDayReset:    { type: 'boolean', default: true },
  notifyToastDuration:    { type: 'number', minimum: 0,  maximum: 30,   default: 5 },
  notifySound:            { type: 'boolean', default: true },

  paceAlertEnabled:       { type: 'boolean', default: true },
  paceAlertThreshold:     { type: 'number', minimum: 5,  maximum: 60,   default: 30 },
  paceAlertToastDuration: { type: 'number', minimum: 0,  maximum: 30,   default: 5 },
  paceAlertSound:         { type: 'boolean', default: true },

  openAtLogin: { type: 'boolean', default: false },
};

const store = new Store({ schema, name: 'claude-tracker-settings' });

module.exports = store;
