'use strict';

const { STORAGE_BACKEND } = require('../config');
const googleSheets = require('./googleSheets');
const sqliteSheets = require('./sqliteSheets');

let activeBackend;

function chooseInitialBackend() {
  if (STORAGE_BACKEND === 'google') return 'google';
  if (STORAGE_BACKEND === 'sqlite') return 'sqlite';
  return 'sqlite';
}

function getBackendModule(name) {
  return name === 'google' ? googleSheets : sqliteSheets;
}

function setActiveBackend(name) {
  activeBackend = name;
  return getBackendModule(name);
}

function getBackendName() {
  return activeBackend || chooseInitialBackend();
}

async function call(method, ...args) {
  const primaryName = getBackendName();
  const primary = setActiveBackend(primaryName);

  try {
    return await primary[method](...args);
  } catch (err) {
    if (primaryName === 'sqlite') throw err;

    console.warn(
      `⚠️ Google Sheets ${method} failed (${err.message}). Falling back to SQLite.`
    );

    const fallback = setActiveBackend('sqlite');
    return fallback[method](...args);
  }
}

module.exports = {
  appendUser(...args) {
    return call('appendUser', ...args);
  },
  getRows(...args) {
    return call('getRows', ...args);
  },
  appendRow(...args) {
    return call('appendRow', ...args);
  },
  updateRow(...args) {
    return call('updateRow', ...args);
  },
  replaceSheetData(...args) {
    return call('replaceSheetData', ...args);
  },
  getBackendName,
};
