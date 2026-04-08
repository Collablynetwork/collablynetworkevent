// index.js
'use strict';

const dns = require('dns');
const TelegramBot        = require('node-telegram-bot-api');
const { TELEGRAM_TOKEN, ADMIN_CHAT_IDS, isAdmin } = require('./config');

const accountHandler = require('./handlers/accountHandler');
const adminHandler   = require('./handlers/adminHandler');
const matchHandler   = require('./handlers/matchHandler');
const contactHandler = require('./handlers/contactHandler');
const chatHandler    = require('./handlers/chatHandler');
const exportHandler  = require('./handlers/exportHandler');
const exportService  = require('./services/exportService');
const eventsHandler  = require('./handlers/eventHandler');
const pendingProfileHandler = require('./handlers/pendingProfileHandler');
const matchService   = require('./services/matchmaking');
const storage        = require('./services/storage');
const reachability   = require('./services/reachability');

// Fail fast if token is missing
if (!TELEGRAM_TOKEN) {
  console.error('❌ TELEGRAM_TOKEN missing in ./config');
  process.exit(1);
}

// Prefer IPv4 because some networks time out on Telegram's IPv6 endpoints.
if (typeof dns.setDefaultResultOrder === 'function') {
  dns.setDefaultResultOrder('ipv4first');
}

const bot = new TelegramBot(TELEGRAM_TOKEN, {
  polling: true,
  request: { family: 4 },
});

const DEFAULT_COMMANDS = [
  { command: 'start', description: 'Start the bot or register your profile' },
  { command: 'match', description: 'Find matching partner profiles' },
  { command: 'contacts', description: 'Show your saved contacts' },
  { command: 'events', description: 'Show upcoming events' },
  { command: 'itinerary', description: 'Show your saved itinerary' },
  { command: 'editprofile', description: 'Edit your profile' },
  { command: 'shareprofile', description: 'Show your QR/share profile' },
  { command: 'chat', description: 'Open a direct chat. Use /chat off to stop' },
];

const ADMIN_COMMANDS = [
  ...DEFAULT_COMMANDS,
  { command: 'audience', description: 'Show the bot audience list' },
  { command: 'pendingprofiles', description: 'List incomplete profiles and remind them' },
  { command: 'dm', description: 'Send a direct message: /dm @username message' },
  { command: 'massdm', description: 'Broadcast a message to users or a segment' },
  { command: 'export', description: 'Export data: csv, google, or excel' },
  { command: 'forceexport', description: 'Force SQLite data export to Google Sheets' },
  { command: 'removeuser', description: 'Delete one user and related data' },
  { command: 'blockuser', description: 'Block one username or chat id' },
  { command: 'unblockuser', description: 'Unblock one username or chat id' },
  { command: 'unreachableusers', description: 'List Telegram-unreachable users' },
  { command: 'clearunreachable', description: 'Clear a stored unreachable user flag' },
  { command: 'retryuser', description: 'Retry a previously unreachable user' },
  { command: 'listevents', description: 'List active events with ids' },
  { command: 'addevent', description: 'Add an event with date and links' },
  { command: 'removeevent', description: 'Remove an event by id or title' },
  { command: 'expireevent', description: 'Expire an event immediately' },
  { command: 'clearallevents', description: 'Remove all existing events' },
  { command: 'approvalkeywords', description: 'List admin approval keywords' },
  { command: 'addapprovalkeyword', description: 'Add admin approval keyword(s)' },
  { command: 'removeapprovalkeyword', description: 'Remove admin approval keyword(s)' },
];

async function ensureNotBlockedMessage(msg) {
  const chatId = String(msg.chat.id);
  const username = msg.from?.username || '';

  if (isAdmin(chatId, username)) {
    await clearTelegramReachabilityFromInbound(msg.from);
    return true;
  }
  if (!(await storage.isBlockedUser(chatId, username))) {
    await clearTelegramReachabilityFromInbound(msg.from);
    return true;
  }

  await bot.sendMessage(chatId, '⛔ Your access to this bot is currently blocked.');
  return false;
}

async function ensureNotBlockedCallback(query) {
  const chatId = String(query.from.id);
  const username = query.from?.username || '';

  if (isAdmin(chatId, username)) {
    await clearTelegramReachabilityFromInbound(query.from);
    return true;
  }
  if (!(await storage.isBlockedUser(chatId, username))) {
    await clearTelegramReachabilityFromInbound(query.from);
    return true;
  }

  try {
    await bot.answerCallbackQuery(query.id, {
      text: 'Your access to this bot is currently blocked.',
      show_alert: true,
    });
  } catch (_) {}

  return false;
}

async function syncBotCommands() {
  try {
    await bot.setMyCommands(DEFAULT_COMMANDS);

    for (const adminChatId of ADMIN_CHAT_IDS) {
      await bot.setMyCommands(ADMIN_COMMANDS, {
        scope: { type: 'chat', chat_id: Number(adminChatId) },
      });
    }

    console.log('✅ Telegram commands synced');
  } catch (err) {
    console.error('⚠️ Failed to sync Telegram commands:', err.message || err);
  }
}

syncBotCommands();
matchService.hydrateAdminApprovalKeywords().catch((err) => {
  console.error('⚠️ Failed to load admin approval keywords:', err.message || err);
});
reachability.hydrateTelegramUnavailableCache().catch((err) => {
  console.error('⚠️ Failed to load Telegram reachability cache:', err.message || err);
});

async function purgeExpiredEventsOnSchedule() {
  try {
    const result = await storage.purgeExpiredEvents();
    if (result.removedCount) {
      console.log(`🗑️ Purged ${result.removedCount} expired event(s).`);
    }
  } catch (err) {
    console.error('⚠️ Failed to purge expired events:', err.message || err);
  }
}

purgeExpiredEventsOnSchedule();
setInterval(purgeExpiredEventsOnSchedule, 60 * 60 * 1000);

async function runDailyGoogleExport() {
  try {
    const source = storage.getStorageBackend() === 'sqlite' ? 'sqlite' : 'storage';
    const result = await exportService.exportGoogleSnapshot('all', {
      source,
      includeDerived: true,
    });

    console.log(
      `✅ Daily Google export complete from ${source}. Exported ${result.exported.length} tabs.`
    );
  } catch (err) {
    console.error('⚠️ Daily Google export failed:', err.message || err);
  }
}

runDailyGoogleExport();
setInterval(runDailyGoogleExport, 24 * 60 * 60 * 1000);

bot.on('polling_error', err => {
  const message = String(err && (err.message || err.code || err));
  if (/ETIMEDOUT/i.test(message)) {
    console.error('❌ Telegram polling error: network timeout while reaching Telegram. This is usually an IPv6 or ISP/firewall routing issue.', err);
    return;
  }
  console.error('❌ Telegram polling error:', err);
});
process.on('unhandledRejection', e => console.error('UNHANDLED:', e));
process.on('uncaughtException',  e => console.error('UNCAUGHT:', e));

async function clearTelegramReachabilityFromInbound(userLike) {
  const chatId = String(userLike?.id || userLike?.chat?.id || '').trim();
  const username = String(userLike?.username || userLike?.from?.username || '').trim();

  if (!chatId && !username) return;

  try {
    await reachability.clearTelegramUnavailable(chatId || username, username);
  } catch (err) {
    if (!/Unknown dataset/i.test(String(err?.message || err))) {
      console.warn('⚠️ Failed to clear Telegram reachability on inbound activity:', err.message || err);
    }
  }
}

/* ─────────────────────────── /start (supports payload) ─────────────────────────── */
bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  try {
    if (!(await ensureNotBlockedMessage(msg))) return;

    const chatId   = msg.chat.id;
    const payload  = match && match[1] ? String(match[1]).trim() : null; // referral or deep-link payload
    const username = msg.from.username || '';

    console.log('➡️ /start', { chatId, username, payload });

    // Bi-directional referral save (guard self)
    if (payload && payload !== String(chatId) && typeof storage.saveContact === 'function') {
      const ts = new Date().toISOString();
      await storage.saveContact({ from: payload, to: chatId,   timestamp: ts });
      await storage.saveContact({ from: chatId,  to: payload,  timestamp: ts });
    }

    // Save into NonUser only if not already registered and API exists
    if (typeof storage.saveNonUser === 'function') {
      try {
        const users  = await storage.getUsers();
        const exists = users?.some?.(u => String(u.chatId) === String(chatId));
        if (!exists) {
          await storage.saveNonUser({ username }, chatId);
        }
      } catch (e) {
        console.warn('⚠️ saveNonUser skipped:', e?.message || e);
      }
    }

    await accountHandler.handleStart(msg, bot);
  } catch (e) {
    console.error('Error in /start handler:', e);
    bot.sendMessage(msg.chat.id, '⚠️ Something went wrong starting registration.');
  }
});

/* ─────────────────────── Text Message Handling ─────────────────────── */
bot.on('message', async msg => {
  if (!msg.text) return; // ignore non-text
  const text   = msg.text.trim();
  const chatId = msg.chat.id;

  if (text.startsWith('/')) return;
  if (!(await ensureNotBlockedMessage(msg))) return;

  try {
    // Main menu entries
    if (text === '📞 Contacts')      return contactHandler.showContacts(msg, bot);
    if (text === '📥 Leads')         return matchHandler.handleMatchCommand(msg, bot);
    if (text === '✏️ Edit Profile')  return accountHandler.startEditProfile(msg, bot);
    if (text === '⛶ Your QR Profile' || text === '➦ Share Profile')
    return accountHandler.shareProfile(msg, bot);
    if (text === '📅 Events')         return eventsHandler.handleEventsCommand(msg, bot);
    if (text === '📋 Itinerary')      return eventsHandler.handleItineraryCommand?.(msg, bot);

    // Stateful Mute/Unmute toggle
    if (text === "🔕 Mute Notification" || text === "🔔 Unmute Notification") {
      return accountHandler.handleChangeStatus(msg, bot);
    }
    // Back-compat
    if (text === '🔕 Mute Notification/🔔 Unmute Notification') {
      return accountHandler.handleChangeStatus(msg, bot);
    }

    if (accountHandler.hasActiveSession?.(chatId)) {
      return accountHandler.handleMessage(msg, bot);
    }

    if (await chatHandler.handleOutgoingMessage(msg, bot)) {
      return;
    }

    // Fallback to the account/profile field flow
    await accountHandler.handleMessage(msg, bot);
  } catch (err) {
    console.error('Error in message handler:', err);
    await bot.sendMessage(chatId, '⚠️ Oops, something went wrong.');
  }
});

/* ────────────────────── Callback Query Router ────────────────────── */
bot.on('callback_query', async query => {
  const data   = query.data || '';

  try {
    if (!(await ensureNotBlockedCallback(query))) return;

    // 0) Shared noop
    if (data === 'noop') {
      await bot.answerCallbackQuery(query.id);
      return;
    }

    // 1) Match flow FIRST (prefixes used in your matchHandler)
    if (data.startsWith('send_req_') || data.startsWith('accept_') || data.startsWith('decline_')) {
      await matchHandler.handleCallback(query, bot);
      return;
    }

    // 2) Open in-bot chats from buttons
    if (data.startsWith('chat_open_')) {
      await chatHandler.openChatFromCallback(query, bot);
      return;
    }

    // 3) Contacts callbacks (pagination etc.) if implemented
    if (data.startsWith('contacts_more_') || data.startsWith('accept_contact_') || data.startsWith('contacts_remind_profile_')) {
      await contactHandler.handleCallback?.(query, bot);
      return;
    }

    // 4) Admin approval keyword picker
    if (data.startsWith('approvalkw_')) {
      await adminHandler.handleApprovalKeywordCallback?.(query, bot);
      return;
    }

    // 5) Events: going_, pager & scope
    if (
      data.startsWith('going_') ||
      data.startsWith('events_more_') ||
      data.startsWith('events_scope_') ||
      data.startsWith('event_connect_')
    ) {
      await eventsHandler.handleEventCallback?.(query, bot);
      return;
    }

    // 6) Pending profile reminders
    if (data.startsWith('pending_profiles_')) {
      await pendingProfileHandler.handleCallback?.(query, bot);
      return;
    }

    // 7) Account/profile callbacks (multi-select submits, etc.)
    await accountHandler.handleCallbackQuery?.(query, bot);
    return;
  } catch (err) {
    console.error('Error in callback handlers:', err);
    try {
      await bot.answerCallbackQuery(query.id, { text: '⚠️ An error occurred.' });
    } catch {}
  }
});

/* ─────────────────────────── /contacts ─────────────────────────── */
bot.onText(/\/contacts/, async msg => {
  try {
    if (!(await ensureNotBlockedMessage(msg))) return;
    await contactHandler.showContacts(msg, bot);
  } catch (e) {
    console.error('Error in /contacts handler:', e);
    bot.sendMessage(msg.chat.id, '⚠️ Could not load contacts.');
  }
});

bot.onText(/\/match/, async msg => {
  if (!(await ensureNotBlockedMessage(msg))) return;
  await matchHandler.handleMatchCommand(msg, bot);
});

bot.onText(/\/events/, async msg => {
  if (!(await ensureNotBlockedMessage(msg))) return;
  await eventsHandler.handleEventsCommand(msg, bot);
});

bot.onText(/\/itinerary/, async msg => {
  if (!(await ensureNotBlockedMessage(msg))) return;
  await eventsHandler.handleItineraryCommand(msg, bot);
});

bot.onText(/\/(?:editprofile|edit)/, async msg => {
  if (!(await ensureNotBlockedMessage(msg))) return;
  await accountHandler.startEditProfile(msg, bot);
});

bot.onText(/\/(?:shareprofile|qrprofile)/, async msg => {
  if (!(await ensureNotBlockedMessage(msg))) return;
  await accountHandler.shareProfile(msg, bot);
});

bot.onText(/\/audience/, async msg => {
  if (!(await ensureNotBlockedMessage(msg))) return;
  await chatHandler.handleAudienceCommand(msg, bot);
});

bot.onText(/\/pendingprofiles/, async msg => {
  if (!(await ensureNotBlockedMessage(msg))) return;
  await pendingProfileHandler.handlePendingProfilesCommand(msg, bot);
});

bot.onText(/\/export(?:\s+(.+))?/, async (msg, match) => {
  if (!(await ensureNotBlockedMessage(msg))) return;
  await exportHandler.handleExportCommand(msg, bot, match && match[1]);
});

bot.onText(/\/forceexport(?:\s+(.+))?/, async (msg, match) => {
  if (!(await ensureNotBlockedMessage(msg))) return;
  await exportHandler.handleForceExportCommand(msg, bot, match && match[1]);
});

bot.onText(/\/(?:dm|message)(?:\s+(.+))?/, async (msg, match) => {
  if (!(await ensureNotBlockedMessage(msg))) return;
  await chatHandler.handleDirectMessageCommand(msg, bot, match && match[1]);
});

bot.onText(/\/massdm(?:\s+(.+))?/, async (msg, match) => {
  if (!(await ensureNotBlockedMessage(msg))) return;
  await chatHandler.handleMassDmCommand(msg, bot, match && match[1]);
});

bot.onText(/\/chat(?:\s+(.+))?/, async (msg, match) => {
  if (!(await ensureNotBlockedMessage(msg))) return;
  await chatHandler.handleChatCommand(msg, bot, match && match[1]);
});

bot.onText(/\/endchat/, async msg => {
  if (!(await ensureNotBlockedMessage(msg))) return;
  await chatHandler.handleEndChatCommand(msg, bot);
});

bot.onText(/\/(?:removeuser|deleteuser)(?:\s+(.+))?/, async (msg, match) => {
  if (!(await ensureNotBlockedMessage(msg))) return;
  await adminHandler.handleRemoveUserCommand(msg, bot, match && match[1]);
});

bot.onText(/\/blockuser(?:\s+(.+))?/, async (msg, match) => {
  if (!(await ensureNotBlockedMessage(msg))) return;
  await adminHandler.handleBlockUserCommand(msg, bot, match && match[1]);
});

bot.onText(/\/unblockuser(?:\s+(.+))?/, async (msg, match) => {
  if (!(await ensureNotBlockedMessage(msg))) return;
  await adminHandler.handleUnblockUserCommand(msg, bot, match && match[1]);
});

bot.onText(/\/unreachableusers/, async msg => {
  if (!(await ensureNotBlockedMessage(msg))) return;
  await adminHandler.handleUnreachableUsersCommand(msg, bot);
});

bot.onText(/\/clearunreachable(?:\s+(.+))?/, async (msg, match) => {
  if (!(await ensureNotBlockedMessage(msg))) return;
  await adminHandler.handleClearUnreachableCommand(msg, bot, match && match[1]);
});

bot.onText(/\/retryuser(?:\s+(.+))?/, async (msg, match) => {
  if (!(await ensureNotBlockedMessage(msg))) return;
  await adminHandler.handleRetryUserCommand(msg, bot, match && match[1]);
});

bot.onText(/\/listevents/, async msg => {
  if (!(await ensureNotBlockedMessage(msg))) return;
  await adminHandler.handleListEventsCommand(msg, bot);
});

bot.onText(/\/addevent(?:\s+(.+))?/, async (msg, match) => {
  if (!(await ensureNotBlockedMessage(msg))) return;
  await adminHandler.handleAddEventCommand(msg, bot, match && match[1]);
});

bot.onText(/\/removeevent(?:\s+(.+))?/, async (msg, match) => {
  if (!(await ensureNotBlockedMessage(msg))) return;
  await adminHandler.handleRemoveEventCommand(msg, bot, match && match[1]);
});

bot.onText(/\/expireevent(?:\s+(.+))?/, async (msg, match) => {
  if (!(await ensureNotBlockedMessage(msg))) return;
  await adminHandler.handleExpireEventCommand(msg, bot, match && match[1]);
});

bot.onText(/\/clearallevents/, async msg => {
  if (!(await ensureNotBlockedMessage(msg))) return;
  await adminHandler.handleClearAllEventsCommand(msg, bot);
});

bot.onText(/\/approvalkeywords/, async msg => {
  if (!(await ensureNotBlockedMessage(msg))) return;
  await adminHandler.handleApprovalKeywordsCommand(msg, bot);
});

bot.onText(/\/addapprovalkeyword(?:\s+(.+))?/, async (msg, match) => {
  if (!(await ensureNotBlockedMessage(msg))) return;
  await adminHandler.handleAddApprovalKeywordCommand(msg, bot, match && match[1]);
});

bot.onText(/\/removeapprovalkeyword(?:\s+(.+))?/, async (msg, match) => {
  if (!(await ensureNotBlockedMessage(msg))) return;
  await adminHandler.handleRemoveApprovalKeywordCommand(msg, bot, match && match[1]);
});

console.log('🤖 Telegram Matchmaking Bot running...');
