'use strict';

const {
  HAS_ADMIN_CONFIG,
  isAdmin,
  FOUNDER_NAME,
  FOUNDER_TELEGRAM_USERNAME,
  FOUNDER_X_HANDLE,
  COLLAB_NETWORK_TELEGRAM_USERNAME,
  COLLAB_NETWORK_X_HANDLE,
} = require('../config');
const storage = require('../services/storage');
const reachability = require('../services/reachability');

const CALLBACK_SEND_ALL = 'pending_profiles_remind_all';

function formatUsername(username) {
  const normalized = String(username || '').trim().replace(/^@/, '');
  return normalized ? `@${normalized}` : null;
}

function buildReminderMessage(user) {
  const userMention = formatUsername(user && user.username);
  const greeting = userMention ? `Hey ${userMention},` : 'Hey,';

  const collabXUrl = COLLAB_NETWORK_X_HANDLE
    ? `https://x.com/${COLLAB_NETWORK_X_HANDLE}`
    : 'https://x.com/CollablyNetwork';
  const telegramHandle = FOUNDER_TELEGRAM_USERNAME
    ? `@${FOUNDER_TELEGRAM_USERNAME}`
    : '@CollablyNetworkCEO';

  return [
    greeting,
    '',
    `This is ${FOUNDER_NAME} from Collably Network.`,
    'I request you to please complete your profile so that we can assist you to connect with your potential partners and essential resources.',
    '',
    'Thanks & regards,',
    FOUNDER_NAME,
    `Collably Network X: ${collabXUrl}`,
    `Telegram: ${telegramHandle}`,
    'Linkedin: https://www.linkedin.com/in/sumitkumarblockchain',
  ].join('\n');
}

function buildPendingProfilesText(users) {
  if (!users.length) {
    return 'No incomplete profiles found. Everyone who started the bot has either completed registration or is no longer pending.';
  }

  const preview = users.slice(0, 30).map((user, index) => {
    const handle = formatUsername(user.username) || `chat:${user.chatId}`;
    const ts = user.timestamp ? ` | ${user.timestamp}` : '';
    return `${index + 1}. ${handle} (${user.chatId})${ts}`;
  });

  return [
    `Pending profiles: ${users.length}`,
    'These users started the bot but have not completed profile setup yet.',
    '',
    ...preview,
    users.length > preview.length
      ? `\nShowing first ${preview.length}. Use /export csv if you need the full pending list.`
      : null,
  ]
    .filter(Boolean)
    .join('\n');
}

async function sendReminderBatch(bot, users) {
  let delivered = 0;
  const failed = [];

  for (const user of users) {
    if (reachability.isTelegramBlocked(user.chatId)) {
      failed.push(`${formatUsername(user.username) || user.chatId}: bot blocked by user`);
      continue;
    }

    const availability = await storage.canAttemptUserContact(user);
    if (!availability.ok) {
      failed.push(`${formatUsername(user.username) || user.chatId}: blocked or inactive`);
      continue;
    }

    try {
      await bot.sendMessage(Number(user.chatId), buildReminderMessage(user));
      delivered += 1;
    } catch (err) {
      if (reachability.isTelegramUnavailableError(err)) {
        await reachability.markTelegramUnavailable(user.chatId, {
          username: user.username,
          reason: reachability.getTelegramUnavailableReason(err),
          error: err,
        });
      }
      failed.push(`${formatUsername(user.username) || user.chatId}: ${err.message}`);
    }
  }

  return { delivered, failed };
}

async function handlePendingProfilesCommand(msg, bot) {
  const chatId = String(msg.chat.id);
  const username = msg.from && msg.from.username;

  if (!HAS_ADMIN_CONFIG) {
    await bot.sendMessage(
      chatId,
      '⚠️ Set ADMIN_CHAT_IDS or ADMIN_USERNAMES in .env to enable /pendingprofiles.'
    );
    return;
  }

  if (!isAdmin(chatId, username)) {
    await bot.sendMessage(chatId, '⚠️ /pendingprofiles is restricted to the admin chat.');
    return;
  }

  const users = await storage.getNonRegisteredUsers();
  const text = buildPendingProfilesText(users);
  const inlineKeyboard = users.length
    ? [[{ text: `Send Reminder To All (${users.length})`, callback_data: CALLBACK_SEND_ALL }]]
    : undefined;

  await bot.sendMessage(chatId, text, {
    reply_markup: inlineKeyboard ? { inline_keyboard: inlineKeyboard } : undefined,
  });
}

async function handleCallback(query, bot) {
  if (query.data !== CALLBACK_SEND_ALL) return false;

  const chatId = String(query.message?.chat?.id || query.from.id);
  const username = query.from && query.from.username;

  if (!HAS_ADMIN_CONFIG) {
    await bot.answerCallbackQuery(query.id, {
      text: 'Admin config missing.',
      show_alert: true,
    });
    return true;
  }

  if (!isAdmin(chatId, username)) {
    await bot.answerCallbackQuery(query.id, {
      text: 'Admin only.',
      show_alert: true,
    });
    return true;
  }

  const users = await storage.getNonRegisteredUsers();
  if (!users.length) {
    await bot.answerCallbackQuery(query.id, {
      text: 'No pending profiles left.',
    });
    return true;
  }

  await bot.answerCallbackQuery(query.id, {
    text: `Sending reminders to ${users.length} users...`,
  });

  const result = await sendReminderBatch(bot, users);

  try {
    await bot.editMessageReplyMarkup(
      { inline_keyboard: [[{ text: '✅ Reminder Sent', callback_data: 'noop' }]] },
      {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
      }
    );
  } catch (_) {}

  await bot.sendMessage(
    chatId,
    [
      `✅ Reminder sent to ${result.delivered} pending users.`,
      result.failed.length ? `Failed: ${result.failed.length}` : null,
    ]
      .filter(Boolean)
      .join('\n')
  );

  return true;
}

module.exports = {
  handlePendingProfilesCommand,
  handleCallback,
};
