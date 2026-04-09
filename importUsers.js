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

const FIELD_ALIASES = {
  fullName: [
    'fullname',
    'name',
    'contactperson',
    'contactpersonname',
    'personname',
    'foundername',
  ],
  projectName: [
    'projectname',
    'project',
    'projecttitle',
    'company',
    'startup',
    'brand',
  ],
  xUrl: [
    'xurl',
    'x',
    'twitter',
    'twitterhandle',
    'twitterurl',
    'twitterlink',
    'xhandle',
    'xprofile',
    'xlink',
  ],
  role: ['role', 'designation', 'title', 'position'],
  categories: [
    'categories',
    'projectcategory',
    'projectcategories',
    'category',
    'building',
    'whatareyoubuilding',
    'whatyouarebuilding',
    'projectisbuilding',
  ],
  lookingFor: [
    'lookingfor',
    'projectislookingfor',
    'whatareyoulookingfor',
    'whatyouneed',
    'needs',
    'need',
    'seeking',
  ],
  chatId: [
    'chatid',
    'telegramchatid',
    'userid',
    'telegramid',
    'telegramuserid',
    'userid',
  ],
  username: [
    'username',
    'telegramusername',
    'telegram',
    'telegramhandle',
    'telegramuser',
    'handle',
  ],
  status: ['status', 'profilestatus', 'notificationstatus'],
};

function getUsage() {
  return [
    'Usage:',
    'npm run import:users -- --file <path-to-users.xlsx>',
    'npm run import:users -- --file <path-to-users.xlsx> --sheet "Sheet1"',
    'npm run import:users -- --file <path-to-users.xlsx> --mode insert',
    'npm run import:users -- --file <path-to-users.csv> --dry-run',
    '',
    'Modes:',
    'upsert  Update existing chatId rows and insert new ones (default)',
    'insert  Insert only new chatId rows and skip existing ones',
    '',
    'Expected columns:',
    'fullName, projectName, xUrl, role, categories, lookingFor, chatId, username, status',
    'Flexible aliases are supported, for example "Contact Person", "Project", "Telegram Username".',
  ].join('\n');
}

function normalizeHeader(value) {
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
  return String(value).trim();
}

function normalizeChatId(value) {
  const text = normalizeCell(value);
  if (!text) return '';

  if (/^-?\d+(\.0+)?$/.test(text)) {
    return text.replace(/\.0+$/, '');
  }

  return text;
}

function normalizeTelegramUsername(value) {
  const text = normalizeCell(value);
  if (!text) return '';

  return text
    .replace(/^https?:\/\/t\.me\//i, '')
    .replace(/^@/, '')
    .replace(/\?.*$/, '')
    .replace(/\/+$/, '')
    .trim();
}

function normalizeStatus(value, fallback = 'active') {
  const text = normalizeCell(value).toLowerCase();
  if (!text) return fallback;
  if (['active', 'pause', 'paused', 'mute', 'muted'].includes(text)) {
    return text;
  }
  return fallback;
}

function uniqueList(values) {
  const out = [];
  const seen = new Set();

  for (const value of values) {
    const item = normalizeCell(value);
    const key = item.toLowerCase();
    if (!item || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }

  return out;
}

function normalizeListCell(value, fallback = '') {
  if (Array.isArray(value)) {
    return uniqueList(value).join(', ');
  }

  const text = normalizeCell(value);
  if (!text) return fallback;

  return uniqueList(text.split(/\r?\n|,|;|\|/g)).join(', ');
}

function normalizeXValue(value, fallback = '') {
  const text = normalizeCell(value);
  if (!text) return fallback;
  return getLatestTwitterProfileLink(text) || fallback;
}

function parseArgs(argv) {
  const args = {
    file: '',
    sheet: '',
    mode: 'upsert',
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (token === '--file' || token === '-f') {
      args.file = argv[i + 1] || '';
      i += 1;
      continue;
    }

    if (token === '--sheet' || token === '-s') {
      args.sheet = argv[i + 1] || '';
      i += 1;
      continue;
    }

    if (token === '--mode') {
      args.mode = String(argv[i + 1] || 'upsert').trim().toLowerCase();
      i += 1;
      continue;
    }

    if (token === '--dry-run') {
      args.dryRun = true;
      continue;
    }

    if (token === '--help' || token === '-h') {
      args.help = true;
      continue;
    }
  }

  return args;
}

function parseDelimitedLine(line, delimiter) {
  const cells = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === delimiter && !inQuotes) {
      cells.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  cells.push(current);
  return cells.map((cell) => normalizeCell(cell));
}

function loadTsvRows(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return { header: [], rows: [] };

  const header = parseDelimitedLine(lines[0], '\t');
  const rows = lines.slice(1).map((line) => parseDelimitedLine(line, '\t'));
  return { header, rows };
}

function loadWorkbookRows(filePath, sheetName) {
  const workbook = XLSX.readFile(filePath, { raw: false });
  const selectedSheetName = sheetName || workbook.SheetNames[0];

  if (!selectedSheetName || !workbook.Sheets[selectedSheetName]) {
    throw new Error(
      `Sheet "${sheetName}" not found. Available sheets: ${workbook.SheetNames.join(', ')}`
    );
  }

  const aoa = XLSX.utils.sheet_to_json(workbook.Sheets[selectedSheetName], {
    header: 1,
    defval: '',
    blankrows: false,
    raw: false,
  });

  const [header = [], ...rows] = aoa;
  return {
    header: header.map((value) => normalizeCell(value)),
    rows,
    sheetName: selectedSheetName,
  };
}

function loadRows(filePath, sheetName) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.tsv' || ext === '.txt') {
    const result = loadTsvRows(filePath);
    return { ...result, sheetName: 'TSV' };
  }

  return loadWorkbookRows(filePath, sheetName);
}

function buildColumnIndex(header) {
  const index = new Map();

  header.forEach((name, columnIndex) => {
    const key = normalizeHeader(name);
    if (key && !index.has(key)) {
      index.set(key, columnIndex);
    }
  });

  return index;
}

function resolveFieldIndexes(header) {
  const columnIndex = buildColumnIndex(header);
  const resolved = {};

  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    const foundKey = [field, ...aliases]
      .map((alias) => normalizeHeader(alias))
      .find((alias) => columnIndex.has(alias));

    resolved[field] = foundKey ? columnIndex.get(foundKey) : -1;
  }

  return resolved;
}

function rowHasData(row) {
  return Array.isArray(row) && row.some((cell) => normalizeCell(cell));
}

function getValue(row, fieldIndexes, fieldName) {
  const index = fieldIndexes[fieldName];
  if (index == null || index < 0) return '';
  return row[index];
}

function buildImportedUser(row, fieldIndexes, existingUser = null) {
  const existingCategories = Array.isArray(existingUser && existingUser.categories)
    ? existingUser.categories.join(', ')
    : '';
  const existingLookingFor = Array.isArray(existingUser && existingUser.lookingFor)
    ? existingUser.lookingFor.join(', ')
    : '';

  const chatId = normalizeChatId(getValue(row, fieldIndexes, 'chatId'));
  if (!chatId) {
    return null;
  }

  const username = normalizeTelegramUsername(
    getValue(row, fieldIndexes, 'username')
  ) || (existingUser && existingUser.username) || '';

  return {
    fullName:
      normalizeCell(getValue(row, fieldIndexes, 'fullName')) ||
      (existingUser && existingUser.fullName) ||
      '',
    projectName:
      normalizeCell(getValue(row, fieldIndexes, 'projectName')) ||
      (existingUser && existingUser.projectName) ||
      '',
    xUrl: normalizeXValue(
      getValue(row, fieldIndexes, 'xUrl'),
      (existingUser && existingUser.xUrl) || ''
    ),
    role:
      normalizeCell(getValue(row, fieldIndexes, 'role')) ||
      (existingUser && existingUser.role) ||
      '',
    categories: normalizeListCell(
      getValue(row, fieldIndexes, 'categories'),
      existingCategories
    ),
    lookingFor: normalizeListCell(
      getValue(row, fieldIndexes, 'lookingFor'),
      existingLookingFor
    ),
    chatId,
    username,
    status: normalizeStatus(
      getValue(row, fieldIndexes, 'status'),
      (existingUser && existingUser.status) || 'active'
    ),
  };
}

function userToRowArray(user) {
  return [
    user.fullName || '',
    user.projectName || '',
    user.xUrl || '',
    user.role || '',
    user.categories || '',
    user.lookingFor || '',
    user.chatId || '',
    user.username || '',
    user.status || 'active',
  ];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || !args.file) {
    console.log(getUsage());
    process.exit(args.help ? 0 : 1);
  }

  if (!['upsert', 'insert'].includes(args.mode)) {
    console.error(`Invalid mode "${args.mode}". Use "upsert" or "insert".`);
    process.exit(1);
  }

  const filePath = path.resolve(args.file);
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const { header, rows, sheetName } = loadRows(filePath, args.sheet);
  const fieldIndexes = resolveFieldIndexes(header);

  if (fieldIndexes.chatId < 0) {
    console.error('Missing required chatId column.');
    console.error(getUsage());
    process.exit(1);
  }

  const existingUsers = await storage.getUsers();
  const existingByChatId = new Map(
    existingUsers.map((user) => [String(user.chatId), user])
  );

  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let invalid = 0;

  for (const row of rows) {
    if (!rowHasData(row)) continue;

    const chatId = normalizeChatId(getValue(row, fieldIndexes, 'chatId'));
    if (!chatId) {
      invalid += 1;
      continue;
    }

    const existingUser = existingByChatId.get(chatId) || null;
    if (existingUser && args.mode === 'insert') {
      skipped += 1;
      continue;
    }

    const importedUser = buildImportedUser(row, fieldIndexes, existingUser);
    if (!importedUser) {
      invalid += 1;
      continue;
    }

    if (args.dryRun) {
      if (existingUser) updated += 1;
      else inserted += 1;
      continue;
    }

    if (existingUser) {
      await storage.updateUser(userToRowArray(importedUser));
      updated += 1;
    } else {
      await storage.saveUser(userToRowArray(importedUser));
      inserted += 1;
    }

    existingByChatId.set(chatId, {
      ...importedUser,
      categories: importedUser.categories
        ? importedUser.categories.split(',').map((item) => item.trim()).filter(Boolean)
        : [],
      lookingFor: importedUser.lookingFor
        ? importedUser.lookingFor.split(',').map((item) => item.trim()).filter(Boolean)
        : [],
      registered: true,
    });
  }

  const resolvedColumns = Object.entries(fieldIndexes)
    .filter(([, index]) => index >= 0)
    .map(([field, index]) => `${field} <- ${header[index]}`)
    .join('\n');

  console.log(
    [
      `Import source: ${filePath}`,
      `Sheet: ${sheetName || 'default'}`,
      `Mode: ${args.mode}${args.dryRun ? ' (dry-run)' : ''}`,
      '',
      'Detected columns:',
      resolvedColumns || 'None',
      '',
      `Inserted: ${inserted}`,
      `Updated: ${updated}`,
      `Skipped: ${skipped}`,
      `Invalid rows: ${invalid}`,
    ].join('\n')
  );
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
