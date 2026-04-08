'use strict';

const { HAS_ADMIN_CONFIG, isAdmin } = require('../config');
const storage = require('../services/storage');
const reachability = require('../services/reachability');
const matchService = require('../services/matchmaking');
const { PROJECT_CATEGORY_OPTIONS } = require('../utils/projectCategories');

const approvalKeywordSessions = new Map();

function parseFlexibleDate(value) {
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
  return Number.isNaN(native.getTime()) ? null : native;
}

async function ensureAdminAccess(msg, bot, commandName) {
  const chatId = String(msg.chat.id);
  const username = msg.from?.username || '';

  if (!HAS_ADMIN_CONFIG) {
    await bot.sendMessage(
      chatId,
      `⚠️ Set ADMIN_CHAT_IDS or ADMIN_USERNAMES in .env to enable /${commandName}.`
    );
    return false;
  }

  if (!isAdmin(chatId, username)) {
    await bot.sendMessage(chatId, `⚠️ /${commandName} is restricted to the admin chat.`);
    return false;
  }

  return true;
}

function buildUserUsage() {
  return [
    'Usage:',
    '/removeuser @username',
    '/blockuser @username',
    '/unblockuser @username',
  ].join('\n');
}

function buildUnreachableUsage() {
  return [
    'Usage:',
    '/unreachableusers',
    '/clearunreachable @username',
    '/retryuser @username',
  ].join('\n');
}

function buildEventUsage() {
  return [
    'Usage:',
    '/listevents',
    '/addevent Title | Description | DD/MM/YYYY | HH:MM | Register URL | Map URL | [Expiry date]',
    '/removeevent <eventId or exact title>',
    '/expireevent <eventId or exact title>',
    '/clearallevents',
  ].join('\n');
}

function buildApprovalKeywordUsage() {
  return [
    'Usage:',
    '/approvalkeywords',
    '/addapprovalkeyword CEX',
    '/addapprovalkeyword Venture Capital, Market Maker',
    '/removeapprovalkeyword CEX',
    '',
    'Tip:',
    'Run /addapprovalkeyword or /removeapprovalkeyword without arguments to pick from buttons.',
  ].join('\n');
}

function parseKeywordArgs(rawArgs) {
  return String(rawArgs || '')
    .split(',')
    .map((item) => String(item || '').trim())
    .filter(Boolean);
}

function getApprovalSession(chatId) {
  return approvalKeywordSessions.get(String(chatId)) || null;
}

function setApprovalSession(chatId, session) {
  approvalKeywordSessions.set(String(chatId), session);
}

function clearApprovalSession(chatId) {
  approvalKeywordSessions.delete(String(chatId));
}

function buildApprovalKeywordKeyboard(session) {
  const options = Array.isArray(session.options) ? session.options : [];
  const rows = [];
  const perRow = 3;

  options.forEach((keyword, index) => {
    const selected = session.selected.has(keyword);
    const text = `${selected ? '✅ ' : ''}${keyword}`;
    const rowIndex = Math.floor(index / perRow);

    rows[rowIndex] = rows[rowIndex] || [];
    rows[rowIndex].push({
      text,
      callback_data: `approvalkw_toggle_${session.mode}_${index}`,
    });
  });

  rows.push([
    {
      text: session.mode === 'add' ? 'Submit Add' : 'Submit Remove',
      callback_data: `approvalkw_submit_${session.mode}`,
    },
    {
      text: 'Cancel',
      callback_data: `approvalkw_cancel_${session.mode}`,
    },
  ]);

  return rows;
}

async function startApprovalKeywordPicker(msg, bot, mode) {
  const chatId = String(msg.chat.id);
  const currentKeywords = await matchService.getAdminApprovalKeywords();
  const options = mode === 'add'
    ? PROJECT_CATEGORY_OPTIONS.slice()
    : currentKeywords.slice();

  if (!options.length) {
    await bot.sendMessage(
      chatId,
      mode === 'add'
        ? 'No project categories are configured for approval keyword selection.'
        : 'No admin approval keywords are configured right now.'
    );
    return;
  }

  setApprovalSession(chatId, {
    mode,
    options,
    selected: new Set(),
  });

  const prompt = mode === 'add'
    ? [
        'Select one or more project keywords to require admin approval.',
        currentKeywords.length
          ? `Current approval keywords: ${currentKeywords.join(', ')}`
          : 'Current approval keywords: none',
        'Then tap Submit Add.',
      ].join('\n')
    : [
        'Select one or more current approval keywords to remove.',
        `Current approval keywords: ${currentKeywords.join(', ')}`,
        'Then tap Submit Remove.',
      ].join('\n');

  await bot.sendMessage(chatId, prompt, {
    reply_markup: { inline_keyboard: buildApprovalKeywordKeyboard(getApprovalSession(chatId)) },
  });
}

async function resolveKnownIdentifier(rawIdentifier) {
  const raw = String(rawIdentifier || '').trim();
  if (!raw) return null;
  return storage.findKnownUser(raw);
}

async function handleRemoveUserCommand(msg, bot, rawArgs) {
  if (!(await ensureAdminAccess(msg, bot, 'removeuser'))) return;

  const chatId = String(msg.chat.id);
  const identifier = String(rawArgs || '').trim();
  if (!identifier) {
    await bot.sendMessage(chatId, buildUserUsage());
    return;
  }

  const result = await storage.removeKnownUserData(identifier);
  const totalRemoved = Object.values(result.removedRows || {}).reduce(
    (sum, count) => sum + Number(count || 0),
    0
  );

  if (!totalRemoved) {
    await bot.sendMessage(chatId, `⚠️ No stored rows found for "${identifier}".`);
    return;
  }

  const summary = Object.entries(result.removedRows || {})
    .filter(([, count]) => Number(count) > 0)
    .map(([dataset, count]) => `${dataset}: ${count}`)
    .join('\n');

  await bot.sendMessage(
    chatId,
    [
      `✅ Removed stored data for ${result.target?.username ? `@${result.target.username}` : result.target?.chatId || identifier}.`,
      summary,
    ].join('\n')
  );
}

async function handleBlockUserCommand(msg, bot, rawArgs) {
  if (!(await ensureAdminAccess(msg, bot, 'blockuser'))) return;

  const chatId = String(msg.chat.id);
  const identifier = String(rawArgs || '').trim();
  if (!identifier) {
    await bot.sendMessage(chatId, buildUserUsage());
    return;
  }

  const known = await resolveKnownIdentifier(identifier);
  const blockTarget = known
    ? (known.username ? `@${known.username}` : String(known.chatId))
    : identifier;
  const blocked = await storage.setBlockedUser(
    blockTarget,
    msg.from?.username ? `@${msg.from.username}` : String(msg.from?.id || '')
  );

  await bot.sendMessage(
    chatId,
    `✅ Blocked ${blocked.username ? `@${blocked.username}` : blocked.chatId || identifier}.`
  );
}

async function handleUnblockUserCommand(msg, bot, rawArgs) {
  if (!(await ensureAdminAccess(msg, bot, 'unblockuser'))) return;

  const chatId = String(msg.chat.id);
  const identifier = String(rawArgs || '').trim();
  if (!identifier) {
    await bot.sendMessage(chatId, buildUserUsage());
    return;
  }

  const known = await resolveKnownIdentifier(identifier);
  const unblockTarget = known
    ? (known.username ? `@${known.username}` : String(known.chatId))
    : identifier;
  const result = await storage.unblockUser(unblockTarget);

  if (!result.removed) {
    await bot.sendMessage(chatId, `⚠️ No blocked record found for "${identifier}".`);
    return;
  }

  await bot.sendMessage(chatId, `✅ Unblocked ${unblockTarget}.`);
}

function formatUnreachableTarget(record) {
  const username = String(record?.username || '').trim().replace(/^@/, '');
  if (username) return `@${username}`;
  if (record?.chatId) return String(record.chatId);
  return 'unknown user';
}

function buildUnreachableUsersText(records) {
  if (!records.length) {
    return 'No Telegram-unreachable users are stored right now.';
  }

  const preview = records.slice(0, 40).map((record, index) => {
    const target = formatUnreachableTarget(record);
    const details = [
      record.chatId && target !== record.chatId ? `chat:${record.chatId}` : null,
      `status:${record.status}`,
      `fails:${record.failureCount || 1}`,
      record.lastFailedAt ? `last:${record.lastFailedAt}` : null,
    ]
      .filter(Boolean)
      .join(' | ');

    return `${index + 1}. ${target}${details ? ` | ${details}` : ''}`;
  });

  return [
    `Telegram-unreachable users: ${records.length}`,
    '',
    ...preview,
    records.length > preview.length
      ? `\nShowing first ${preview.length}.`
      : null,
  ]
    .filter(Boolean)
    .join('\n');
}

async function handleUnreachableUsersCommand(msg, bot) {
  if (!(await ensureAdminAccess(msg, bot, 'unreachableusers'))) return;

  const chatId = String(msg.chat.id);
  const records = await storage.getTelegramUnreachableUsers();
  await bot.sendMessage(chatId, buildUnreachableUsersText(records));
}

async function handleClearUnreachableCommand(msg, bot, rawArgs) {
  if (!(await ensureAdminAccess(msg, bot, 'clearunreachable'))) return;

  const chatId = String(msg.chat.id);
  const identifier = String(rawArgs || '').trim();
  if (!identifier) {
    await bot.sendMessage(chatId, buildUnreachableUsage());
    return;
  }

  const known = await resolveKnownIdentifier(identifier);
  const result = await reachability.clearTelegramUnavailable(
    known?.chatId || identifier,
    known?.username || identifier
  );

  if (!result.removed) {
    await bot.sendMessage(chatId, `⚠️ No unreachable record found for "${identifier}".`);
    return;
  }

  const target = known
    ? (known.username ? `@${known.username}` : String(known.chatId))
    : identifier;
  await bot.sendMessage(chatId, `✅ Cleared Telegram unreachable flag for ${target}.`);
}

async function handleRetryUserCommand(msg, bot, rawArgs) {
  if (!(await ensureAdminAccess(msg, bot, 'retryuser'))) return;

  const chatId = String(msg.chat.id);
  const identifier = String(rawArgs || '').trim();
  if (!identifier) {
    await bot.sendMessage(chatId, buildUnreachableUsage());
    return;
  }

  const known = await resolveKnownIdentifier(identifier);
  const clearResult = await reachability.clearTelegramUnavailable(
    known?.chatId || identifier,
    known?.username || identifier
  );

  if (!clearResult.removed) {
    await bot.sendMessage(chatId, `⚠️ No unreachable record found for "${identifier}".`);
    return;
  }

  const target = known
    ? (known.username ? `@${known.username}` : String(known.chatId))
    : identifier;
  const availability = await storage.canAttemptUserContact(
    known || (known?.chatId || identifier),
    known?.username || identifier
  );

  if (!availability.ok && availability.reason !== 'missing') {
    const statusMessage =
      availability.reason === 'inactive'
        ? 'Their profile is still inactive.'
        : availability.reason === 'blocked'
          ? 'They are still admin-blocked.'
          : 'They are still not reachable.';

    await bot.sendMessage(
      chatId,
      `🔁 Cleared the stored unreachable flag for ${target}, but ${statusMessage}`
    );
    return;
  }

  await bot.sendMessage(
    chatId,
    `🔁 Cleared the stored unreachable flag for ${target}. The bot will retry this user on the next outbound message.`
  );
}

async function handleListEventsCommand(msg, bot) {
  if (!(await ensureAdminAccess(msg, bot, 'listevents'))) return;

  const chatId = String(msg.chat.id);
  await storage.purgeExpiredEvents();
  const events = await storage.getAllEvents();

  if (!events.length) {
    await bot.sendMessage(chatId, 'No active events found.');
    return;
  }

  const lines = events.map((event, index) => {
    const expiry = event.expiresAt ? ` | expires: ${event.expiresAt}` : '';
    return `${index + 1}. ${event.eventId} | ${event.title} | ${event.date} ${event.time}${expiry}`;
  });

  await bot.sendMessage(chatId, [`Active events: ${events.length}`, '', ...lines].join('\n'));
}

async function handleAddEventCommand(msg, bot, rawArgs) {
  if (!(await ensureAdminAccess(msg, bot, 'addevent'))) return;

  const chatId = String(msg.chat.id);
  const parts = String(rawArgs || '')
    .split('|')
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length < 6) {
    await bot.sendMessage(chatId, buildEventUsage());
    return;
  }

  const [title, description, date, time, apply, location, expiresAtRaw] = parts;
  const eventDate = parseFlexibleDate(date);
  if (!eventDate) {
    await bot.sendMessage(chatId, '⚠️ Invalid event date. Use DD/MM/YYYY or ISO date.');
    return;
  }

  const expiresAt = expiresAtRaw
    ? parseFlexibleDate(expiresAtRaw)
    : parseFlexibleDate(date);
  if (!expiresAt) {
    await bot.sendMessage(chatId, '⚠️ Invalid expiry date. Use DD/MM/YYYY or ISO date.');
    return;
  }

  const eventId = `evt_${Date.now()}`;
  await storage.saveEvent({
    eventId,
    title,
    description,
    date,
    time,
    apply,
    location,
    expiresAt: expiresAt.toISOString(),
  });

  await bot.sendMessage(chatId, `✅ Event added with ID ${eventId}.`);
}

async function handleRemoveEventCommand(msg, bot, rawArgs) {
  if (!(await ensureAdminAccess(msg, bot, 'removeevent'))) return;

  const chatId = String(msg.chat.id);
  const identifier = String(rawArgs || '').trim();
  if (!identifier) {
    await bot.sendMessage(chatId, buildEventUsage());
    return;
  }

  const result = await storage.removeEvent(identifier);
  if (!result.removed) {
    await bot.sendMessage(chatId, `⚠️ No event found for "${identifier}".`);
    return;
  }

  await bot.sendMessage(chatId, `✅ Removed ${result.removed} event(s).`);
}

async function handleExpireEventCommand(msg, bot, rawArgs) {
  if (!(await ensureAdminAccess(msg, bot, 'expireevent'))) return;

  const chatId = String(msg.chat.id);
  const identifier = String(rawArgs || '').trim();
  if (!identifier) {
    await bot.sendMessage(chatId, buildEventUsage());
    return;
  }

  const result = await storage.expireEvent(identifier);
  if (!result.expired) {
    await bot.sendMessage(chatId, `⚠️ No event found for "${identifier}".`);
    return;
  }

  await bot.sendMessage(chatId, `✅ Expired ${result.expired} event(s).`);
}

async function handleClearAllEventsCommand(msg, bot) {
  if (!(await ensureAdminAccess(msg, bot, 'clearallevents'))) return;

  const chatId = String(msg.chat.id);
  const result = await storage.clearAllEvents();

  await bot.sendMessage(chatId, `✅ Removed ${result.removed} existing event(s).`);
}

async function handleApprovalKeywordsCommand(msg, bot) {
  if (!(await ensureAdminAccess(msg, bot, 'approvalkeywords'))) return;

  const chatId = String(msg.chat.id);
  const keywords = await matchService.getAdminApprovalKeywords();

  await bot.sendMessage(
    chatId,
    keywords.length
      ? ['Admin approval keywords:', ...keywords.map((keyword, index) => `${index + 1}. ${keyword}`)].join('\n')
      : 'No admin approval keywords configured.'
  );
}

async function handleAddApprovalKeywordCommand(msg, bot, rawArgs) {
  if (!(await ensureAdminAccess(msg, bot, 'addapprovalkeyword'))) return;

  const chatId = String(msg.chat.id);
  const keywords = parseKeywordArgs(rawArgs);
  if (!keywords.length) {
    await startApprovalKeywordPicker(msg, bot, 'add');
    return;
  }

  const added = [];
  const existing = [];

  for (const keyword of keywords) {
    const result = await storage.addApprovalKeyword(
      keyword,
      msg.from?.username ? `@${msg.from.username}` : String(msg.from?.id || '')
    );

    if (result.created) added.push(result.keyword);
    else existing.push(result.keyword);
  }

  await matchService.hydrateAdminApprovalKeywords(true);

  await bot.sendMessage(
    chatId,
    [
      added.length ? `✅ Added: ${added.join(', ')}` : null,
      existing.length ? `ℹ️ Already present: ${existing.join(', ')}` : null,
    ]
      .filter(Boolean)
      .join('\n')
  );
}

async function handleRemoveApprovalKeywordCommand(msg, bot, rawArgs) {
  if (!(await ensureAdminAccess(msg, bot, 'removeapprovalkeyword'))) return;

  const chatId = String(msg.chat.id);
  const keywords = parseKeywordArgs(rawArgs);
  if (!keywords.length) {
    await startApprovalKeywordPicker(msg, bot, 'remove');
    return;
  }

  const removed = [];
  const missing = [];

  for (const keyword of keywords) {
    const result = await storage.removeApprovalKeyword(keyword);
    if (result.removed) removed.push(keyword);
    else missing.push(keyword);
  }

  await matchService.hydrateAdminApprovalKeywords(true);

  await bot.sendMessage(
    chatId,
    [
      removed.length ? `✅ Removed: ${removed.join(', ')}` : null,
      missing.length ? `⚠️ Not found: ${missing.join(', ')}` : null,
    ]
      .filter(Boolean)
      .join('\n')
  );
}

async function handleApprovalKeywordCallback(query, bot) {
  const chatId = String(query.from.id);
  const session = getApprovalSession(chatId);
  const data = String(query.data || '');

  if (!data.startsWith('approvalkw_')) {
    return false;
  }

  if (!session) {
    await bot.answerCallbackQuery(query.id, {
      text: 'This approval keyword picker has expired.',
      show_alert: true,
    });
    return true;
  }

  const toggleMatch = data.match(/^approvalkw_toggle_(add|remove)_(\d+)$/);
  if (toggleMatch) {
    const [, mode, indexText] = toggleMatch;
    if (mode !== session.mode) {
      await bot.answerCallbackQuery(query.id, { text: 'This picker is no longer active.' });
      return true;
    }

    const keyword = session.options[Number(indexText)];
    if (!keyword) {
      await bot.answerCallbackQuery(query.id, { text: 'Keyword not found.' });
      return true;
    }

    if (session.selected.has(keyword)) session.selected.delete(keyword);
    else session.selected.add(keyword);

    await bot.answerCallbackQuery(query.id);
    await bot.editMessageReplyMarkup(
      { inline_keyboard: buildApprovalKeywordKeyboard(session) },
      {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
      }
    );
    return true;
  }

  const submitMatch = data.match(/^approvalkw_submit_(add|remove)$/);
  if (submitMatch) {
    const [, mode] = submitMatch;
    if (mode !== session.mode) {
      await bot.answerCallbackQuery(query.id, { text: 'This picker is no longer active.' });
      return true;
    }

    const selectedKeywords = Array.from(session.selected);
    if (!selectedKeywords.length) {
      await bot.answerCallbackQuery(query.id, {
        text: 'Select at least one keyword first.',
        show_alert: true,
      });
      return true;
    }

    if (mode === 'add') {
      const added = [];
      const existing = [];

      for (const keyword of selectedKeywords) {
        const result = await storage.addApprovalKeyword(
          keyword,
          query.from?.username ? `@${query.from.username}` : String(query.from?.id || '')
        );
        if (result.created) added.push(result.keyword);
        else existing.push(result.keyword);
      }

      await matchService.hydrateAdminApprovalKeywords(true);
      clearApprovalSession(chatId);
      await bot.answerCallbackQuery(query.id, { text: 'Approval keywords updated.' });
      await bot.editMessageReplyMarkup(
        { inline_keyboard: [[{ text: '✅ Updated', callback_data: 'noop' }]] },
        {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
        }
      );
      await bot.sendMessage(
        chatId,
        [
          added.length ? `✅ Added: ${added.join(', ')}` : null,
          existing.length ? `ℹ️ Already present: ${existing.join(', ')}` : null,
        ]
          .filter(Boolean)
          .join('\n')
      );
      return true;
    }

    const removed = [];
    const missing = [];

    for (const keyword of selectedKeywords) {
      const result = await storage.removeApprovalKeyword(keyword);
      if (result.removed) removed.push(keyword);
      else missing.push(keyword);
    }

    await matchService.hydrateAdminApprovalKeywords(true);
    clearApprovalSession(chatId);
    await bot.answerCallbackQuery(query.id, { text: 'Approval keywords updated.' });
    await bot.editMessageReplyMarkup(
      { inline_keyboard: [[{ text: '✅ Updated', callback_data: 'noop' }]] },
      {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
      }
    );
    await bot.sendMessage(
      chatId,
      [
        removed.length ? `✅ Removed: ${removed.join(', ')}` : null,
        missing.length ? `⚠️ Not found: ${missing.join(', ')}` : null,
      ]
        .filter(Boolean)
        .join('\n')
    );
    return true;
  }

  const cancelMatch = data.match(/^approvalkw_cancel_(add|remove)$/);
  if (cancelMatch) {
    clearApprovalSession(chatId);
    await bot.answerCallbackQuery(query.id, { text: 'Cancelled.' });
    await bot.editMessageReplyMarkup(
      { inline_keyboard: [[{ text: '❌ Cancelled', callback_data: 'noop' }]] },
      {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
      }
    );
    return true;
  }

  return false;
}

module.exports = {
  handleAddEventCommand,
  handleAddApprovalKeywordCommand,
  handleApprovalKeywordCallback,
  handleApprovalKeywordsCommand,
  handleBlockUserCommand,
  handleClearUnreachableCommand,
  handleClearAllEventsCommand,
  handleExpireEventCommand,
  handleListEventsCommand,
  handleRemoveEventCommand,
  handleRemoveApprovalKeywordCommand,
  handleRemoveUserCommand,
  handleRetryUserCommand,
  handleUnblockUserCommand,
  handleUnreachableUsersCommand,
};
