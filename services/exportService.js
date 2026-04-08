'use strict';

const fs = require('fs');
const path = require('path');

const { SHEET_ID } = require('../config');
const storage = require('./storage');
const googleSheets = require('./googleSheets');
const sqliteSheets = require('./sqliteSheets');

function getTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function toCsvCell(value) {
  const text = String(value == null ? '' : value);
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function rowsToCsv(rows) {
  return rows
    .map((row) => (Array.isArray(row) ? row.map(toCsvCell).join(',') : ''))
    .join('\n');
}

function ensureExportDir() {
  const outputDir = path.join(__dirname, '..', 'output', 'exports');
  fs.mkdirSync(outputDir, { recursive: true });
  return outputDir;
}

function normalizeUsername(value) {
  return String(value || '')
    .trim()
    .replace(/^@/, '')
    .toLowerCase();
}

async function getDatasetRowsFromSource(datasetName, source = 'storage') {
  const sheetName = storage.resolveDatasetName(datasetName);

  if (source === 'sqlite') {
    const rows = await sqliteSheets.getRows(sheetName);
    return rows.length ? rows : [storage.HEADERS[sheetName]];
  }

  return storage.getDatasetRows(sheetName);
}

function buildIndexMap(header = []) {
  return header.reduce((acc, name, index) => {
    acc[String(name || '').trim()] = index;
    return acc;
  }, {});
}

function parseUsersRows(rows) {
  const [header, ...data] = rows;
  const idx = buildIndexMap(header || []);

  return data.map((row) => ({
    chatId: String(row[idx.chatId] || ''),
    username: String(row[idx.username] || ''),
    fullName: String(row[idx.fullName] || ''),
    projectName: String(row[idx.projectName] || ''),
    xUrl: String(row[idx.xUrl] || ''),
    role: String(row[idx.role] || ''),
    categories: String(row[idx.categories] || ''),
    lookingFor: String(row[idx.lookingFor] || ''),
    status: String(row[idx.status] || ''),
  }));
}

function parseRequestsRows(rows) {
  const [, ...data] = rows;
  return data.map((row) => ({
    from: String(row[0] || ''),
    to: String(row[1] || ''),
    status: String(row[2] || ''),
    timestamp: String(row[3] || ''),
  }));
}

function parseContactsRows(rows) {
  const [, ...data] = rows;
  return data.map((row) => ({
    from: String(row[0] || ''),
    to: String(row[1] || ''),
    timestamp: String(row[2] || ''),
  }));
}

function parseEventConnectionsRows(rows) {
  const [, ...data] = rows;
  return data.map((row) => ({
    eventId: String(row[0] || ''),
    eventTitle: String(row[1] || ''),
    userAChatId: String(row[2] || ''),
    userBChatId: String(row[3] || ''),
    userAStatus: String(row[4] || ''),
    userBStatus: String(row[5] || ''),
    createdAt: String(row[6] || ''),
    updatedAt: String(row[7] || ''),
  }));
}

function parseEventsRows(rows) {
  const [header, ...data] = rows;
  const idx = buildIndexMap(header || []);

  return data.map((row) => ({
    eventId: String(row[idx.eventId] || ''),
    title: String(row[idx.title] || ''),
    description: String(row[idx.description] || ''),
    date: String(row[idx.date] || ''),
    time: String(row[idx.time] || ''),
    location: String(row[idx.location] || ''),
    apply: String(row[idx.apply] || ''),
    expiresAt: String(row[idx.expiresAt] || ''),
  }));
}

function buildUserLookup(users) {
  const byChatId = new Map();
  const byUsername = new Map();

  for (const user of users) {
    const chatId = String(user.chatId || '');
    if (chatId) byChatId.set(chatId, user);

    const username = normalizeUsername(user.username);
    if (username) byUsername.set(username, user);
  }

  return {
    byChatId,
    byUsername,
    resolve(identifier) {
      const raw = String(identifier || '');
      return (
        byChatId.get(raw) ||
        byUsername.get(normalizeUsername(raw)) ||
        null
      );
    },
  };
}

function buildContactsEnrichedRows(users, contacts) {
  const lookup = buildUserLookup(users);
  const header = [
    'fromChatId',
    'fromUsername',
    'fromProjectName',
    'fromFullName',
    'fromRole',
    'fromXUrl',
    'toChatId',
    'toUsername',
    'toProjectName',
    'toFullName',
    'toRole',
    'toXUrl',
    'timestamp',
  ];

  const rows = contacts.map((contact) => {
    const fromUser = lookup.resolve(contact.from) || {};
    const toUser = lookup.resolve(contact.to) || {};

    return [
      contact.from,
      fromUser.username || '',
      fromUser.projectName || '',
      fromUser.fullName || '',
      fromUser.role || '',
      fromUser.xUrl || '',
      contact.to,
      toUser.username || '',
      toUser.projectName || '',
      toUser.fullName || '',
      toUser.role || '',
      toUser.xUrl || '',
      contact.timestamp || '',
    ];
  });

  return { tabName: 'contacts_enriched', rows: [header, ...rows] };
}

function buildRequestsEnrichedRows(users, requests) {
  const lookup = buildUserLookup(users);
  const header = [
    'fromChatId',
    'fromUsername',
    'fromProjectName',
    'fromFullName',
    'fromRole',
    'fromXUrl',
    'fromCategories',
    'fromLookingFor',
    'fromStatus',
    'toChatId',
    'toUsername',
    'toProjectName',
    'toFullName',
    'toRole',
    'toXUrl',
    'toCategories',
    'toLookingFor',
    'toStatus',
    'requestStatus',
    'timestamp',
  ];

  const rows = requests.map((request) => {
    const fromUser = lookup.resolve(request.from) || {};
    const toUser = lookup.resolve(request.to) || {};

    return [
      request.from,
      fromUser.username || '',
      fromUser.projectName || '',
      fromUser.fullName || '',
      fromUser.role || '',
      fromUser.xUrl || '',
      fromUser.categories || '',
      fromUser.lookingFor || '',
      fromUser.status || '',
      request.to,
      toUser.username || '',
      toUser.projectName || '',
      toUser.fullName || '',
      toUser.role || '',
      toUser.xUrl || '',
      toUser.categories || '',
      toUser.lookingFor || '',
      toUser.status || '',
      request.status || '',
      request.timestamp || '',
    ];
  });

  return { tabName: 'requests_enriched', rows: [header, ...rows] };
}

function buildPendingConnectionsRows(users, requests) {
  const enriched = buildRequestsEnrichedRows(
    users,
    requests.filter((request) => String(request.status || '').toLowerCase() === 'pending')
  );

  return {
    tabName: 'pending_connections',
    rows: enriched.rows,
  };
}

function buildEventConnectionsEnrichedRows(users, events, eventConnections) {
  const userLookup = buildUserLookup(users);
  const eventLookup = new Map(
    events.map((event) => [String(event.eventId || ''), event])
  );
  const header = [
    'eventId',
    'eventTitle',
    'eventDate',
    'eventTime',
    'userAChatId',
    'userAUsername',
    'userAProjectName',
    'userAFullName',
    'userARole',
    'userACategories',
    'userALookingFor',
    'userAStatus',
    'userBChatId',
    'userBUsername',
    'userBProjectName',
    'userBFullName',
    'userBRole',
    'userBCategories',
    'userBLookingFor',
    'userBStatus',
    'createdAt',
    'updatedAt',
  ];

  const rows = eventConnections.map((connection) => {
    const event = eventLookup.get(String(connection.eventId || '')) || {};
    const userA = userLookup.resolve(connection.userAChatId) || {};
    const userB = userLookup.resolve(connection.userBChatId) || {};

    return [
      connection.eventId || '',
      connection.eventTitle || event.title || '',
      event.date || '',
      event.time || '',
      connection.userAChatId || '',
      userA.username || '',
      userA.projectName || '',
      userA.fullName || '',
      userA.role || '',
      userA.categories || '',
      userA.lookingFor || '',
      connection.userAStatus || '',
      connection.userBChatId || '',
      userB.username || '',
      userB.projectName || '',
      userB.fullName || '',
      userB.role || '',
      userB.categories || '',
      userB.lookingFor || '',
      connection.userBStatus || '',
      connection.createdAt || '',
      connection.updatedAt || '',
    ];
  });

  return { tabName: 'event_connections_enriched', rows: [header, ...rows] };
}

async function buildDerivedGoogleExports(source = 'storage') {
  const [usersRows, requestsRows, contactsRows, eventsRows, eventConnectionsRows] = await Promise.all([
    getDatasetRowsFromSource('users', source),
    getDatasetRowsFromSource('requests', source),
    getDatasetRowsFromSource('contacts', source),
    getDatasetRowsFromSource('events', source),
    getDatasetRowsFromSource('eventConnections', source),
  ]);

  const users = parseUsersRows(usersRows);
  const requests = parseRequestsRows(requestsRows);
  const contacts = parseContactsRows(contactsRows);
  const events = parseEventsRows(eventsRows);
  const eventConnections = parseEventConnectionsRows(eventConnectionsRows);

  return [
    buildContactsEnrichedRows(users, contacts),
    buildRequestsEnrichedRows(users, requests),
    buildPendingConnectionsRows(users, requests),
    buildEventConnectionsEnrichedRows(users, events, eventConnections),
  ];
}

async function exportDatasetToCsv(datasetName) {
  const sheetName = storage.resolveDatasetName(datasetName);
  const rows = await storage.getDatasetRows(sheetName);
  const filename = `${sheetName}-${getTimestamp()}.csv`;
  const filePath = path.join(ensureExportDir(), filename);

  fs.writeFileSync(filePath, rowsToCsv(rows), 'utf8');

  return {
    dataset: sheetName,
    filePath,
    filename,
    rowCount: Math.max(rows.length - 1, 0),
  };
}

async function exportCsv(datasetName) {
  if (String(datasetName || '').trim().toLowerCase() === 'all') {
    const files = [];
    for (const sheetName of storage.listDatasets()) {
      files.push(await exportDatasetToCsv(sheetName));
    }
    return files;
  }

  return [await exportDatasetToCsv(datasetName)];
}

function getGoogleExportTabName(datasetName) {
  return `export_${datasetName}`.slice(0, 99);
}

async function exportGoogle(datasetName) {
  return exportGoogleSnapshot(datasetName, { source: 'storage', includeDerived: true });
}

async function exportGoogleSnapshot(datasetName, options = {}) {
  if (!googleSheets.isConfigured()) {
    throw new Error('Google Sheets export is not configured');
  }

  const source = options.source || 'storage';
  const includeDerived =
    options.includeDerived !== false &&
    String(datasetName || '').trim().toLowerCase() === 'all';

  const datasets =
    String(datasetName || '').trim().toLowerCase() === 'all'
      ? storage.listDatasets()
      : [storage.resolveDatasetName(datasetName)];

  const exported = [];

  for (const sheetName of datasets) {
    const rows = await getDatasetRowsFromSource(sheetName, source);
    const exportTab = getGoogleExportTabName(sheetName);
    await googleSheets.replaceSheetData(exportTab, rows);

    exported.push({
      dataset: sheetName,
      sheetName: exportTab,
      rowCount: Math.max(rows.length - 1, 0),
    });
  }

  if (includeDerived) {
    const derivedExports = await buildDerivedGoogleExports(source);

    for (const derived of derivedExports) {
      const exportTab = getGoogleExportTabName(derived.tabName);
      await googleSheets.replaceSheetData(exportTab, derived.rows);

      exported.push({
        dataset: derived.tabName,
        sheetName: exportTab,
        rowCount: Math.max(derived.rows.length - 1, 0),
      });
    }
  }

  return {
    exported,
    spreadsheetUrl: SHEET_ID
      ? `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`
      : null,
  };
}

module.exports = {
  exportCsv,
  exportGoogle,
  exportGoogleSnapshot,
};
