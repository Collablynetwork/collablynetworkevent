// services/storage.js
'use strict';

const sheetStore = require('./sheetStore');
const { appendUser, getRows, appendRow, updateRow, replaceSheetData } = sheetStore;
const { isAdmin } = require('../config');

/* ==========================
   Generic header utilities
   ========================== */

async function ensureSheetHeader(sheetName, wantedHeaders) {
  const rows = await getRows(sheetName);
  const header = rows[0] || [];

  if (rows.length === 0) {
    await appendRow(sheetName, wantedHeaders);
    return;
  }

  const needsFix =
    header.length < wantedHeaders.length ||
    wantedHeaders.some((h, i) => header[i] !== h);

  if (needsFix) {
    await updateRow(sheetName, 0, wantedHeaders);
  }
}

/* --------------------------
   Sheet headers we rely on
   -------------------------- */
const HEADERS = {
  contacts: ['From', 'To', 'Timestamp'],
  requests: ['From', 'To', 'Status', 'Timestamp'],
  approvalKeywords: ['keyword', 'addedAt', 'addedBy'],
  massDmHistory: [
    'senderChatId',
    'batchId',
    'selection',
    'messageText',
    'createdAt',
    'deliveryJson',
  ],
  profileUpdateHistory: ['chatId', 'username', 'editedAt'],
  leadAccess: ['chatId', 'username', 'mode', 'updatedAt'],
  telegramReachability: [
    'chatId',
    'username',
    'status',
    'reason',
    'firstFailedAt',
    'lastFailedAt',
    'failureCount',
    'lastError',
  ],
  eventConnections: [
    'eventId',
    'eventTitle',
    'userAChatId',
    'userBChatId',
    'userAStatus',
    'userBStatus',
    'createdAt',
    'updatedAt',
  ],
  users: [
    'fullName',
    'projectName',
    'xUrl',
    'role',
    'categories',
    'lookingFor',
    'chatId',
    'username',
    'status',
  ],
  NotRegister: ['username', 'chatId', 'registered', 'timestamp', 'lastReminderAt'],
  itinerary: ['eventId', 'chatId', 'status', 'timestamp'],
  events: [
    'eventId',
    'title',
    'description',
    'date',
    'time',
    'location',
    'apply',
    'expiresAt',
  ],
  Leads: [
    'username',
    'categories',
    'lookingFor',
    'xUrl',
    'projectName',
    'chatId',
    'timestamp',
  ],
  blockedUsers: ['chatId', 'username', 'blockedAt', 'blockedBy', 'active'],
};

function normalizeUsername(value) {
  return String(value || '')
    .trim()
    .replace(/^@/, '')
    .toLowerCase();
}

function normalizeApprovalKeyword(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function isAdminContactIdentifier(value) {
  const identifier = String(value || '').trim();
  if (!identifier) return false;
  return isAdmin(identifier, identifier);
}

function normalizeLeadAccessMode(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');

  return normalized === 'incoming_only' ? 'incoming_only' : 'open';
}

function normalizeTelegramReachabilityStatus(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');

  if (!normalized) return 'unreachable';
  if (['blocked', 'blocked_bot', 'bot_blocked', 'botwasblockedbytheuser'].includes(normalized)) {
    return 'blocked_bot';
  }
  if (['deactivated', 'userisdeactivated'].includes(normalized)) {
    return 'deactivated';
  }
  if (
    ['not_found', 'chat_not_found', 'user_not_found', 'chatnotfound'].includes(normalized)
  ) {
    return 'chat_not_found';
  }
  if (['temporary_failure', 'temporary', 'retryable'].includes(normalized)) {
    return 'temporary_failure';
  }
  if (['reachable', 'cleared'].includes(normalized)) {
    return 'reachable';
  }
  return 'unreachable';
}

function humanizeTelegramReachabilityStatus(status) {
  switch (normalizeTelegramReachabilityStatus(status)) {
    case 'blocked_bot':
      return 'bot was blocked by the user';
    case 'deactivated':
      return 'user is deactivated';
    case 'chat_not_found':
      return 'chat not found';
    case 'temporary_failure':
      return 'temporary Telegram failure';
    case 'reachable':
      return 'reachable';
    default:
      return 'Telegram unreachable';
  }
}

const PROFILE_UPDATE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const PROFILE_UPDATE_LIMIT = 2;
const OPEN_REQUEST_STATUSES = new Set(['pending', 'accepted', 'admin_pending']);

function isActiveUserStatus(status) {
  const normalized = String(status || 'active').trim().toLowerCase();
  return !['pause', 'paused', 'mute', 'muted', 'inactive', 'disabled', 'off'].includes(normalized);
}

function normalizeDataRow(row, width) {
  return Array.from({ length: width }, (_, index) =>
    String((Array.isArray(row) ? row[index] : '') || '').trim()
  );
}

function normalizeRequestStatus(value) {
  return String(value || '').trim().toLowerCase();
}

function isOpenRequestStatus(value) {
  return OPEN_REQUEST_STATUSES.has(normalizeRequestStatus(value));
}

function countNonEmptyValues(values = []) {
  return values.reduce((count, value) => count + (String(value || '').trim() ? 1 : 0), 0);
}

function parseIsoTimestamp(value) {
  const raw = String(value || '').trim();
  if (!raw) return 0;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function clusterRowsByIdentity(dataRows, getIdentityKeys) {
  const groups = [];

  for (const row of dataRows) {
    const keys = Array.from(
      new Set((getIdentityKeys(row) || []).map((value) => String(value || '').trim()).filter(Boolean))
    );

    const matchingIndexes = [];
    groups.forEach((group, index) => {
      const matches = keys.some((key) => group.keys.has(key));
      if (matches) {
        matchingIndexes.push(index);
      }
    });

    let targetGroup;
    if (!matchingIndexes.length) {
      targetGroup = { rows: [], keys: new Set() };
      groups.push(targetGroup);
    } else {
      targetGroup = groups[matchingIndexes[0]];
      for (let i = matchingIndexes.length - 1; i >= 1; i -= 1) {
        const merged = groups[matchingIndexes[i]];
        merged.rows.forEach((existingRow) => targetGroup.rows.push(existingRow));
        merged.keys.forEach((key) => targetGroup.keys.add(key));
        groups.splice(matchingIndexes[i], 1);
      }
    }

    targetGroup.rows.push(row);
    keys.forEach((key) => targetGroup.keys.add(key));
  }

  return groups;
}

function pickPreferredUserRow(leftRow, rightRow) {
  if (!leftRow) return rightRow;
  if (!rightRow) return leftRow;

  const left = normalizeDataRow(leftRow, HEADERS.users.length);
  const right = normalizeDataRow(rightRow, HEADERS.users.length);

  const leftScore =
    countNonEmptyValues(left) +
    (left[8].toLowerCase() === 'active' ? 1 : 0) +
    (left[6] ? 2 : 0) +
    (left[7] ? 1 : 0);
  const rightScore =
    countNonEmptyValues(right) +
    (right[8].toLowerCase() === 'active' ? 1 : 0) +
    (right[6] ? 2 : 0) +
    (right[7] ? 1 : 0);

  if (rightScore > leftScore) return right;
  if (rightScore < leftScore) return left;

  return right;
}

function dedupeUserRows(dataRows = []) {
  const rows = dataRows
    .map((row) => normalizeDataRow(row, HEADERS.users.length))
    .filter((row) => row.some((value) => value));

  const groups = clusterRowsByIdentity(rows, (row) => [
    row[6] ? `chat:${row[6]}` : '',
    row[7] ? `username:${normalizeUsername(row[7])}` : '',
  ]);

  return groups
    .map((group) => group.rows.reduce(pickPreferredUserRow, null))
    .filter(Boolean);
}

function pickPreferredNonRegisteredRow(leftRow, rightRow) {
  if (!leftRow) return rightRow;
  if (!rightRow) return leftRow;

  const left = normalizeDataRow(leftRow, HEADERS.NotRegister.length);
  const right = normalizeDataRow(rightRow, HEADERS.NotRegister.length);

  const leftRegistered = String(left[2] || '').toLowerCase() === 'true' ? 1 : 0;
  const rightRegistered = String(right[2] || '').toLowerCase() === 'true' ? 1 : 0;
  if (rightRegistered !== leftRegistered) {
    return rightRegistered > leftRegistered ? right : left;
  }

  const leftReminder = parseIsoTimestamp(left[4]);
  const rightReminder = parseIsoTimestamp(right[4]);
  if (rightReminder !== leftReminder) {
    return rightReminder > leftReminder ? right : left;
  }

  const leftTimestamp = parseIsoTimestamp(left[3]);
  const rightTimestamp = parseIsoTimestamp(right[3]);
  if (rightTimestamp !== leftTimestamp) {
    return rightTimestamp > leftTimestamp ? right : left;
  }

  const leftScore = countNonEmptyValues(left);
  const rightScore = countNonEmptyValues(right);
  if (rightScore > leftScore) return right;
  if (rightScore < leftScore) return left;

  return right;
}

function parseFailureCount(value) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function pickPreferredTelegramReachabilityRow(leftRow, rightRow) {
  if (!leftRow) return rightRow;
  if (!rightRow) return leftRow;

  const left = normalizeDataRow(leftRow, HEADERS.telegramReachability.length);
  const right = normalizeDataRow(rightRow, HEADERS.telegramReachability.length);

  const leftTimestamp = parseIsoTimestamp(left[5] || left[4]);
  const rightTimestamp = parseIsoTimestamp(right[5] || right[4]);
  if (rightTimestamp !== leftTimestamp) {
    return rightTimestamp > leftTimestamp ? right : left;
  }

  const leftFailures = parseFailureCount(left[6]);
  const rightFailures = parseFailureCount(right[6]);
  if (rightFailures !== leftFailures) {
    return rightFailures > leftFailures ? right : left;
  }

  const leftScore = countNonEmptyValues(left);
  const rightScore = countNonEmptyValues(right);
  if (rightScore > leftScore) return right;
  if (rightScore < leftScore) return left;

  return right;
}

function dedupeTelegramReachabilityRows(dataRows = []) {
  const rows = dataRows
    .map((row) => normalizeDataRow(row, HEADERS.telegramReachability.length))
    .filter((row) => row.some((value) => value));

  const groups = clusterRowsByIdentity(rows, (row) => [
    row[0] ? `chat:${row[0]}` : '',
    row[1] ? `username:${normalizeUsername(row[1])}` : '',
  ]);

  return groups
    .map((group) => group.rows.reduce(pickPreferredTelegramReachabilityRow, null))
    .filter(Boolean);
}

function dedupeNonRegisteredRows(dataRows = []) {
  const rows = dataRows
    .map((row) => normalizeDataRow(row, HEADERS.NotRegister.length))
    .filter((row) => row.some((value) => value));

  const groups = clusterRowsByIdentity(rows, (row) => [
    row[1] ? `chat:${row[1]}` : '',
    row[0] ? `username:${normalizeUsername(row[0])}` : '',
  ]);

  return groups
    .map((group) => group.rows.reduce(pickPreferredNonRegisteredRow, null))
    .filter(Boolean);
}

function sanitizeDatasetRows(sheetName, dataRows = []) {
  if (sheetName === 'users') {
    return dedupeUserRows(dataRows);
  }

  if (sheetName === 'NotRegister') {
    return dedupeNonRegisteredRows(dataRows);
  }

  if (sheetName === 'telegramReachability') {
    return dedupeTelegramReachabilityRows(dataRows);
  }

  return Array.isArray(dataRows) ? dataRows : [];
}

function resolveDatasetName(datasetName) {
  const lookup = String(datasetName || '')
    .trim()
    .replace(/[\s_-]+/g, '')
    .toLowerCase();

  const found = Object.keys(HEADERS).find(
    (name) => name.replace(/[\s_-]+/g, '').toLowerCase() === lookup
  );

  if (!found) {
    throw new Error(
      `Unknown dataset "${datasetName}". Available: ${Object.keys(HEADERS).join(', ')}`
    );
  }

  return found;
}

function listDatasets() {
  return Object.keys(HEADERS);
}

function normalizeBool(value) {
  return String(value).toLowerCase() === 'true';
}

function normalizeEventConnectionPair(chatIdA, chatIdB) {
  const a = String(chatIdA || '').trim();
  const b = String(chatIdB || '').trim();

  if (!a || !b || a === b) {
    return null;
  }

  return [a, b].sort((left, right) =>
    left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' })
  );
}

function parseEventConnectionRow(row = []) {
  return {
    eventId: String(row[0] || ''),
    eventTitle: String(row[1] || ''),
    userAChatId: String(row[2] || ''),
    userBChatId: String(row[3] || ''),
    userAStatus: String(row[4] || 'pending'),
    userBStatus: String(row[5] || 'pending'),
    createdAt: String(row[6] || ''),
    updatedAt: String(row[7] || ''),
  };
}

function toEventConnectionRow(connection) {
  return [
    connection.eventId || '',
    connection.eventTitle || '',
    connection.userAChatId || '',
    connection.userBChatId || '',
    connection.userAStatus || 'pending',
    connection.userBStatus || 'pending',
    connection.createdAt || '',
    connection.updatedAt || '',
  ];
}

function parseEventDateFlexible(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  const match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (match) {
    const day = Number(match[1]);
    const month = Number(match[2]) - 1;
    const year = Number(match[3]);
    const date = new Date(year, month, day, 23, 59, 59, 999);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const isoDateOnly = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoDateOnly) {
    const year = Number(isoDateOnly[1]);
    const month = Number(isoDateOnly[2]) - 1;
    const day = Number(isoDateOnly[3]);
    const date = new Date(year, month, day, 23, 59, 59, 999);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const native = new Date(raw);
  if (Number.isNaN(native.getTime())) return null;

  return native;
}

async function replaceDatasetRows(sheetName, dataRows) {
  const header = HEADERS[sheetName];
  if (!header) {
    throw new Error(`Unknown dataset "${sheetName}"`);
  }

  const sanitizedRows = sanitizeDatasetRows(sheetName, dataRows);
  await replaceSheetData(sheetName, [header, ...sanitizedRows]);
}

async function getDatasetRows(datasetName) {
  const sheetName = resolveDatasetName(datasetName);
  await ensureSheetHeader(sheetName, HEADERS[sheetName]);
  return getRows(sheetName);
}

async function ensureApprovalKeywordsSeeded() {
  const rows = await getRows('approvalKeywords');
  const header = rows[0] || [];

  if (rows.length === 0) {
    await appendRow('approvalKeywords', HEADERS.approvalKeywords);
    await appendRow('approvalKeywords', [
      'CEX',
      new Date().toISOString(),
      'system',
    ]);
    return;
  }

  const needsFix =
    header.length < HEADERS.approvalKeywords.length ||
    HEADERS.approvalKeywords.some((name, index) => header[index] !== name);

  if (needsFix) {
    await updateRow('approvalKeywords', 0, HEADERS.approvalKeywords);
  }
}

/* ==========================
   Contacts
   ========================== */

async function saveContact(contact) {
  await ensureSheetHeader('contacts', HEADERS.contacts);

  let fromId = '';
  let toId = '';
  let ts = new Date().toISOString();

  if (Array.isArray(contact)) {
    fromId = String(contact[0] || '');
    toId = String(contact[1] || '');
    ts = String(contact[2] || ts);
  } else if (contact && typeof contact === 'object') {
    fromId = String(contact.user ?? contact.from ?? contact.From ?? '');
    toId = String(
      contact.contactId ?? contact.contactName ?? contact.to ?? contact.To ?? ''
    );
    ts = String(contact.timestamp ?? contact.ts ?? ts);
  }

  if (!fromId || !toId) {
    console.warn('saveContact: missing from/to → SKIP', { fromId, toId, ts });
    return;
  }

  if (isAdminContactIdentifier(fromId) || isAdminContactIdentifier(toId)) {
    console.warn('saveContact: admin relationship ignored → SKIP', { fromId, toId, ts });
    return;
  }

  await appendRow('contacts', [fromId, toId, ts]);
}

async function getContacts() {
  await ensureSheetHeader('contacts', HEADERS.contacts);
  const rows = await getRows('contacts');
  const data = rows.slice(1);

  const contacts = data
    .map((r) => [String(r[0] || ''), String(r[1] || ''), String(r[2] || '')])
    .filter(([from, to]) => from && to);

  const filteredContacts = contacts.filter(
    ([from, to]) =>
      !isAdminContactIdentifier(from) &&
      !isAdminContactIdentifier(to)
  );

  if (filteredContacts.length !== contacts.length) {
    await replaceSheetData('contacts', [HEADERS.contacts, ...filteredContacts]);
  }

  return filteredContacts;
}

async function getContactsFor(chatId) {
  const me = String(chatId);
  const contacts = await getContacts();

  return contacts
    .map(([from, to, timestamp]) => ({
      from,
      to,
      contactId: from === me ? to : from,
      timestamp,
    }))
    .filter((row) => row.from === me || row.to === me);
}

async function getApprovalKeywords() {
  await ensureApprovalKeywordsSeeded();
  const rows = await getRows('approvalKeywords');

  return rows
    .slice(1)
    .map((row) => ({
      keyword: String(row[0] || '').trim(),
      addedAt: String(row[1] || ''),
      addedBy: String(row[2] || ''),
    }))
    .filter((row) => row.keyword);
}

async function addApprovalKeyword(keyword, addedBy = '') {
  await ensureApprovalKeywordsSeeded();
  const normalized = normalizeApprovalKeyword(keyword);
  if (!normalized) {
    throw new Error('Approval keyword is required.');
  }

  const existing = await getApprovalKeywords();
  const found = existing.find(
    (row) => normalizeApprovalKeyword(row.keyword) === normalized
  );
  if (found) {
    return { keyword: found.keyword, addedAt: found.addedAt, addedBy: found.addedBy, created: false };
  }

  const row = [
    String(keyword || '').trim().replace(/\s+/g, ' '),
    new Date().toISOString(),
    String(addedBy || ''),
  ];
  await appendRow('approvalKeywords', row);

  return {
    keyword: row[0],
    addedAt: row[1],
    addedBy: row[2],
    created: true,
  };
}

async function removeApprovalKeyword(keyword) {
  await ensureApprovalKeywordsSeeded();
  const normalized = normalizeApprovalKeyword(keyword);
  if (!normalized) {
    throw new Error('Approval keyword is required.');
  }

  const keywords = await getApprovalKeywords();
  const remaining = keywords.filter(
    (row) => normalizeApprovalKeyword(row.keyword) !== normalized
  );

  await replaceDatasetRows(
    'approvalKeywords',
    remaining.map((row) => [row.keyword, row.addedAt, row.addedBy])
  );

  return { removed: keywords.length - remaining.length };
}

async function hasContactBetween(chatIdA, chatIdB) {
  const a = String(chatIdA || '');
  const b = String(chatIdB || '');
  if (!a || !b) return false;

  const contacts = await getContacts();
  return contacts.some(([from, to]) => {
    return (
      (String(from) === a && String(to) === b) ||
      (String(from) === b && String(to) === a)
    );
  });
}

async function removeContactRelationship(chatIdA, chatIdB) {
  await ensureSheetHeader('contacts', HEADERS.contacts);

  const left = String(chatIdA || '').trim();
  const right = String(chatIdB || '').trim();
  if (!left || !right) {
    return { removed: 0 };
  }

  const rows = await getRows('contacts');
  const [header, ...data] = rows;
  const remaining = data.filter((row) => {
    const from = String(row[0] || '').trim();
    const to = String(row[1] || '').trim();

    return !(
      (from === left && to === right) ||
      (from === right && to === left)
    );
  });

  await replaceSheetData('contacts', [header, ...remaining]);

  return {
    removed: data.length - remaining.length,
  };
}

async function removeOpenRequestsBetween(chatIdA, chatIdB) {
  await ensureSheetHeader('requests', HEADERS.requests);

  const left = String(chatIdA || '').trim();
  const right = String(chatIdB || '').trim();
  if (!left || !right) {
    return { removed: 0 };
  }

  const rows = await getRows('requests');
  const [header, ...data] = rows;
  const remaining = data.filter((row) => {
    const from = String(row[0] || '').trim();
    const to = String(row[1] || '').trim();
    const status = normalizeRequestStatus(row[2]);
    const isPair =
      (from === left && to === right) ||
      (from === right && to === left);

    return !(isPair && isOpenRequestStatus(status));
  });

  await replaceSheetData('requests', [header, ...remaining]);

  return {
    removed: data.length - remaining.length,
  };
}

async function clearMatchRelationship(chatIdA, chatIdB) {
  const [contactsResult, requestsResult] = await Promise.all([
    removeContactRelationship(chatIdA, chatIdB),
    removeOpenRequestsBetween(chatIdA, chatIdB),
  ]);

  return {
    removedContacts: Number(contactsResult?.removed || 0),
    removedRequests: Number(requestsResult?.removed || 0),
  };
}

/* ==========================
   Requests
   ========================== */

async function saveRequest(request) {
  await ensureSheetHeader('requests', HEADERS.requests);

  let from = '';
  let to = '';
  let status = 'pending';
  let ts = new Date().toISOString();

  if (Array.isArray(request)) {
    [from, to, status, ts] = [
      String(request[0] || ''),
      String(request[1] || ''),
      String(request[2] || 'pending'),
      String(request[3] || ts),
    ];
  } else if (request && typeof request === 'object') {
    from = String(request.from || request.user || '');
    to = String(request.to || request.contactId || request.contactName || '');
    status = String(request.status || 'pending');
    ts = String(request.timestamp || ts);
  }

  if (!from || !to) {
    console.warn('saveRequest: missing from/to → SKIP', {
      from,
      to,
      status,
      ts,
    });
    return;
  }

  await appendRow('requests', [from, to, status, ts]);
}

async function getRequests() {
  await ensureSheetHeader('requests', HEADERS.requests);
  const rows = await getRows('requests');
  const data = rows.slice(1);

  return data.map((r) => ({
    from: String(r[0] || ''),
    to: String(r[1] || ''),
    status: String(r[2] || ''),
    timestamp: String(r[3] || ''),
  }));
}

async function getRequestsBetween(chatIdA, chatIdB) {
  const left = String(chatIdA || '').trim();
  const right = String(chatIdB || '').trim();
  if (!left || !right) return [];

  const requests = await getRequests();
  return requests
    .filter((request) => {
      const from = String(request.from || '').trim();
      const to = String(request.to || '').trim();
      return (
        (from === left && to === right) ||
        (from === right && to === left)
      );
    })
    .sort(
      (a, b) => parseIsoTimestamp(b.timestamp) - parseIsoTimestamp(a.timestamp)
    );
}

async function getLatestRequestBetween(chatIdA, chatIdB) {
  const requests = await getRequestsBetween(chatIdA, chatIdB);
  return requests[0] || null;
}

async function hasOpenRequestBetween(chatIdA, chatIdB, statuses = Array.from(OPEN_REQUEST_STATUSES)) {
  const allowedStatuses = new Set(
    (Array.isArray(statuses) ? statuses : [])
      .map(normalizeRequestStatus)
      .filter(Boolean)
  );
  const requests = await getRequestsBetween(chatIdA, chatIdB);
  return requests.some((request) => allowedStatuses.has(normalizeRequestStatus(request.status)));
}

async function updateRequestStatus(from, to, newStatus) {
  await ensureSheetHeader('requests', HEADERS.requests);
  const rows = await getRows('requests');
  const fromStr = String(from);
  const toStr = String(to);

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const rFrom = String(r[0] || '');
    const rTo = String(r[1] || '');
    if (rFrom === fromStr && rTo === toStr) {
      const existingTs = r[3] || new Date().toISOString();
      return updateRow('requests', i, [
        fromStr,
        toStr,
        String(newStatus),
        existingTs,
      ]);
    }
  }

  throw new Error(`Request row not found for from=${fromStr}, to=${toStr}`);
}

async function upsertRequestStatus(from, to, newStatus, timestamp = new Date().toISOString()) {
  await ensureSheetHeader('requests', HEADERS.requests);
  const rows = await getRows('requests');
  const fromStr = String(from || '').trim();
  const toStr = String(to || '').trim();
  const status = String(newStatus || '').trim();
  const ts = String(timestamp || new Date().toISOString());

  if (!fromStr || !toStr) {
    throw new Error('Both from and to are required to upsert a request.');
  }

  for (let i = rows.length - 1; i >= 1; i -= 1) {
    const row = rows[i] || [];
    if (String(row[0] || '').trim() !== fromStr) continue;
    if (String(row[1] || '').trim() !== toStr) continue;

    const existingTimestamp = String(row[3] || '').trim() || ts;
    await updateRow('requests', i, [fromStr, toStr, status, existingTimestamp]);
    return {
      from: fromStr,
      to: toStr,
      status,
      timestamp: existingTimestamp,
      updated: true,
    };
  }

  await appendRow('requests', [fromStr, toStr, status, ts]);
  return {
    from: fromStr,
    to: toStr,
    status,
    timestamp: ts,
    updated: false,
  };
}

async function getPendingRequests(forUser) {
  await ensureSheetHeader('requests', HEADERS.requests);
  const rows = await getRows('requests');
  const data = rows.slice(1);
  const forStr = String(forUser);

  return data
    .map((r) => ({
      from: String(r[0] || ''),
      to: String(r[1] || ''),
      status: String(r[2] || ''),
      timestamp: String(r[3] || ''),
    }))
    .filter((r) => r.to === forStr && r.status === 'pending');
}

/* ==========================
   Users
   ========================== */

async function markUserAsRegistered(chatId, username) {
  await ensureSheetHeader('NotRegister', HEADERS.NotRegister);

  const rows = await getRows('NotRegister');
  const matches = rows
    .slice(1)
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => String(row[1]) === String(chatId));

  if (!matches.length) {
    return;
  }

  const dedupedRows = dedupeNonRegisteredRows(
    rows.slice(1).map((row) => {
      if (String(row[1]) !== String(chatId)) return row;
      return [
        username,
        String(chatId),
        true,
        row[3] || new Date().toISOString(),
        row[4] || '',
      ];
    })
  );

  await replaceDatasetRows('NotRegister', dedupedRows);
}

async function markNonRegisteredReminderSent(chatId, reminderTimestamp = new Date().toISOString()) {
  await ensureSheetHeader('NotRegister', HEADERS.NotRegister);

  const rows = await getRows('NotRegister');
  const rowIndexInData = rows
    .slice(1)
    .findIndex((r) => String(r[1]) === String(chatId));

  if (rowIndexInData === -1) {
    return;
  }

  const spreadsheetRowIdx = rowIndexInData + 1;
  const row = rows[spreadsheetRowIdx] || [];

  await updateRow('NotRegister', spreadsheetRowIdx, [
    row[0] || '',
    String(chatId),
    String(row[2]).toLowerCase() === 'true',
    row[3] || new Date().toISOString(),
    String(reminderTimestamp || ''),
  ]);
}

async function saveUser(profileRowArray) {
  await ensureSheetHeader('users', HEADERS.users);
  const normalizedRow = normalizeDataRow(profileRowArray, HEADERS.users.length);
  const rows = await getRows('users');
  const dataRows = rows.slice(1);
  const targetChatId = String(normalizedRow[6] || '').trim();
  const targetUsername = normalizeUsername(normalizedRow[7]);

  const existingIndex = dataRows.findIndex((row) => {
    const rowChatId = String(row[6] || '').trim();
    const rowUsername = normalizeUsername(row[7]);
    return (
      (targetChatId && rowChatId === targetChatId) ||
      (targetUsername && rowUsername === targetUsername)
    );
  });

  if (existingIndex >= 0) {
    const currentRow = normalizeDataRow(dataRows[existingIndex], HEADERS.users.length);
    const preferredRow = pickPreferredUserRow(currentRow, normalizedRow);
    await updateRow('users', existingIndex + 1, preferredRow);
  } else {
    await appendUser(normalizedRow);
  }

  await markUserAsRegistered(profileRowArray[6], profileRowArray[7]);
}

async function getUsers() {
  await ensureSheetHeader('users', HEADERS.users);
  const rows = await getRows('users');
  if (rows.length === 0) return [];

  const [header, ...data] = rows;
  const indexOf = (name, fallbackIdx) => {
    const idx = header.findIndex((h) => String(h).trim() === name);
    return idx >= 0 ? idx : fallbackIdx;
  };

  const idx = {
    fullName: indexOf('fullName', 0),
    projectName: indexOf('projectName', 1),
    xUrl: indexOf('xUrl', 2),
    role: indexOf('role', 3),
    categories: indexOf('categories', 4),
    lookingFor: indexOf('lookingFor', 5),
    chatId: indexOf('chatId', 6),
    username: indexOf('username', 7),
    status: indexOf('status', 8),
  };

  return data.map((r) => ({
    fullName: r[idx.fullName] || '',
    projectName: r[idx.projectName] || '',
    xUrl: r[idx.xUrl] || '',
    role: r[idx.role] || '',
    categories: String(r[idx.categories] || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    lookingFor: String(r[idx.lookingFor] || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    chatId: parseInt(r[idx.chatId], 10),
    username: r[idx.username] || '',
    status: r[idx.status] || 'active',
    registered: true,
  }));
}

async function getNonRegisteredUsers() {
  await ensureSheetHeader('NotRegister', HEADERS.NotRegister);
  const rows = await getRows('NotRegister');

  return rows
    .slice(1)
    .map((r) => ({
      username: r[0] || '',
      chatId: r[1] || '',
      registered: String(r[2]).toLowerCase() === 'true',
      timestamp: r[3] || '',
      lastReminderAt: r[4] || '',
    }))
    .filter((r) => !r.registered);
}

async function getKnownUsers() {
  const [users, nonUsers] = await Promise.all([
    getUsers(),
    getNonRegisteredUsers(),
  ]);

  const known = new Map();

  for (const user of users) {
    known.set(String(user.chatId), {
      ...user,
      chatId: String(user.chatId),
      registered: true,
    });
  }

  for (const user of nonUsers) {
    const chatId = String(user.chatId || '');
    if (!chatId || known.has(chatId)) continue;

    known.set(chatId, {
      fullName: '',
      projectName: '',
      xUrl: '',
      role: '',
      categories: [],
      lookingFor: [],
      chatId,
      username: user.username || '',
      status: 'active',
      registered: false,
      timestamp: user.timestamp || '',
      lastReminderAt: user.lastReminderAt || '',
    });
  }

  return Array.from(known.values());
}

async function findKnownUser(identifier) {
  const lookup = String(identifier || '').trim();
  if (!lookup) return null;

  const users = await getKnownUsers();
  if (/^-?\d+$/.test(lookup)) {
    return users.find((u) => String(u.chatId) === lookup) || null;
  }

  const normalized = normalizeUsername(lookup);
  return (
    users.find((u) => normalizeUsername(u.username) === normalized) || null
  );
}

function parseProfileUpdateHistoryRow(row = []) {
  const normalized = normalizeDataRow(row, HEADERS.profileUpdateHistory.length);
  return {
    chatId: String(normalized[0] || ''),
    username: String(normalized[1] || ''),
    editedAt: String(normalized[2] || ''),
  };
}

function toProfileUpdateHistoryRow(entry = {}) {
  return [
    String(entry.chatId || ''),
    String(entry.username || ''),
    String(entry.editedAt || ''),
  ];
}

function parseMassDmHistoryRow(row = []) {
  const normalized = normalizeDataRow(row, HEADERS.massDmHistory.length);
  let deliveries = [];

  if (normalized[5]) {
    try {
      const parsed = JSON.parse(normalized[5]);
      deliveries = Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      deliveries = [];
    }
  }

  return {
    senderChatId: String(normalized[0] || ''),
    batchId: String(normalized[1] || ''),
    selection: String(normalized[2] || ''),
    messageText: String(normalized[3] || ''),
    createdAt: String(normalized[4] || ''),
    deliveries: deliveries
      .map((entry) => ({
        chatId: String(entry?.chatId || ''),
        messageId: Number(entry?.messageId || 0),
      }))
      .filter((entry) => entry.chatId && Number.isFinite(entry.messageId) && entry.messageId > 0),
  };
}

function toMassDmHistoryRow(entry = {}) {
  return [
    String(entry.senderChatId || ''),
    String(entry.batchId || ''),
    String(entry.selection || ''),
    String(entry.messageText || ''),
    String(entry.createdAt || ''),
    JSON.stringify(
      Array.isArray(entry.deliveries)
        ? entry.deliveries.map((delivery) => ({
            chatId: String(delivery?.chatId || ''),
            messageId: Number(delivery?.messageId || 0),
          }))
        : []
    ),
  ];
}

async function getProfileUpdateHistory(identifier = '', username = '') {
  await ensureSheetHeader('profileUpdateHistory', HEADERS.profileUpdateHistory);
  const rows = await getRows('profileUpdateHistory');
  const chatId = String(identifier || '').trim();
  const normalizedUsername = normalizeUsername(username);

  return rows
    .slice(1)
    .map(parseProfileUpdateHistoryRow)
    .filter((row) => {
      if (!chatId && !normalizedUsername) return true;
      return (
        (chatId && String(row.chatId || '').trim() === chatId) ||
        (normalizedUsername &&
          normalizeUsername(row.username) === normalizedUsername)
      );
    })
    .sort(
      (left, right) =>
        parseIsoTimestamp(right.editedAt) - parseIsoTimestamp(left.editedAt)
    );
}

async function getProfileEditAllowance(identifier, username = '') {
  const knownUser =
    identifier && typeof identifier === 'object'
      ? identifier
      : await findKnownUser(identifier);
  const chatId = String(
    knownUser?.chatId ||
      (identifier && typeof identifier === 'object' ? identifier.chatId || '' : identifier || '')
  ).trim();
  const normalizedUsername = normalizeUsername(
    knownUser?.username ||
      (identifier && typeof identifier === 'object' ? identifier.username || '' : username || '')
  );
  const now = Date.now();
  const windowStart = now - PROFILE_UPDATE_WINDOW_MS;
  const history = await getProfileUpdateHistory(chatId, normalizedUsername);
  const recentUpdates = history.filter(
    (entry) => parseIsoTimestamp(entry.editedAt) >= windowStart
  );
  const usedCount = recentUpdates.length;
  const remaining = Math.max(PROFILE_UPDATE_LIMIT - usedCount, 0);
  const oldestRelevantUpdate =
    recentUpdates.length === PROFILE_UPDATE_LIMIT
      ? recentUpdates.reduce((oldest, entry) => {
          if (!oldest) return entry;
          return parseIsoTimestamp(entry.editedAt) < parseIsoTimestamp(oldest.editedAt)
            ? entry
            : oldest;
        }, null)
      : null;
  const nextAvailableAt = oldestRelevantUpdate
    ? new Date(parseIsoTimestamp(oldestRelevantUpdate.editedAt) + PROFILE_UPDATE_WINDOW_MS).toISOString()
    : null;

  return {
    ok: remaining > 0,
    limit: PROFILE_UPDATE_LIMIT,
    windowDays: 30,
    usedCount,
    remaining,
    nextAvailableAt,
    recentUpdates,
  };
}

async function getMassDmHistory(senderChatId = '') {
  await ensureSheetHeader('massDmHistory', HEADERS.massDmHistory);
  const rows = await getRows('massDmHistory');
  const sender = String(senderChatId || '').trim();

  return rows
    .slice(1)
    .map(parseMassDmHistoryRow)
    .filter((row) => !sender || row.senderChatId === sender)
    .sort(
      (left, right) =>
        parseIsoTimestamp(right.createdAt) - parseIsoTimestamp(left.createdAt)
    );
}

async function getLastMassDmBatch(senderChatId) {
  const rows = await getMassDmHistory(senderChatId);
  return rows[0] || null;
}

async function saveLastMassDmBatch(entry = {}) {
  await ensureSheetHeader('massDmHistory', HEADERS.massDmHistory);
  const senderChatId = String(entry.senderChatId || '').trim();
  if (!senderChatId) {
    throw new Error('senderChatId is required to save mass DM history.');
  }

  const history = await getMassDmHistory();
  const next = history.filter((row) => row.senderChatId !== senderChatId);
  next.push({
    senderChatId,
    batchId: String(entry.batchId || `massdm_${Date.now()}`),
    selection: String(entry.selection || ''),
    messageText: String(entry.messageText || ''),
    createdAt: String(entry.createdAt || new Date().toISOString()),
    deliveries: Array.isArray(entry.deliveries) ? entry.deliveries : [],
  });

  await replaceDatasetRows(
    'massDmHistory',
    next.map((row) => toMassDmHistoryRow(row))
  );

  return getLastMassDmBatch(senderChatId);
}

async function updateLastMassDmBatch(senderChatId, updates = {}) {
  await ensureSheetHeader('massDmHistory', HEADERS.massDmHistory);
  const sender = String(senderChatId || '').trim();
  if (!sender) {
    throw new Error('senderChatId is required to update mass DM history.');
  }

  const history = await getMassDmHistory();
  const next = [];
  let updatedRow = null;

  for (const row of history) {
    if (row.senderChatId !== sender) {
      next.push(row);
      continue;
    }

    const merged = {
      ...row,
      ...updates,
      senderChatId: sender,
    };

    if (Array.isArray(merged.deliveries) && merged.deliveries.length) {
      next.push(merged);
      updatedRow = merged;
    }
  }

  await replaceDatasetRows(
    'massDmHistory',
    next.map((row) => toMassDmHistoryRow(row))
  );

  return updatedRow;
}

async function clearLastMassDmBatch(senderChatId) {
  await ensureSheetHeader('massDmHistory', HEADERS.massDmHistory);
  const sender = String(senderChatId || '').trim();
  const history = await getMassDmHistory();
  const remaining = history.filter((row) => row.senderChatId !== sender);

  await replaceDatasetRows(
    'massDmHistory',
    remaining.map((row) => toMassDmHistoryRow(row))
  );

  return { removed: history.length - remaining.length };
}

async function recordProfileUpdate(identifier, username = '', editedAt = new Date().toISOString()) {
  await ensureSheetHeader('profileUpdateHistory', HEADERS.profileUpdateHistory);

  const knownUser =
    identifier && typeof identifier === 'object'
      ? identifier
      : await findKnownUser(identifier);
  const chatId = String(
    knownUser?.chatId ||
      (identifier && typeof identifier === 'object' ? identifier.chatId || '' : identifier || '')
  ).trim();
  const normalizedUsername = normalizeUsername(
    knownUser?.username ||
      (identifier && typeof identifier === 'object' ? identifier.username || '' : username || '')
  );

  if (!chatId && !normalizedUsername) {
    throw new Error('A chat id or username is required to record a profile update.');
  }

  const row = toProfileUpdateHistoryRow({
    chatId,
    username: normalizedUsername,
    editedAt,
  });

  await appendRow('profileUpdateHistory', row);
  return parseProfileUpdateHistoryRow(row);
}

async function getLeadAccess(identifier = '', username = '') {
  await ensureSheetHeader('leadAccess', HEADERS.leadAccess);
  const rows = await getRows('leadAccess');
  const chatId = String(
    identifier && typeof identifier === 'object' ? identifier.chatId || '' : identifier || ''
  ).trim();
  const normalizedUsername = normalizeUsername(
    identifier && typeof identifier === 'object'
      ? identifier.username || username || ''
      : username || ''
  );

  const match = rows
    .slice(1)
    .map((row) => normalizeDataRow(row, HEADERS.leadAccess.length))
    .find((row) => {
      const rowChatId = String(row[0] || '').trim();
      const rowUsername = normalizeUsername(row[1]);
      return (
        (chatId && rowChatId === chatId) ||
        (normalizedUsername && rowUsername === normalizedUsername)
      );
    });

  if (!match) {
    return {
      chatId,
      username: normalizedUsername,
      mode: 'open',
      updatedAt: '',
    };
  }

  return {
    chatId: String(match[0] || ''),
    username: String(match[1] || ''),
    mode: normalizeLeadAccessMode(match[2]),
    updatedAt: String(match[3] || ''),
  };
}

async function setLeadAccessMode(identifier, mode = 'open', username = '') {
  await ensureSheetHeader('leadAccess', HEADERS.leadAccess);
  const knownUser =
    identifier && typeof identifier === 'object'
      ? identifier
      : await findKnownUser(identifier);

  const chatId = String(
    knownUser?.chatId ||
      (identifier && typeof identifier === 'object' ? identifier.chatId || '' : identifier || '')
  ).trim();
  const normalizedUsername = normalizeUsername(
    knownUser?.username ||
      (identifier && typeof identifier === 'object' ? identifier.username || username || '' : username || '')
  );

  if (!chatId && !normalizedUsername) {
    throw new Error('A chat id or username is required to set lead access mode.');
  }

  const nextMode = normalizeLeadAccessMode(mode);
  const updatedAt = new Date().toISOString();
  const rows = await getRows('leadAccess');
  const nextRows = rows.slice(1).map((row) => normalizeDataRow(row, HEADERS.leadAccess.length));
  const index = nextRows.findIndex((row) => {
    const rowChatId = String(row[0] || '').trim();
    const rowUsername = normalizeUsername(row[1]);
    return (
      (chatId && rowChatId === chatId) ||
      (normalizedUsername && rowUsername === normalizedUsername)
    );
  });

  const nextRow = [chatId, normalizedUsername, nextMode, updatedAt];
  if (index >= 0) {
    nextRows[index] = nextRow;
  } else {
    nextRows.push(nextRow);
  }

  await replaceDatasetRows('leadAccess', nextRows);

  return {
    chatId,
    username: normalizedUsername,
    mode: nextMode,
    updatedAt,
  };
}

async function canAttemptUserContact(identifier, username = '') {
  const user =
    identifier && typeof identifier === 'object'
      ? identifier
      : await findKnownUser(identifier);

  const rawIdentifier =
    identifier && typeof identifier === 'object'
      ? String(identifier.chatId || '')
      : String(identifier || '').trim();
  const rawUsername =
    identifier && typeof identifier === 'object'
      ? String(identifier.username || username || '')
      : String(username || '').trim();

  if (!user) {
    const unreachable = await getTelegramUnreachableUser(rawIdentifier, rawUsername);
    if (unreachable) {
      return { ok: false, reason: 'unreachable', user: null, unreachable };
    }

    return { ok: false, reason: 'missing', user: null };
  }

  const chatId = String(user.chatId || identifier || '').trim();
  const candidateUsername = String(user.username || username || '').trim();

  if (await isBlockedUser(chatId, candidateUsername)) {
    return { ok: false, reason: 'blocked', user };
  }

  if (user.registered !== false && !isActiveUserStatus(user.status)) {
    return { ok: false, reason: 'inactive', user };
  }

  const unreachable = await getTelegramUnreachableUser(chatId, candidateUsername);
  if (unreachable) {
    return { ok: false, reason: 'unreachable', user, unreachable };
  }

  return { ok: true, reason: 'ok', user };
}

async function getSingleUser(chatId) {
  const users = await getUsers();
  return users.find((u) => Number(u.chatId) === Number(chatId));
}

async function updateUser(rowArray) {
  await ensureSheetHeader('users', HEADERS.users);
  const rows = await getRows('users');
  if (rows.length === 0) {
    throw new Error('Users sheet empty');
  }

  const headers = rows[0].map((h) => String(h).trim());
  const chatIdCol = headers.indexOf('chatId');
  if (chatIdCol < 0) {
    throw new Error('"chatId" column not found in header');
  }

  const targetChatId = String(rowArray[chatIdCol]).trim();
  const rowIndex = rows.findIndex((r, idx) => {
    if (idx === 0) return false;
    return String(r[chatIdCol] || '').trim() === targetChatId;
  });

  if (rowIndex < 1) {
    throw new Error(`User row not found for chatId=${targetChatId}`);
  }

  await updateRow('users', rowIndex, normalizeDataRow(rowArray, HEADERS.users.length));
  await dedupeStoredUsers();
}

async function isRegistered(chatId) {
  const users = await getUsers();
  return users.some((u) => Number(u.chatId) === Number(chatId));
}

/* ==========================
   Events / Itinerary / NonUser
   ========================== */

async function getEvents() {
  await ensureSheetHeader('events', HEADERS.events);
  const rows = await getRows('events');
  if (!rows.length) return [];

  const [header, ...data] = rows;
  const indexOf = (name, fallbackIdx) => {
    const idx = header.findIndex((h) => String(h).trim() === name);
    return idx >= 0 ? idx : fallbackIdx;
  };

  const idx = {
    eventId: indexOf('eventId', 0),
    title: indexOf('title', 1),
    description: indexOf('description', 2),
    date: indexOf('date', 3),
    time: indexOf('time', 4),
    location: indexOf('location', 5),
    apply: indexOf('apply', 6),
    expiresAt: indexOf('expiresAt', 7),
  };

  const parsed = data.map((r) => ({
    eventId: String(r[idx.eventId] || ''),
    title: r[idx.title] || '',
    description: r[idx.description] || '',
    date: r[idx.date] || '',
    time: r[idx.time] || '',
    location: r[idx.location] || '',
    apply: r[idx.apply] || '',
    expiresAt: r[idx.expiresAt] || '',
  }));

  const { activeEvents } = await purgeExpiredEvents(parsed);
  return activeEvents;
}

async function getAllItineraryEntries() {
  await ensureSheetHeader('itinerary', HEADERS.itinerary);
  const rows = await getRows('itinerary');

  return rows
    .slice(1)
    .map((r) => ({
      eventId: String(r[0] || ''),
      chatId: String(r[1] || ''),
      status: String(r[2] || ''),
      timestamp: String(r[3] || ''),
    }))
    .filter((row) => row.eventId && row.chatId);
}

async function cleanupEventScopedData(eventIds) {
  const ids = Array.from(
    new Set(
      (Array.isArray(eventIds) ? eventIds : [])
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    )
  );

  if (!ids.length) {
    return { removedItineraryRows: 0, removedEventConnectionRows: 0 };
  }

  const eventIdSet = new Set(ids);

  await ensureSheetHeader('itinerary', HEADERS.itinerary);
  const itineraryRows = await getRows('itinerary');
  const [itineraryHeader, ...itineraryData] = itineraryRows;
  const keptItineraryRows = itineraryData.filter(
    (row) => !eventIdSet.has(String(row[0] || '').trim())
  );
  const removedItineraryRows = itineraryData.length - keptItineraryRows.length;
  await replaceSheetData('itinerary', [itineraryHeader, ...keptItineraryRows]);

  await ensureSheetHeader('eventConnections', HEADERS.eventConnections);
  const eventConnectionRows = await getRows('eventConnections');
  const [eventConnectionHeader, ...eventConnectionData] = eventConnectionRows;
  const keptEventConnectionRows = eventConnectionData.filter(
    (row) => !eventIdSet.has(String(row[0] || '').trim())
  );
  const removedEventConnectionRows =
    eventConnectionData.length - keptEventConnectionRows.length;
  await replaceSheetData('eventConnections', [
    eventConnectionHeader,
    ...keptEventConnectionRows,
  ]);

  return { removedItineraryRows, removedEventConnectionRows };
}

async function getAllEvents() {
  await ensureSheetHeader('events', HEADERS.events);
  const rows = await getRows('events');
  if (!rows.length) return [];

  const [header, ...data] = rows;
  const indexOf = (name, fallbackIdx) => {
    const idx = header.findIndex((h) => String(h).trim() === name);
    return idx >= 0 ? idx : fallbackIdx;
  };

  const idx = {
    eventId: indexOf('eventId', 0),
    title: indexOf('title', 1),
    description: indexOf('description', 2),
    date: indexOf('date', 3),
    time: indexOf('time', 4),
    location: indexOf('location', 5),
    apply: indexOf('apply', 6),
    expiresAt: indexOf('expiresAt', 7),
  };

  return data.map((r) => ({
    eventId: String(r[idx.eventId] || ''),
    title: r[idx.title] || '',
    description: r[idx.description] || '',
    date: r[idx.date] || '',
    time: r[idx.time] || '',
    location: r[idx.location] || '',
    apply: r[idx.apply] || '',
    expiresAt: r[idx.expiresAt] || '',
  }));
}

function isEventExpired(event) {
  const effectiveExpiry = parseEventDateFlexible(event.expiresAt || event.date);
  return Boolean(effectiveExpiry && effectiveExpiry.getTime() < Date.now());
}

async function purgeExpiredEvents(existingEvents = null) {
  const events = Array.isArray(existingEvents) ? existingEvents : await getAllEvents();
  const activeEvents = events.filter((event) => !isEventExpired(event));
  const removedEventIds = events
    .filter((event) => isEventExpired(event))
    .map((event) => String(event.eventId || '').trim())
    .filter(Boolean);

  if (activeEvents.length !== events.length) {
    await replaceDatasetRows(
      'events',
      activeEvents.map((event) => [
        event.eventId,
        event.title,
        event.description,
        event.date,
        event.time,
        event.location,
        event.apply,
        event.expiresAt || '',
      ])
    );
    await cleanupEventScopedData(removedEventIds);
  }

  return {
    activeEvents,
    removedCount: events.length - activeEvents.length,
  };
}

async function saveEvent(event) {
  await ensureSheetHeader('events', HEADERS.events);
  await appendRow('events', [
    String(event.eventId || ''),
    event.title || '',
    event.description || '',
    event.date || '',
    event.time || '',
    event.location || '',
    event.apply || '',
    event.expiresAt || '',
  ]);
}

async function removeEvent(identifier) {
  const lookup = String(identifier || '').trim().toLowerCase();
  if (!lookup) return { removed: 0 };

  const events = await getAllEvents();
  const removedEventIds = [];
  const remaining = events.filter((event) => {
    const id = String(event.eventId || '').trim().toLowerCase();
    const title = String(event.title || '').trim().toLowerCase();
    const keep = id !== lookup && title !== lookup;
    if (!keep) {
      removedEventIds.push(String(event.eventId || '').trim());
    }
    return keep;
  });

  await replaceDatasetRows(
    'events',
    remaining.map((event) => [
      event.eventId,
      event.title,
      event.description,
      event.date,
      event.time,
      event.location,
      event.apply,
      event.expiresAt || '',
    ])
  );
  await cleanupEventScopedData(removedEventIds);

  return { removed: events.length - remaining.length };
}

async function expireEvent(identifier) {
  const lookup = String(identifier || '').trim().toLowerCase();
  if (!lookup) return { expired: 0 };

  const events = await getAllEvents();
  const nowIso = new Date().toISOString();
  let expired = 0;

  const updated = events.map((event) => {
    const matches =
      String(event.eventId || '').trim().toLowerCase() === lookup ||
      String(event.title || '').trim().toLowerCase() === lookup;

    if (!matches) return event;
    expired += 1;
    return { ...event, expiresAt: nowIso };
  });

  if (expired) {
    await replaceDatasetRows(
      'events',
      updated.map((event) => [
        event.eventId,
        event.title,
        event.description,
        event.date,
        event.time,
        event.location,
        event.apply,
        event.expiresAt || '',
      ])
    );
    await purgeExpiredEvents(updated);
  }

  return { expired };
}

async function clearAllEvents() {
  const events = await getAllEvents();
  await replaceDatasetRows('events', []);
  await cleanupEventScopedData(events.map((event) => event.eventId));
  return { removed: events.length };
}

async function saveItinerary(eventId, chatId) {
  await ensureSheetHeader('itinerary', HEADERS.itinerary);
  const existing = await getAllItineraryEntries();
  const alreadySaved = existing.some(
    (row) =>
      String(row.eventId) === String(eventId) &&
      String(row.chatId) === String(chatId) &&
      String(row.status || '').toLowerCase() === 'going'
  );

  if (alreadySaved) {
    return { created: false };
  }

  const ts = new Date().toISOString();
  await appendRow('itinerary', [String(eventId), String(chatId), 'going', ts]);
  return { created: true, timestamp: ts };
}

async function getItineraries(chatId) {
  const entries = await getAllItineraryEntries();
  return entries.filter((row) => String(row.chatId) === String(chatId));
}

async function getEventAttendeeChatIds(eventId) {
  const entries = await getAllItineraryEntries();
  return Array.from(
    new Set(
      entries
        .filter(
          (row) =>
            String(row.eventId) === String(eventId) &&
            String(row.status || '').toLowerCase() === 'going'
        )
        .map((row) => String(row.chatId))
        .filter(Boolean)
    )
  );
}

async function getEventConnections() {
  await ensureSheetHeader('eventConnections', HEADERS.eventConnections);
  const rows = await getRows('eventConnections');

  return rows
    .slice(1)
    .map(parseEventConnectionRow)
    .filter(
      (row) => row.eventId && row.userAChatId && row.userBChatId
    );
}

async function getEventConnection(eventId, chatIdA, chatIdB) {
  const pair = normalizeEventConnectionPair(chatIdA, chatIdB);
  if (!pair) return null;

  const [userAChatId, userBChatId] = pair;
  const connections = await getEventConnections();
  return (
    connections.find(
      (connection) =>
        String(connection.eventId) === String(eventId) &&
        connection.userAChatId === userAChatId &&
        connection.userBChatId === userBChatId
    ) || null
  );
}

async function createEventConnection(eventId, eventTitle, chatIdA, chatIdB) {
  await ensureSheetHeader('eventConnections', HEADERS.eventConnections);

  const pair = normalizeEventConnectionPair(chatIdA, chatIdB);
  if (!pair) {
    throw new Error('A same-event connection requires two distinct chat ids.');
  }

  const [userAChatId, userBChatId] = pair;
  const existing = await getEventConnection(eventId, userAChatId, userBChatId);
  if (existing) {
    return { connection: existing, created: false };
  }

  const now = new Date().toISOString();
  const connection = {
    eventId: String(eventId || ''),
    eventTitle: String(eventTitle || ''),
    userAChatId,
    userBChatId,
    userAStatus: 'pending',
    userBStatus: 'pending',
    createdAt: now,
    updatedAt: now,
  };

  await appendRow('eventConnections', toEventConnectionRow(connection));
  return { connection, created: true };
}

async function updateEventConnectionStatus(eventId, actorChatId, otherChatId, status) {
  await ensureSheetHeader('eventConnections', HEADERS.eventConnections);

  const pair = normalizeEventConnectionPair(actorChatId, otherChatId);
  if (!pair) {
    throw new Error('A same-event connection requires two distinct chat ids.');
  }

  const rows = await getRows('eventConnections');
  const [userAChatId, userBChatId] = pair;
  const normalizedStatus = String(status || 'pending').trim().toLowerCase() || 'pending';

  for (let index = 1; index < rows.length; index += 1) {
    const connection = parseEventConnectionRow(rows[index]);
    if (
      String(connection.eventId) !== String(eventId) ||
      connection.userAChatId !== userAChatId ||
      connection.userBChatId !== userBChatId
    ) {
      continue;
    }

    const updated = {
      ...connection,
      updatedAt: new Date().toISOString(),
    };

    if (String(actorChatId) === connection.userAChatId) {
      updated.userAStatus = normalizedStatus;
    } else if (String(actorChatId) === connection.userBChatId) {
      updated.userBStatus = normalizedStatus;
    } else {
      throw new Error('Actor is not part of this same-event connection.');
    }

    await updateRow('eventConnections', index, toEventConnectionRow(updated));
    return updated;
  }

  throw new Error(
    `Same-event connection row not found for eventId=${eventId}, actor=${actorChatId}, other=${otherChatId}`
  );
}

async function saveNonUser(data, chatId) {
  await ensureSheetHeader('NotRegister', HEADERS.NotRegister);
  const [users, nonUsers] = await Promise.all([
    getUsers(),
    getRows('NotRegister'),
  ]);

  const normalizedUsername = normalizeUsername(data.username);
  const existingRegistered = users.find(
    (u) =>
      String(u.chatId) === String(chatId) ||
      (normalizedUsername && normalizeUsername(u.username) === normalizedUsername)
  );
  if (existingRegistered) return;

  const existingNonUser = nonUsers.slice(1).find((r) => {
    const rowUsername = normalizeUsername(r[0]);
    const rowChatId = String(r[1] || '');
    return rowChatId === String(chatId) || (normalizedUsername && rowUsername === normalizedUsername);
  });
  if (existingNonUser) return;

  const ts = new Date().toISOString();
  await appendRow('NotRegister', [data.username || '', String(chatId), false, ts, '']);
}

async function dedupeStoredUsers() {
  await ensureSheetHeader('users', HEADERS.users);
  const rows = await getRows('users');
  const dedupedRows = dedupeUserRows(rows.slice(1));
  const removed = Math.max(rows.length - 1 - dedupedRows.length, 0);
  if (removed > 0) {
    await replaceDatasetRows('users', dedupedRows);
  }
  return { kept: dedupedRows.length, removed };
}

async function dedupeStoredNonRegistered() {
  await ensureSheetHeader('NotRegister', HEADERS.NotRegister);
  const rows = await getRows('NotRegister');
  const dedupedRows = dedupeNonRegisteredRows(rows.slice(1));
  const removed = Math.max(rows.length - 1 - dedupedRows.length, 0);
  if (removed > 0) {
    await replaceDatasetRows('NotRegister', dedupedRows);
  }
  return { kept: dedupedRows.length, removed };
}

function parseTelegramReachabilityRow(row = []) {
  const normalized = normalizeDataRow(row, HEADERS.telegramReachability.length);
  return {
    chatId: String(normalized[0] || ''),
    username: String(normalized[1] || ''),
    status: normalizeTelegramReachabilityStatus(normalized[2]),
    reason: String(normalized[3] || ''),
    firstFailedAt: String(normalized[4] || ''),
    lastFailedAt: String(normalized[5] || ''),
    failureCount: parseFailureCount(normalized[6]),
    lastError: String(normalized[7] || ''),
  };
}

function toTelegramReachabilityRow(entry = {}) {
  const status = normalizeTelegramReachabilityStatus(entry.status);
  return [
    String(entry.chatId || ''),
    String(entry.username || ''),
    status,
    String(entry.reason || humanizeTelegramReachabilityStatus(status)),
    String(entry.firstFailedAt || ''),
    String(entry.lastFailedAt || ''),
    String(parseFailureCount(entry.failureCount) || 1),
    String(entry.lastError || ''),
  ];
}

async function getTelegramUnreachableUsers() {
  await ensureSheetHeader('telegramReachability', HEADERS.telegramReachability);
  const rows = await getRows('telegramReachability');

  return rows
    .slice(1)
    .map(parseTelegramReachabilityRow)
    .filter((row) => (row.chatId || row.username) && row.status !== 'reachable')
    .sort((left, right) => {
      const byLastFailed =
        parseIsoTimestamp(right.lastFailedAt || right.firstFailedAt) -
        parseIsoTimestamp(left.lastFailedAt || left.firstFailedAt);
      if (byLastFailed !== 0) return byLastFailed;
      return String(left.username || left.chatId).localeCompare(
        String(right.username || right.chatId)
      );
    });
}

async function getTelegramUnreachableUser(identifier, username = '') {
  const rawIdentifier = String(identifier || '').trim();
  const rawUsername = normalizeUsername(username);
  const chatId = /^-?\d+$/.test(rawIdentifier) ? rawIdentifier : '';
  const normalizedIdentifierUsername = chatId ? '' : normalizeUsername(rawIdentifier);
  const targetUsername = rawUsername || normalizedIdentifierUsername;
  const rows = await getTelegramUnreachableUsers();

  return (
    rows.find((row) => {
      const rowChatId = String(row.chatId || '').trim();
      const rowUsername = normalizeUsername(row.username);
      return (
        (chatId && rowChatId === chatId) ||
        (targetUsername && rowUsername === targetUsername)
      );
    }) || null
  );
}

async function isTelegramUnreachable(identifier, username = '') {
  return Boolean(await getTelegramUnreachableUser(identifier, username));
}

async function setTelegramUnreachable(identifier, options = {}) {
  await ensureSheetHeader('telegramReachability', HEADERS.telegramReachability);

  const knownUser =
    identifier && typeof identifier === 'object' ? identifier : await findKnownUser(identifier);

  const rawIdentifier = String(identifier || '').trim();
  const chatId =
    String(
      options.chatId ||
      knownUser?.chatId ||
      (/^-?\d+$/.test(rawIdentifier) ? rawIdentifier : '')
    ).trim();
  const username = normalizeUsername(
    options.username || knownUser?.username || (chatId ? '' : rawIdentifier)
  );

  if (!chatId && !username) {
    throw new Error('A chat id or username is required to mark Telegram reachability.');
  }

  const status = normalizeTelegramReachabilityStatus(options.status || options.reason);
  const failedAt = String(options.failedAt || new Date().toISOString());
  const reason = String(
    options.reasonText ||
    options.reason ||
    humanizeTelegramReachabilityStatus(status)
  ).trim();
  const lastError = String(options.lastError || '').trim();

  const rows = await getRows('telegramReachability');
  const dataRows = rows.slice(1);
  const existingIndex = dataRows.findIndex((row) => {
    const parsed = parseTelegramReachabilityRow(row);
    return (
      (chatId && parsed.chatId === chatId) ||
      (username && normalizeUsername(parsed.username) === username)
    );
  });

  const existing =
    existingIndex >= 0 ? parseTelegramReachabilityRow(dataRows[existingIndex]) : null;
  const next = {
    chatId: chatId || existing?.chatId || '',
    username: username || normalizeUsername(existing?.username || ''),
    status,
    reason: reason || existing?.reason || humanizeTelegramReachabilityStatus(status),
    firstFailedAt: existing?.firstFailedAt || failedAt,
    lastFailedAt: failedAt,
    failureCount: (existing?.failureCount || 0) + 1,
    lastError: lastError || existing?.lastError || '',
  };

  if (existingIndex >= 0) {
    await updateRow(
      'telegramReachability',
      existingIndex + 1,
      toTelegramReachabilityRow(next)
    );
  } else {
    await appendRow('telegramReachability', toTelegramReachabilityRow(next));
  }

  return next;
}

async function clearTelegramUnreachable(identifier, username = '') {
  await ensureSheetHeader('telegramReachability', HEADERS.telegramReachability);

  const rawIdentifier = String(identifier || '').trim();
  const chatId = /^-?\d+$/.test(rawIdentifier) ? rawIdentifier : '';
  const normalizedUsername = normalizeUsername(username || (chatId ? '' : rawIdentifier));
  const rows = await getRows('telegramReachability');
  const [header, ...data] = rows;
  const remaining = data.filter((row) => {
    const parsed = parseTelegramReachabilityRow(row);
    return !(
      (chatId && parsed.chatId === chatId) ||
      (normalizedUsername && normalizeUsername(parsed.username) === normalizedUsername)
    );
  });

  await replaceSheetData('telegramReachability', [header, ...remaining]);

  return {
    removed: data.length - remaining.length,
  };
}

async function saveLead(user) {
  await ensureSheetHeader('Leads', HEADERS.Leads);
  const ts = new Date().toISOString();
  await appendRow('Leads', [
    user.username,
    (user.categories || []).join(','),
    (user.lookingFor || []).join(','),
    user.xUrl,
    user.projectName,
    String(user.chatId),
    ts,
  ]);
}

async function getBlockedUsers() {
  await ensureSheetHeader('blockedUsers', HEADERS.blockedUsers);
  const rows = await getRows('blockedUsers');

  return rows
    .slice(1)
    .map((r) => ({
      chatId: String(r[0] || ''),
      username: String(r[1] || ''),
      blockedAt: String(r[2] || ''),
      blockedBy: String(r[3] || ''),
      active: normalizeBool(r[4]),
    }))
    .filter((row) => row.active);
}

async function isBlockedUser(chatId, username) {
  const blockedUsers = await getBlockedUsers();
  const normalizedUsername = normalizeUsername(username);
  const chatIdStr = String(chatId || '');

  return blockedUsers.some(
    (user) =>
      (chatIdStr && String(user.chatId || '') === chatIdStr) ||
      (normalizedUsername &&
        normalizeUsername(user.username) === normalizedUsername)
  );
}

async function setBlockedUser(identifier, blockedBy = '') {
  await ensureSheetHeader('blockedUsers', HEADERS.blockedUsers);
  const blockedUsers = await getBlockedUsers();

  const raw = String(identifier || '').trim();
  const chatId = /^-?\d+$/.test(raw) ? raw : '';
  const username = chatId ? '' : raw.replace(/^@/, '');
  const normalizedUsername = normalizeUsername(username);
  const blockedAt = new Date().toISOString();

  const next = blockedUsers.filter(
    (user) =>
      (chatId && String(user.chatId || '') !== chatId) ||
      (!chatId && normalizeUsername(user.username) !== normalizedUsername)
  );

  next.push({
    chatId,
    username,
    blockedAt,
    blockedBy: String(blockedBy || ''),
    active: true,
  });

  await replaceDatasetRows(
    'blockedUsers',
    next.map((user) => [
      user.chatId,
      user.username,
      user.blockedAt,
      user.blockedBy,
      true,
    ])
  );

  return {
    chatId,
    username,
    blockedAt,
  };
}

async function unblockUser(identifier) {
  await ensureSheetHeader('blockedUsers', HEADERS.blockedUsers);
  const blockedUsers = await getBlockedUsers();
  const raw = String(identifier || '').trim();
  const normalizedUsername = normalizeUsername(raw);
  const chatId = /^-?\d+$/.test(raw) ? raw : '';

  const remaining = blockedUsers.filter(
    (user) =>
      (chatId && String(user.chatId || '') !== chatId) ||
      (!chatId && normalizeUsername(user.username) !== normalizedUsername)
  );

  await replaceDatasetRows(
    'blockedUsers',
    remaining.map((user) => [
      user.chatId,
      user.username,
      user.blockedAt,
      user.blockedBy,
      true,
    ])
  );

  return { removed: blockedUsers.length - remaining.length };
}

async function removeKnownUserData(identifier) {
  const target = await findKnownUser(identifier);
  const raw = String(identifier || '').trim();
  const chatId = target ? String(target.chatId || '') : (/^-?\d+$/.test(raw) ? raw : '');
  const normalizedUsername = normalizeUsername(target ? target.username : raw);

  if (!chatId && !normalizedUsername) {
    return { removedRows: {} };
  }

  const removedRows = {};

  const removeByFilter = async (sheetName, predicate) => {
    await ensureSheetHeader(sheetName, HEADERS[sheetName]);
    const rows = await getRows(sheetName);
    if (!rows.length) {
      removedRows[sheetName] = 0;
      return;
    }

    const [header, ...data] = rows;
    const remaining = data.filter((row) => !predicate(row));
    removedRows[sheetName] = data.length - remaining.length;
    await replaceSheetData(sheetName, [header, ...remaining]);
  };

  await removeByFilter('users', (row) => {
    const rowChatId = String(row[6] || '');
    const rowUsername = normalizeUsername(row[7]);
    return (chatId && rowChatId === chatId) || (normalizedUsername && rowUsername === normalizedUsername);
  });

  await removeByFilter('NotRegister', (row) => {
    const rowChatId = String(row[1] || '');
    const rowUsername = normalizeUsername(row[0]);
    return (chatId && rowChatId === chatId) || (normalizedUsername && rowUsername === normalizedUsername);
  });

  await removeByFilter('contacts', (row) => {
    const from = String(row[0] || '');
    const to = String(row[1] || '');
    return chatId && (from === chatId || to === chatId);
  });

  await removeByFilter('requests', (row) => {
    const from = String(row[0] || '');
    const to = String(row[1] || '');
    return chatId && (from === chatId || to === chatId);
  });

  await removeByFilter('eventConnections', (row) => {
    const userAChatId = String(row[2] || '');
    const userBChatId = String(row[3] || '');
    return chatId && (userAChatId === chatId || userBChatId === chatId);
  });

  await removeByFilter('itinerary', (row) => {
    const rowChatId = String(row[1] || '');
    return chatId && rowChatId === chatId;
  });

  await removeByFilter('Leads', (row) => {
    const rowChatId = String(row[5] || '');
    const rowUsername = normalizeUsername(row[0]);
    return (chatId && rowChatId === chatId) || (normalizedUsername && rowUsername === normalizedUsername);
  });

  await removeByFilter('blockedUsers', (row) => {
    const rowChatId = String(row[0] || '');
    const rowUsername = normalizeUsername(row[1]);
    return (chatId && rowChatId === chatId) || (normalizedUsername && rowUsername === normalizedUsername);
  });

  await removeByFilter('profileUpdateHistory', (row) => {
    const rowChatId = String(row[0] || '');
    const rowUsername = normalizeUsername(row[1]);
    return (chatId && rowChatId === chatId) || (normalizedUsername && rowUsername === normalizedUsername);
  });

  await removeByFilter('leadAccess', (row) => {
    const rowChatId = String(row[0] || '');
    const rowUsername = normalizeUsername(row[1]);
    return (chatId && rowChatId === chatId) || (normalizedUsername && rowUsername === normalizedUsername);
  });

  await ensureSheetHeader('massDmHistory', HEADERS.massDmHistory);
  const massDmHistory = await getMassDmHistory();
  const remainingMassDmHistory = [];
  let removedMassDmReferences = 0;

  for (const entry of massDmHistory) {
    const senderMatches = chatId && String(entry.senderChatId || '') === chatId;
    if (senderMatches) {
      removedMassDmReferences += 1;
      continue;
    }

    const originalDeliveries = Array.isArray(entry.deliveries) ? entry.deliveries : [];
    const nextDeliveries = originalDeliveries.filter(
      (delivery) => !chatId || String(delivery.chatId || '') !== chatId
    );
    removedMassDmReferences += originalDeliveries.length - nextDeliveries.length;

    if (nextDeliveries.length) {
      remainingMassDmHistory.push({
        ...entry,
        deliveries: nextDeliveries,
      });
    } else if (originalDeliveries.length === 0) {
      remainingMassDmHistory.push(entry);
    }
  }

  removedRows.massDmHistory = removedMassDmReferences;
  await replaceDatasetRows(
    'massDmHistory',
    remainingMassDmHistory.map((entry) => toMassDmHistoryRow(entry))
  );

  await removeByFilter('telegramReachability', (row) => {
    const rowChatId = String(row[0] || '');
    const rowUsername = normalizeUsername(row[1]);
    return (chatId && rowChatId === chatId) || (normalizedUsername && rowUsername === normalizedUsername);
  });

  return {
    target: target || { chatId, username: normalizedUsername },
    removedRows,
  };
}

module.exports = {
  HEADERS,

  // Metadata / export helpers
  listDatasets,
  resolveDatasetName,
  getDatasetRows,
  replaceDatasetRows,
  getStorageBackend() {
    return sheetStore.getBackendName();
  },

  // Users
  saveUser,
  getUsers,
  getKnownUsers,
  findKnownUser,
  canAttemptUserContact,
  getMassDmHistory,
  getLastMassDmBatch,
  saveLastMassDmBatch,
  updateLastMassDmBatch,
  clearLastMassDmBatch,
  getProfileUpdateHistory,
  getProfileEditAllowance,
  recordProfileUpdate,
  getLeadAccess,
  setLeadAccessMode,
  getSingleUser,
  updateUser,
  isRegistered,
  isActiveUserStatus,

  // Requests
  saveRequest,
  getRequests,
  getRequestsBetween,
  getLatestRequestBetween,
  hasOpenRequestBetween,
  getPendingRequests,
  updateRequestStatus,
  upsertRequestStatus,
  getEventConnections,
  getEventConnection,
  createEventConnection,
  updateEventConnectionStatus,

  // Contacts
  saveContact,
  getContacts,
  getContactsFor,
  hasContactBetween,
  removeContactRelationship,
  removeOpenRequestsBetween,
  clearMatchRelationship,
  getApprovalKeywords,
  addApprovalKeyword,
  removeApprovalKeyword,

  // Events / Itinerary / NonUser
  getEvents,
  getAllEvents,
  saveEvent,
  removeEvent,
  expireEvent,
  clearAllEvents,
  purgeExpiredEvents,
  saveItinerary,
  getItineraries,
  getEventAttendeeChatIds,
  saveNonUser,
  markUserAsRegistered,
  markNonRegisteredReminderSent,
  getNonRegisteredUsers,
  dedupeStoredUsers,
  dedupeStoredNonRegistered,

  // Leads
  saveLead,

  // Moderation / admin
  getTelegramUnreachableUsers,
  getTelegramUnreachableUser,
  isTelegramUnreachable,
  setTelegramUnreachable,
  clearTelegramUnreachable,
  getBlockedUsers,
  isBlockedUser,
  setBlockedUser,
  unblockUser,
  removeKnownUserData,
};
