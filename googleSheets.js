// services/googleSheets.js
'use strict';

const { GOOGLE_CREDENTIALS, SHEET_ID, isGoogleConfigured } = require('../config');

let sheetsClient;
let knownSheetTitlesPromise = null;
const ensureSheetExistsInflight = new Map();

function normalizeSheetTitle(value) {
  return String(value || '').trim().toLowerCase();
}

function isConfigured() {
  return Boolean(isGoogleConfigured);
}

async function getSheetsClient() {
  if (!isConfigured()) {
    throw new Error('Google Sheets is not configured');
  }
  if (sheetsClient) return sheetsClient;

  const { google } = require('googleapis');
  const auth = new google.auth.JWT({
    email: GOOGLE_CREDENTIALS.client_email,
    key: GOOGLE_CREDENTIALS.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  await auth.authorize();
  sheetsClient = google.sheets({ version: 'v4', auth });
  return sheetsClient;
}

async function loadKnownSheetTitles(force = false) {
  if (!force && knownSheetTitlesPromise) {
    return knownSheetTitlesPromise;
  }

  knownSheetTitlesPromise = (async () => {
    const sheets = await getSheetsClient();
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: SHEET_ID,
      fields: 'sheets.properties.title',
    });

    return new Set(
      (meta.data.sheets || [])
        .map((sheet) => normalizeSheetTitle(sheet.properties && sheet.properties.title))
        .filter(Boolean)
    );
  })();

  try {
    return await knownSheetTitlesPromise;
  } catch (error) {
    knownSheetTitlesPromise = null;
    throw error;
  }
}

async function ensureSheetExists(sheetName) {
  const normalizedTitle = normalizeSheetTitle(sheetName);
  if (!normalizedTitle) {
    throw new Error('Sheet name is required');
  }

  const knownTitles = await loadKnownSheetTitles();
  if (knownTitles.has(normalizedTitle)) return;

  if (ensureSheetExistsInflight.has(normalizedTitle)) {
    await ensureSheetExistsInflight.get(normalizedTitle);
    return;
  }

  const pending = (async () => {
    const sheets = await getSheetsClient();
    try {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: {
          requests: [{ addSheet: { properties: { title: sheetName } } }],
        },
      });
    } catch (error) {
      const message = String(error?.message || '');
      if (!/already exists/i.test(message)) {
        throw error;
      }
    }

    const refreshedTitles = await loadKnownSheetTitles(true);
    refreshedTitles.add(normalizedTitle);
  })();

  ensureSheetExistsInflight.set(normalizedTitle, pending);

  try {
    await pending;
  } finally {
    ensureSheetExistsInflight.delete(normalizedTitle);
  }
}

/**
 * Append a single row of data (array of values) to the 'users' tab.
 * e.g. [fullName, projectName, xUrl, role, catsCsv, lookingForCsv, chatId]
 */
async function appendUser(data) {
  const sheets = await getSheetsClient();
  const resource = { values: [data] };
  return sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: 'users!A:H',
    valueInputOption: 'RAW',
    resource,
  });
}

/**
 * Read all rows from a given sheet tab (A:Z).
 * @param {string} sheetName - tab name (e.g. 'users', 'requests')
 */
async function getRows(sheetName) {
  const sheets = await getSheetsClient();
  await ensureSheetExists(sheetName);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${sheetName}!A:Z`,
  });
  return res.data.values || [];
}

/**
 * Append a row of values to any given tab.
 * @param {string} sheetName
 * @param {any[]} data
 */
async function appendRow(sheetName, data) {
  const sheets = await getSheetsClient();
  await ensureSheetExists(sheetName);
  return sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${sheetName}!A:Z`,
    valueInputOption: 'RAW',
    resource: { values: [data] },
  });
}

/**
 * Update a specific row at rowIndex (0-based) in a given tab.
 * @param {string} sheetName
 * @param {number} rowIndex
 * @param {any[]} data
 */
async function updateRow(sheetName, rowIndex, data) {
  const sheets = await getSheetsClient();
  await ensureSheetExists(sheetName);
  const row = rowIndex + 1; // Google Sheets is 1-based
  return sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${sheetName}!A${row}:Z${row}`,
    valueInputOption: 'RAW',
    resource: { values: [data] },
  });
}

async function replaceSheetData(sheetName, rows) {
  const sheets = await getSheetsClient();
  await ensureSheetExists(sheetName);

  await sheets.spreadsheets.values.clear({
    spreadsheetId: SHEET_ID,
    range: `${sheetName}!A:Z`,
  });

  if (!Array.isArray(rows) || rows.length === 0) return;

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${sheetName}!A1`,
    valueInputOption: 'RAW',
    resource: { values: rows },
  });
}

module.exports = {
  isConfigured,
  getSheetsClient,
  ensureSheetExists,
  appendUser,
  getRows,
  appendRow,
  updateRow,
  replaceSheetData,
};
