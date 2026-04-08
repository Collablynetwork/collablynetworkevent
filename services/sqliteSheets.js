'use strict';

const fs = require('fs');
const path = require('path');
const { SQLITE_PATH } = require('../config');

let sqlite3Module;
let dbPromise;

function getSqlite3() {
  if (!sqlite3Module) {
    sqlite3Module = require('sqlite3').verbose();
  }
  return sqlite3Module;
}

function normalizeRow(data) {
  if (!Array.isArray(data)) return [];
  return data.map((value) => (value == null ? '' : value));
}

async function initDb() {
  if (dbPromise) return dbPromise;

  dbPromise = (async () => {
    const sqlite3 = getSqlite3();
    fs.mkdirSync(path.dirname(SQLITE_PATH), { recursive: true });

    const db = await new Promise((resolve, reject) => {
      const instance = new sqlite3.Database(SQLITE_PATH, (err) => {
        if (err) reject(err);
        else resolve(instance);
      });
    });

    const api = {
      run(sql, params = []) {
        return new Promise((resolve, reject) => {
          db.run(sql, params, function onRun(err) {
            if (err) reject(err);
            else resolve({ lastID: this.lastID, changes: this.changes });
          });
        });
      },
      get(sql, params = []) {
        return new Promise((resolve, reject) => {
          db.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
          });
        });
      },
      all(sql, params = []) {
        return new Promise((resolve, reject) => {
          db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
          });
        });
      },
    };

    await api.run(`
      CREATE TABLE IF NOT EXISTS sheet_headers (
        sheet_name TEXT PRIMARY KEY,
        headers_json TEXT NOT NULL
      )
    `);
    await api.run(`
      CREATE TABLE IF NOT EXISTS sheet_rows (
        row_id INTEGER PRIMARY KEY AUTOINCREMENT,
        sheet_name TEXT NOT NULL,
        values_json TEXT NOT NULL
      )
    `);
    await api.run(`
      CREATE INDEX IF NOT EXISTS idx_sheet_rows_sheet_name_row_id
      ON sheet_rows(sheet_name, row_id)
    `);

    return api;
  })();

  return dbPromise;
}

async function getHeader(sheetName) {
  const db = await initDb();
  const row = await db.get(
    'SELECT headers_json FROM sheet_headers WHERE sheet_name = ?',
    [sheetName]
  );
  return row ? JSON.parse(row.headers_json) : null;
}

async function setHeader(sheetName, headers) {
  const db = await initDb();
  const payload = JSON.stringify(normalizeRow(headers));

  await db.run(
    `
      INSERT INTO sheet_headers (sheet_name, headers_json)
      VALUES (?, ?)
      ON CONFLICT(sheet_name) DO UPDATE SET headers_json = excluded.headers_json
    `,
    [sheetName, payload]
  );
}

async function getStoredRows(sheetName) {
  const db = await initDb();
  const rows = await db.all(
    'SELECT row_id, values_json FROM sheet_rows WHERE sheet_name = ? ORDER BY row_id ASC',
    [sheetName]
  );

  return rows.map((row) => ({
    rowId: row.row_id,
    values: JSON.parse(row.values_json),
  }));
}

async function getRows(sheetName) {
  const [header, rows] = await Promise.all([
    getHeader(sheetName),
    getStoredRows(sheetName),
  ]);

  if (!header) {
    return rows.map((row) => row.values);
  }

  return [header, ...rows.map((row) => row.values)];
}

async function appendRow(sheetName, data) {
  const header = await getHeader(sheetName);
  const normalized = normalizeRow(data);

  if (!header) {
    await setHeader(sheetName, normalized);
    return { headerCreated: true };
  }

  const db = await initDb();
  return db.run(
    'INSERT INTO sheet_rows (sheet_name, values_json) VALUES (?, ?)',
    [sheetName, JSON.stringify(normalized)]
  );
}

async function updateRow(sheetName, rowIndex, data) {
  const normalized = normalizeRow(data);

  if (rowIndex === 0) {
    await setHeader(sheetName, normalized);
    return;
  }

  const rows = await getStoredRows(sheetName);
  const target = rows[rowIndex - 1];
  if (!target) {
    throw new Error(`Row ${rowIndex} not found in ${sheetName}`);
  }

  const db = await initDb();
  await db.run(
    'UPDATE sheet_rows SET values_json = ? WHERE sheet_name = ? AND row_id = ?',
    [JSON.stringify(normalized), sheetName, target.rowId]
  );
}

async function replaceSheetData(sheetName, rows) {
  const normalizedRows = Array.isArray(rows)
    ? rows.map((row) => normalizeRow(row))
    : [];

  const db = await initDb();
  await db.run('DELETE FROM sheet_rows WHERE sheet_name = ?', [sheetName]);

  if (!normalizedRows.length) {
    await db.run('DELETE FROM sheet_headers WHERE sheet_name = ?', [sheetName]);
    return;
  }

  const [header, ...dataRows] = normalizedRows;
  await setHeader(sheetName, header);

  for (const row of dataRows) {
    await db.run(
      'INSERT INTO sheet_rows (sheet_name, values_json) VALUES (?, ?)',
      [sheetName, JSON.stringify(row)]
    );
  }
}

async function appendUser(data) {
  return appendRow('users', data);
}

module.exports = {
  appendUser,
  getRows,
  appendRow,
  updateRow,
  replaceSheetData,
};
