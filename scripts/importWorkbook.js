#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

require('dotenv').config();
process.env.STORAGE_BACKEND = 'sqlite';
process.env.GOOGLE_CREDENTIALS_JSON = '';

const storage = require('../services/storage');
const { getLatestTwitterProfileLink } = require('../utils');

const SHEET_TO_DATASET = {
  users: 'users',
  exportusers: 'users',
  contacts: 'contacts',
  exportcontacts: 'contacts',
  requests: 'requests',
  exportrequests: 'requests',
  approvalkeywords: 'approvalKeywords',
  exportapprovalkeywords: 'approvalKeywords',
  massdmhistory: 'massDmHistory',
  exportmassdmhistory: 'massDmHistory',
  profileupdatehistory: 'profileUpdateHistory',
  exportprofileupdatehistory: 'profileUpdateHistory',
  notregister: 'NotRegister',
  exportnotregister: 'NotRegister',
  itinerary: 'itinerary',
  exportitinerary: 'itinerary',
  events: 'events',
  exportevents: 'events',
  leads: 'Leads',
  exportleads: 'Leads',
  blockedusers: 'blockedUsers',
  exportblockedusers: 'blockedUsers',
  telegramreachability: 'telegramReachability',
  exporttelegramreachability: 'telegramReachability',
  eventconnections: 'eventConnections',
  exporteventconnections: 'eventConnections',
};

function getUsage() {
  return [
    'Usage:',
    'npm run import:workbook -- --file <path-to-workbook.xlsx>',
    'npm run import:workbook -- --file <path-to-workbook.xlsx> --dry-run',
    '',
    'Behavior:',
    'Imports all recognized workbook tabs into SQLite and replaces those datasets.',
    'Unrecognized/legacy tabs are skipped.',
    '',
    'Recognized tabs:',
    'Users, contacts, requests, approvalKeywords, massDmHistory, profileUpdateHistory, NotRegister, itinerary, events, Leads, blockedUsers, telegramReachability, eventConnections',
    'Also supports export_* tab names from the bot Google export.',
  ].join('\n');
}

function normalizeSheetKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function normalizeCell(value) {
  if (value == null) return '';
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Number.isInteger(value) ? String(value) : String(value).replace(/\.0+$/, '');
  }
  if (typeof value === 'boolean') {
    return value ? 'TRUE' : 'FALSE';
  }
  return String(value).trim();
}

function normalizeHeader(value) {
  return normalizeSheetKey(value);
}

function normalizeUsername(value) {
  return normalizeCell(value)
    .replace(/^https?:\/\/t\.me\//i, '')
    .replace(/^@/, '')
    .replace(/\?.*$/, '')
    .replace(/\/+$/, '')
    .trim();
}

function normalizeListValue(value) {
  const text = normalizeCell(value);
  if (!text) return '';

  const items = text
    .split(/\r?\n|,|;|\|/g)
    .map((item) => item.trim())
    .filter(Boolean);

  const unique = [];
  const seen = new Set();
  for (const item of items) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }

  return unique.join(', ');
}

function normalizeBooleanCell(value) {
  const text = normalizeCell(value).toLowerCase();
  if (!text) return 'FALSE';
  if (['true', 'yes', '1'].includes(text)) return 'TRUE';
  if (['false', 'no', '0'].includes(text)) return 'FALSE';
  return String(value).toUpperCase() === 'TRUE' ? 'TRUE' : 'FALSE';
}

function buildIndexMap(header = []) {
  return header.reduce((acc, name, index) => {
    const key = normalizeHeader(name);
    if (key && acc[key] == null) {
      acc[key] = index;
    }
    return acc;
  }, {});
}

function rowHasAnyData(row = []) {
  return Array.isArray(row) && row.some((cell) => normalizeCell(cell));
}

function getValue(row, indexMap, ...keys) {
  for (const key of keys) {
    const normalizedKey = normalizeHeader(key);
    const index = indexMap[normalizedKey];
    if (index != null && index >= 0) {
      return row[index];
    }
  }
  return '';
}

function normalizeUsersRows(header, rows) {
  const indexMap = buildIndexMap(header);

  return rows
    .filter(rowHasAnyData)
    .map((row) => {
      const chatId = normalizeCell(getValue(row, indexMap, 'chatId'));
      if (!chatId) return null;

      return [
        normalizeCell(getValue(row, indexMap, 'fullName')),
        normalizeCell(getValue(row, indexMap, 'projectName')),
        getLatestTwitterProfileLink(getValue(row, indexMap, 'xUrl')) || '',
        normalizeCell(getValue(row, indexMap, 'role')),
        normalizeListValue(getValue(row, indexMap, 'categories')),
        normalizeListValue(getValue(row, indexMap, 'lookingFor')),
        chatId,
        normalizeUsername(getValue(row, indexMap, 'username')),
        normalizeCell(getValue(row, indexMap, 'status')) || 'active',
      ];
    })
    .filter(Boolean);
}

function normalizeContactsRows(header, rows) {
  const indexMap = buildIndexMap(header);
  return rows
    .filter(rowHasAnyData)
    .map((row) => [
      normalizeCell(getValue(row, indexMap, 'from')),
      normalizeCell(getValue(row, indexMap, 'to')),
      normalizeCell(getValue(row, indexMap, 'timestamp')),
    ])
    .filter((row) => row[0] && row[1]);
}

function normalizeRequestsRows(header, rows) {
  const indexMap = buildIndexMap(header);
  return rows
    .filter(rowHasAnyData)
    .map((row) => [
      normalizeCell(getValue(row, indexMap, 'from')),
      normalizeCell(getValue(row, indexMap, 'to')),
      normalizeCell(getValue(row, indexMap, 'status')) || 'pending',
      normalizeCell(getValue(row, indexMap, 'timestamp')),
    ])
    .filter((row) => row[0] && row[1]);
}

function normalizeApprovalKeywordsRows(header, rows) {
  const indexMap = buildIndexMap(header);
  return rows
    .filter(rowHasAnyData)
    .map((row) => [
      normalizeCell(getValue(row, indexMap, 'keyword')),
      normalizeCell(getValue(row, indexMap, 'addedAt')),
      normalizeCell(getValue(row, indexMap, 'addedBy')),
    ])
    .filter((row) => row[0]);
}

function normalizeMassDmHistoryRows(header, rows) {
  const indexMap = buildIndexMap(header);
  return rows
    .filter(rowHasAnyData)
    .map((row) => [
      normalizeCell(getValue(row, indexMap, 'senderChatId')),
      normalizeCell(getValue(row, indexMap, 'batchId')),
      normalizeCell(getValue(row, indexMap, 'selection')),
      normalizeCell(getValue(row, indexMap, 'messageText')),
      normalizeCell(getValue(row, indexMap, 'createdAt')),
      normalizeCell(getValue(row, indexMap, 'deliveryJson')),
    ])
    .filter((row) => row[0]);
}

function normalizeProfileUpdateHistoryRows(header, rows) {
  const indexMap = buildIndexMap(header);
  return rows
    .filter(rowHasAnyData)
    .map((row) => [
      normalizeCell(getValue(row, indexMap, 'chatId')),
      normalizeUsername(getValue(row, indexMap, 'username')),
      normalizeCell(getValue(row, indexMap, 'editedAt')),
    ])
    .filter((row) => row[0] || row[1]);
}

function normalizeNotRegisterRows(header, rows) {
  const indexMap = buildIndexMap(header);
  return rows
    .filter(rowHasAnyData)
    .map((row) => [
      normalizeUsername(getValue(row, indexMap, 'username')),
      normalizeCell(getValue(row, indexMap, 'chatId')),
      normalizeBooleanCell(getValue(row, indexMap, 'registered')),
      normalizeCell(getValue(row, indexMap, 'timestamp')),
      normalizeCell(getValue(row, indexMap, 'lastReminderAt')),
    ])
    .filter((row) => row[0] || row[1]);
}

function normalizeItineraryRows(header, rows) {
  const indexMap = buildIndexMap(header);
  return rows
    .filter(rowHasAnyData)
    .map((row) => [
      normalizeCell(getValue(row, indexMap, 'eventId')),
      normalizeCell(getValue(row, indexMap, 'chatId')),
      normalizeCell(getValue(row, indexMap, 'status')) || 'going',
      normalizeCell(getValue(row, indexMap, 'timestamp')),
    ])
    .filter((row) => row[0] && row[1]);
}

function normalizeEventsRows(header, rows) {
  const indexMap = buildIndexMap(header);
  return rows
    .filter(rowHasAnyData)
    .map((row) => [
      normalizeCell(getValue(row, indexMap, 'eventId')),
      normalizeCell(getValue(row, indexMap, 'title')),
      normalizeCell(getValue(row, indexMap, 'description')),
      normalizeCell(getValue(row, indexMap, 'date')),
      normalizeCell(getValue(row, indexMap, 'time')),
      normalizeCell(getValue(row, indexMap, 'location')),
      normalizeCell(getValue(row, indexMap, 'apply')),
      normalizeCell(getValue(row, indexMap, 'expiresAt')),
    ])
    .filter((row) => row[0] || row[1]);
}

function normalizeLeadsRows(header, rows) {
  const indexMap = buildIndexMap(header);
  return rows
    .filter(rowHasAnyData)
    .map((row) => [
      normalizeUsername(getValue(row, indexMap, 'username')),
      normalizeListValue(getValue(row, indexMap, 'categories')),
      normalizeListValue(getValue(row, indexMap, 'lookingFor')),
      getLatestTwitterProfileLink(getValue(row, indexMap, 'xUrl')) || '',
      normalizeCell(getValue(row, indexMap, 'projectName')),
      normalizeCell(getValue(row, indexMap, 'chatId')),
      normalizeCell(getValue(row, indexMap, 'timestamp')),
    ])
    .filter((row) => row[0] || row[5]);
}

function normalizeBlockedUsersRows(header, rows) {
  const indexMap = buildIndexMap(header);
  return rows
    .filter(rowHasAnyData)
    .map((row) => [
      normalizeCell(getValue(row, indexMap, 'chatId')),
      normalizeUsername(getValue(row, indexMap, 'username')),
      normalizeCell(getValue(row, indexMap, 'blockedAt')),
      normalizeCell(getValue(row, indexMap, 'blockedBy')),
      normalizeBooleanCell(getValue(row, indexMap, 'active')),
    ])
    .filter((row) => row[0] || row[1]);
}

function normalizeTelegramReachabilityRows(header, rows) {
  const indexMap = buildIndexMap(header);
  return rows
    .filter(rowHasAnyData)
    .map((row) => [
      normalizeCell(getValue(row, indexMap, 'chatId')),
      normalizeUsername(getValue(row, indexMap, 'username')),
      normalizeCell(getValue(row, indexMap, 'status')) || 'unreachable',
      normalizeCell(getValue(row, indexMap, 'reason')),
      normalizeCell(getValue(row, indexMap, 'firstFailedAt')),
      normalizeCell(getValue(row, indexMap, 'lastFailedAt')),
      normalizeCell(getValue(row, indexMap, 'failureCount')) || '1',
      normalizeCell(getValue(row, indexMap, 'lastError')),
    ])
    .filter((row) => row[0] || row[1]);
}

function normalizeEventConnectionsRows(header, rows) {
  const indexMap = buildIndexMap(header);
  return rows
    .filter(rowHasAnyData)
    .map((row) => [
      normalizeCell(getValue(row, indexMap, 'eventId')),
      normalizeCell(getValue(row, indexMap, 'eventTitle')),
      normalizeCell(getValue(row, indexMap, 'userAChatId')),
      normalizeCell(getValue(row, indexMap, 'userBChatId')),
      normalizeCell(getValue(row, indexMap, 'userAStatus')) || 'pending',
      normalizeCell(getValue(row, indexMap, 'userBStatus')) || 'pending',
      normalizeCell(getValue(row, indexMap, 'createdAt')),
      normalizeCell(getValue(row, indexMap, 'updatedAt')),
    ])
    .filter((row) => row[0] && row[2] && row[3]);
}

const NORMALIZERS = {
  users: normalizeUsersRows,
  contacts: normalizeContactsRows,
  requests: normalizeRequestsRows,
  approvalKeywords: normalizeApprovalKeywordsRows,
  massDmHistory: normalizeMassDmHistoryRows,
  profileUpdateHistory: normalizeProfileUpdateHistoryRows,
  NotRegister: normalizeNotRegisterRows,
  itinerary: normalizeItineraryRows,
  events: normalizeEventsRows,
  Leads: normalizeLeadsRows,
  blockedUsers: normalizeBlockedUsersRows,
  telegramReachability: normalizeTelegramReachabilityRows,
  eventConnections: normalizeEventConnectionsRows,
};

function parseArgs(argv) {
  const args = {
    file: '',
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (token === '--file' || token === '-f') {
      args.file = argv[i + 1] || '';
      i += 1;
      continue;
    }

    if (token === '--dry-run') {
      args.dryRun = true;
      continue;
    }

    if (token === '--help' || token === '-h') {
      args.help = true;
    }
  }

  return args;
}

function resolveDatasetForSheet(sheetName) {
  return SHEET_TO_DATASET[normalizeSheetKey(sheetName)] || null;
}

function loadWorkbook(filePath) {
  const workbook = XLSX.readFile(filePath, { raw: false });
  return workbook.SheetNames.map((sheetName) => {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
      header: 1,
      defval: '',
      blankrows: false,
      raw: false,
    });
    const [header = [], ...dataRows] = rows;

    return {
      sheetName,
      datasetName: resolveDatasetForSheet(sheetName),
      header: header.map((value) => normalizeCell(value)),
      rows: dataRows,
    };
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || !args.file) {
    console.log(getUsage());
    process.exit(args.help ? 0 : 1);
  }

  const filePath = path.resolve(args.file);
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const sheets = loadWorkbook(filePath);
  const imported = [];
  const skipped = [];

  for (const sheet of sheets) {
    if (!sheet.datasetName) {
      skipped.push(`${sheet.sheetName} -> skipped (unsupported tab)`);
      continue;
    }

    const normalize = NORMALIZERS[sheet.datasetName];
    if (!normalize) {
      skipped.push(`${sheet.sheetName} -> skipped (no normalizer)`);
      continue;
    }

    const rows = normalize(sheet.header, sheet.rows);

    if (!args.dryRun) {
      await storage.replaceDatasetRows(sheet.datasetName, rows);
    }

    imported.push({
      sheetName: sheet.sheetName,
      datasetName: sheet.datasetName,
      rowCount: rows.length,
    });
  }

  console.log(
    [
      `Workbook: ${filePath}`,
      `Mode: ${args.dryRun ? 'dry-run' : 'replace datasets in SQLite'}`,
      '',
      'Imported sheets:',
      ...(
        imported.length
          ? imported.map(
              (item) =>
                `- ${item.sheetName} -> ${item.datasetName} (${item.rowCount} rows)`
            )
          : ['- None']
      ),
      '',
      'Skipped sheets:',
      ...(
        skipped.length
          ? skipped.map((item) => `- ${item}`)
          : ['- None']
      ),
    ].join('\n')
  );
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
