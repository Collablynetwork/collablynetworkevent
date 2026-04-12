'use strict';

const storage = require('./storage');

const unavailableTelegramUserIds = new Set();

function normalizeChatId(value) {
  return String(value || '').trim();
}

function getTelegramUnavailableReason(error) {
  const message = String(
    error?.response?.body?.description || error?.message || error || ''
  ).toLowerCase();

  if (/bot was blocked by the user/.test(message)) {
    return 'blocked_bot';
  }

  if (/user is deactivated/.test(message)) {
    return 'deactivated';
  }

  if (/chat not found/.test(message) || /user not found/.test(message)) {
    return 'chat_not_found';
  }

  return null;
}

function isTelegramUnavailableError(error) {
  return Boolean(getTelegramUnavailableReason(error));
}

async function hydrateTelegramUnavailableCache() {
  const users = await storage.getTelegramUnreachableUsers();
  unavailableTelegramUserIds.clear();

  for (const user of users) {
    const chatId = normalizeChatId(user.chatId);
    if (chatId) {
      unavailableTelegramUserIds.add(chatId);
    }
  }

  return users.length;
}

async function markTelegramUnavailable(userId, options = {}) {
  const normalized = normalizeChatId(userId);
  if (normalized) {
    unavailableTelegramUserIds.add(normalized);
  }

  const reason =
    options.reason ||
    getTelegramUnavailableReason(options.error) ||
    'unreachable';
  const errorText = String(
    options.lastError ||
    options.error?.response?.body?.description ||
    options.error?.message ||
    ''
  ).trim();

  try {
    await storage.setTelegramUnreachable(normalized || options.username || userId, {
      chatId: normalized,
      username: options.username || '',
      status: reason,
      reasonText: errorText || reason,
      lastError: errorText,
      failedAt: options.failedAt,
    });
  } catch (error) {
    console.warn('⚠️ Failed to persist Telegram reachability state:', error.message || error);
  }
}

async function clearTelegramUnavailable(identifier, username = '') {
  const normalized = normalizeChatId(identifier);
  const existing = await storage.getTelegramUnreachableUser(identifier, username);

  if (normalized) {
    unavailableTelegramUserIds.delete(normalized);
  }

  if (existing?.chatId) {
    unavailableTelegramUserIds.delete(normalizeChatId(existing.chatId));
  }

  const result = await storage.clearTelegramUnreachable(identifier, username);

  return result;
}

function clearTelegramUnavailableCache(identifier) {
  const normalized =
    identifier && typeof identifier === 'object'
      ? normalizeChatId(identifier.chatId)
      : normalizeChatId(identifier);

  if (!normalized) {
    return { removed: false };
  }

  return { removed: unavailableTelegramUserIds.delete(normalized) };
}

function isTelegramUnavailable(userId) {
  const normalized = normalizeChatId(userId);
  return normalized ? unavailableTelegramUserIds.has(normalized) : false;
}

async function isPersistentlyTelegramUnavailable(identifier, username = '') {
  return storage.isTelegramUnreachable(identifier, username);
}

function isTelegramBlockedError(error) {
  return isTelegramUnavailableError(error);
}

async function markTelegramBlocked(userId, options = {}) {
  await markTelegramUnavailable(userId, options);
}

function isTelegramBlocked(userId) {
  return isTelegramUnavailable(userId);
}

module.exports = {
  clearTelegramUnavailableCache,
  clearTelegramUnavailable,
  getTelegramUnavailableReason,
  hydrateTelegramUnavailableCache,
  isPersistentlyTelegramUnavailable,
  isTelegramUnavailableError,
  isTelegramUnavailable,
  markTelegramUnavailable,
  isTelegramBlockedError,
  isTelegramBlocked,
  markTelegramBlocked,
};
