'use strict';

const {
  HAS_ADMIN_CONFIG,
  FOUNDER_TELEGRAM_USERNAME_DISPLAY,
  isAdmin,
} = require('../config');
const storage = require('../services/storage');
const reachability = require('../services/reachability');

const activeChats = new Map();
const activeBroadcasts = new Map();

function formatPersonLabel(user) {
  if (!user) return 'Unknown user';
  if (user.projectName) return `${user.projectName} (${user.chatId})`;
  if (user.fullName) return `${user.fullName} (${user.chatId})`;
  if (user.username) return `@${String(user.username).replace(/^@/, '')} (${user.chatId})`;
  return `chat ${user.chatId}`;
}

function formatChatSenderLabel(user) {
  if (!user) return 'Someone';
  if (user.projectName) return user.projectName;
  if (user.fullName) return user.fullName;
  if (user.username) return `@${String(user.username).replace(/^@/, '')}`;
  return 'Someone';
}

function ensureActiveChatSet(chatId) {
  const id = String(chatId);
  let set = activeChats.get(id);
  if (!set) {
    set = new Set();
    activeChats.set(id, set);
  }
  return set;
}

function getActiveChatIds(chatId) {
  return Array.from(activeChats.get(String(chatId)) || []);
}

function removeChatBridge(chatIdA, chatIdB) {
  const a = String(chatIdA);
  const b = String(chatIdB);

  const setA = activeChats.get(a);
  if (setA) {
    setA.delete(b);
    if (!setA.size) activeChats.delete(a);
  }

  const setB = activeChats.get(b);
  if (setB) {
    setB.delete(a);
    if (!setB.size) activeChats.delete(b);
  }
}

function clearAllChatBridges(chatId) {
  const id = String(chatId);
  const targets = getActiveChatIds(id);

  for (const targetId of targets) {
    removeChatBridge(id, targetId);
  }

  return targets.length;
}

function clearUserRuntimeState(identifier) {
  const chatId =
    identifier && typeof identifier === 'object'
      ? String(identifier.chatId || '').trim()
      : String(identifier || '').trim();

  if (!chatId) {
    return {
      activeChatBridges: 0,
      senderBroadcastsCleared: 0,
      broadcastRecipientsPruned: 0,
    };
  }

  const activeChatBridges = clearAllChatBridges(chatId);
  let senderBroadcastsCleared = 0;
  let broadcastRecipientsPruned = 0;

  for (const [senderChatId, broadcast] of Array.from(activeBroadcasts.entries())) {
    if (String(senderChatId) === chatId) {
      activeBroadcasts.delete(senderChatId);
      senderBroadcastsCleared += 1;
      continue;
    }

    const recipients = Array.isArray(broadcast?.recipients) ? broadcast.recipients : [];
    const nextRecipients = recipients.filter(
      (recipient) => String(recipient?.chatId || '') !== chatId
    );
    const removedRecipients = recipients.length - nextRecipients.length;

    if (!removedRecipients) continue;

    broadcastRecipientsPruned += removedRecipients;

    if (nextRecipients.length) {
      activeBroadcasts.set(senderChatId, {
        ...broadcast,
        recipients: nextRecipients,
      });
    } else {
      activeBroadcasts.delete(senderChatId);
      senderBroadcastsCleared += 1;
    }
  }

  return {
    activeChatBridges,
    senderBroadcastsCleared,
    broadcastRecipientsPruned,
  };
}

function openChatBridge(chatIdA, chatIdB) {
  const a = String(chatIdA);
  const b = String(chatIdB);
  const setA = ensureActiveChatSet(a);
  const setB = ensureActiveChatSet(b);
  const wasOpen = setA.has(b) && setB.has(a);

  setA.add(b);
  setB.add(a);

  return !wasOpen;
}

function formatAdminSenderLabel(senderLabel, sender) {
  const replyTag = getReplyTag(sender).replace(/^@/, '').replace(/^#/, '');
  if (replyTag && replyTag !== 'chatId') return `${senderLabel} (${replyTag})`;

  const founderUsername = String(FOUNDER_TELEGRAM_USERNAME_DISPLAY || '').trim().replace(/^@/, '');
  if (!founderUsername) return senderLabel;
  return `${senderLabel} (${founderUsername})`;
}

function getReplyTag(user) {
  if (user && user.username) {
    return `@${String(user.username).replace(/^@/, '')}`;
  }

  if (user && user.chatId) {
    return `#${String(user.chatId)}`;
  }

  return '#chatId';
}

function buildReplyInstruction(user) {
  return `Reply in bot. If multiple chats are active, start with ${getReplyTag(user)}.`;
}

async function getActiveChatUsers(chatId) {
  const targetIds = getActiveChatIds(chatId);
  const users = await Promise.all(
    targetIds.map(async (targetId) => {
      const user = await storage.findKnownUser(String(targetId));
      return (
        user || {
          chatId: String(targetId),
          username: '',
          projectName: '',
          fullName: '',
        }
      );
    })
  );

  return users;
}

function buildTaggedReplyUsage(targets) {
  const options = targets.map((user) => {
    const tag = getReplyTag(user);
    const label = formatChatSenderLabel(user);
    return `${tag} -> ${label}`;
  });

  return [
    '⚠️ Multiple active chats detected.',
    'Tag the person at the start of your message.',
    ...options,
    '',
    `Example: ${getReplyTag(targets[0])} hello`,
  ].join('\n');
}

function resolveTaggedTarget(text, targets) {
  const trimmed = String(text || '').trim();
  const match = trimmed.match(/^(@[A-Za-z0-9_]+|#-?\d+)\s+([\s\S]+)$/);
  if (!match) {
    return { target: null, messageText: trimmed, usedTag: false };
  }

  const token = match[1];
  const messageText = String(match[2] || '').trim();
  const normalizedToken = token.toLowerCase();

  const target = targets.find((user) => {
    if (token.startsWith('@')) {
      return user.username && `@${String(user.username).replace(/^@/, '').toLowerCase()}` === normalizedToken;
    }

    return `#${String(user.chatId)}` === token;
  }) || null;

  return { target, messageText, usedTag: true };
}

function getChatUsage() {
  return (
    'Usage:\n' +
    '/audience\n' +
    '/dm @username <message>\n' +
    '/massdm @username\n' +
    '/massdm all\n' +
    '/removelastmassdm\n' +
    '/chat @username\n' +
    '/chat off'
  );
}

function getMassDmUsage() {
  return (
    'Usage:\n' +
    '/massdm all\n' +
    '/massdm @username\n' +
    '/massdm @user1,@user2\n' +
    '/massdm <message>\n' +
    '/massdm off\n' +
    '/removelastmassdm'
  );
}

function normalizeSelectorToken(value) {
  return String(value || '').trim();
}

function isSelectorToken(token) {
  return token === 'all' || token.startsWith('@') || /^-?\d+$/.test(token);
}

async function resolveKnownTarget(rawTarget) {
  return storage.findKnownUser(rawTarget);
}

async function getAudienceUsers() {
  const users = await storage.getKnownUsers();
  const filtered = [];

  for (const user of users) {
    if (!String(user.chatId || '').trim()) continue;
    if (reachability.isTelegramBlocked(user.chatId)) continue;

    const availability = await storage.canAttemptUserContact(user);
    if (!availability.ok) continue;

    filtered.push(user);
  }

  return filtered
    .sort((a, b) => {
      const aRegistered = a.registered ? 0 : 1;
      const bRegistered = b.registered ? 0 : 1;
      if (aRegistered !== bRegistered) return aRegistered - bRegistered;
      return String(a.username || a.chatId).localeCompare(String(b.username || b.chatId));
    });
}

function buildAudienceSummary(users) {
  const registered = users.filter((user) => user.registered).length;
  const startedOnly = users.length - registered;
  const preview = users
    .slice(0, 25)
    .map((user) => {
      const handle = user.username
        ? `@${String(user.username).replace(/^@/, '')}`
        : `chat:${user.chatId}`;
      const suffix = user.registered ? 'registered' : 'started';
      return `• ${handle} (${user.chatId}) - ${suffix}`;
    });

  return [
    `Audience: ${users.length}`,
    `Registered profiles: ${registered}`,
    `Started but not registered: ${startedOnly}`,
    '',
    preview.length ? preview.join('\n') : 'No audience yet.',
    users.length > preview.length
      ? `\nShowing first ${preview.length} users. Use /export csv to get the full list.`
      : null,
  ]
    .filter(Boolean)
    .join('\n');
}

async function canMessageTarget(senderChatId, targetChatId) {
  const sender = await storage.findKnownUser(String(senderChatId));
  const target = await storage.findKnownUser(String(targetChatId));

  if (String(senderChatId) === String(targetChatId)) {
    return { ok: false, message: '⚠️ You cannot message yourself.' };
  }

  if (reachability.isTelegramBlocked(targetChatId)) {
    return { ok: false, message: '⚠️ That user cannot be reached in the bot right now.' };
  }

  const senderAvailability = await storage.canAttemptUserContact(
    sender || String(senderChatId),
    sender && sender.username
  );
  if (!senderAvailability.ok) {
    if (senderAvailability.reason === 'inactive') {
      return { ok: false, message: '⚠️ Your profile is not active right now.' };
    }
    return { ok: false, message: '⚠️ Your access to this bot is currently blocked.' };
  }

  const targetAvailability = await storage.canAttemptUserContact(
    target || String(targetChatId),
    target && target.username
  );
  if (!targetAvailability.ok) {
    if (targetAvailability.reason === 'unreachable') {
      return { ok: false, message: '⚠️ That user cannot be reached in the bot right now.' };
    }
    if (targetAvailability.reason === 'inactive') {
      return { ok: false, message: '⚠️ That user is not active right now.' };
    }
    return { ok: false, message: '⚠️ That user is blocked and cannot be messaged right now.' };
  }

  if (isAdmin(senderChatId)) {
    return { ok: true };
  }

  if (!sender) {
    return { ok: false, message: '⚠️ Start the bot first with /start.' };
  }

  const contacts = await storage.getContactsFor(senderChatId);
  const isContact = contacts.some(
    (item) => String(item.contactId) === String(targetChatId)
  );

  if (!isContact) {
    return {
      ok: false,
      message:
        '⚠️ You can only message users who are already in your contacts. Admin can message any started user.',
    };
  }

  return { ok: true };
}

async function sendRelayedMessage(bot, fromChatId, target, messageText, meta = {}) {
  const sender =
    (await storage.findKnownUser(String(fromChatId))) || {
      chatId: String(fromChatId),
      username: '',
      projectName: '',
      fullName: '',
    };
  const isAdminSender = isAdmin(fromChatId, sender.username);
  const senderLabel = isAdminSender
    ? sender.projectName || 'Collably Network'
    : formatChatSenderLabel(sender);
  const openedChat = meta.isBroadcast
    ? false
    : openChatBridge(fromChatId, target.chatId);
  const adminSenderLabel = formatAdminSenderLabel(senderLabel, sender);
  const replyInstruction = buildReplyInstruction(sender);
  const message = meta.isBroadcast
    ? [
        '📣 Broadcast via Collably bot',
        `From: ${senderLabel}`,
        '',
        String(messageText || ''),
      ].join('\n')
    : openedChat && isAdminSender
      ? (() => {
          return [
            '💬 Message via Collably bot',
            `From: ${adminSenderLabel}`,
            '',
            String(messageText || ''),
            '',
            replyInstruction,
          ].join('\n');
        })()
      : openedChat
        ? [
            `💬 Chat with ${senderLabel}`,
            '',
            String(messageText || ''),
            '',
            replyInstruction,
          ].join('\n')
        : [`💬 ${senderLabel}`, '', String(messageText || ''), '', replyInstruction].join('\n');

  try {
    const sentMessage = await bot.sendMessage(Number(target.chatId), message);
    return {
      sender,
      sentMessage,
    };
  } catch (error) {
    if (reachability.isTelegramUnavailableError(error)) {
      await reachability.markTelegramUnavailable(target.chatId, {
        username: target.username,
        reason: reachability.getTelegramUnavailableReason(error),
        error,
      });
      removeChatBridge(fromChatId, target.chatId);
      throw new Error('That user cannot be reached in the bot right now.');
    }
    throw error;
  }

}

async function parseRecipients(selectionText, senderChatId) {
  const audience = await getAudienceUsers();
  const knownById = new Map(audience.map((user) => [String(user.chatId), user]));
  const knownByUsername = new Map(
    audience
      .filter((user) => user.username)
      .map((user) => [String(user.username).replace(/^@/, '').toLowerCase(), user])
  );

  const normalizedSelection = String(selectionText || '').trim();
  if (!normalizedSelection || normalizedSelection.toLowerCase() === 'all') {
    return audience.filter((user) => String(user.chatId) !== String(senderChatId));
  }

  const tokens = normalizedSelection
    .split(',')
    .map((token) => normalizeSelectorToken(token))
    .filter(Boolean);

  const recipients = [];
  const seen = new Set();

  for (const token of tokens) {
    let user = null;

    if (/^-?\d+$/.test(token)) {
      user = knownById.get(token) || null;
    } else {
      user = knownByUsername.get(token.replace(/^@/, '').toLowerCase()) || null;
    }

    if (!user || String(user.chatId) === String(senderChatId)) {
      continue;
    }

    if (!seen.has(String(user.chatId))) {
      seen.add(String(user.chatId));
      recipients.push(user);
    }
  }

  return recipients;
}

function splitMassDmArgs(rawArgs) {
  const trimmed = String(rawArgs || '').trim();
  if (!trimmed) return { mode: 'arm', selection: 'all', messageText: '' };

  if (/^off$/i.test(trimmed)) {
    return { mode: 'off', selection: '', messageText: '' };
  }

  const parts = trimmed.split(/\s+/);
  const first = parts[0] || '';
  const rest = trimmed.slice(first.length).trim();

  if (isSelectorToken(first)) {
    if (rest) {
      return { mode: 'send', selection: first, messageText: rest };
    }
    return { mode: 'arm', selection: first, messageText: '' };
  }

  return { mode: 'send', selection: 'all', messageText: trimmed };
}

async function broadcastMessage(bot, senderChatId, recipients, messageText) {
  let delivered = 0;
  const failed = [];
  const deliveries = [];

  for (const recipient of recipients) {
    try {
      const result = await sendRelayedMessage(bot, senderChatId, recipient, messageText, {
        isBroadcast: true,
      });
      if (result?.sentMessage?.message_id) {
        deliveries.push({
          chatId: String(recipient.chatId),
          messageId: Number(result.sentMessage.message_id),
        });
      }
      delivered += 1;
    } catch (err) {
      failed.push(`${formatPersonLabel(recipient)}: ${err.message}`);
    }
  }

  return { delivered, failed, deliveries };
}

async function removeLastMassDm(bot, senderChatId) {
  const batch = await storage.getLastMassDmBatch(senderChatId);
  if (!batch || !Array.isArray(batch.deliveries) || !batch.deliveries.length) {
    return { found: false, deleted: 0, failed: [] };
  }

  let deleted = 0;
  const failed = [];
  const remainingDeliveries = [];

  for (const delivery of batch.deliveries) {
    try {
      await bot.deleteMessage(Number(delivery.chatId), Number(delivery.messageId));
      deleted += 1;
    } catch (error) {
      remainingDeliveries.push(delivery);
      failed.push(`${delivery.chatId}: ${error.message}`);
    }
  }

  if (remainingDeliveries.length) {
    await storage.updateLastMassDmBatch(senderChatId, {
      deliveries: remainingDeliveries,
    });
  } else {
    await storage.clearLastMassDmBatch(senderChatId);
  }

  return {
    found: true,
    deleted,
    failed,
    remaining: remainingDeliveries.length,
  };
}

async function handleAudienceCommand(msg, bot) {
  const chatId = String(msg.chat.id);
  const username = msg.from && msg.from.username;

  if (!HAS_ADMIN_CONFIG) {
    await bot.sendMessage(
      chatId,
      '⚠️ Set ADMIN_CHAT_IDS or ADMIN_USERNAMES in .env to enable /audience.'
    );
    return;
  }

  if (!isAdmin(chatId, username)) {
    await bot.sendMessage(chatId, '⚠️ /audience is restricted to the admin chat.');
    return;
  }

  const audience = await getAudienceUsers();
  await bot.sendMessage(chatId, buildAudienceSummary(audience));
}

async function handleDirectMessageCommand(msg, bot, rawArgs) {
  const chatId = String(msg.chat.id);
  const args = String(rawArgs || '').trim();
  const match = args.match(/^(\S+)\s+([\s\S]+)$/);

  if (!match) {
    await bot.sendMessage(chatId, getChatUsage());
    return;
  }

  const [, targetToken, messageText] = match;
  const target = await resolveKnownTarget(targetToken);

  if (!target) {
    await bot.sendMessage(
      chatId,
      '⚠️ Target user not found. They need to have started the bot first.'
    );
    return;
  }

  const permission = await canMessageTarget(chatId, target.chatId);
  if (!permission.ok) {
    await bot.sendMessage(chatId, permission.message);
    return;
  }

  await sendRelayedMessage(bot, chatId, target, messageText);
  await bot.sendMessage(
    chatId,
    `✅ Message sent to ${formatPersonLabel(target)}. Keep typing here to continue the chat. If multiple chats are active, tag the person first. Use /chat off to stop.`
  );
}

async function sendDirectMessage(bot, fromChatId, targetIdentifier, messageText, meta = {}) {
  const target =
    typeof targetIdentifier === 'object' && targetIdentifier
      ? targetIdentifier
      : await resolveKnownTarget(targetIdentifier);

  if (!target) {
    throw new Error('Target user not found. They need to have started the bot first.');
  }

  const permission = await canMessageTarget(fromChatId, target.chatId);
  if (!permission.ok) {
    throw new Error(permission.message);
  }

  await sendRelayedMessage(bot, fromChatId, target, messageText, meta);
  return target;
}

async function handleMassDmCommand(msg, bot, rawArgs) {
  const chatId = String(msg.chat.id);
  const username = msg.from && msg.from.username;

  if (!HAS_ADMIN_CONFIG) {
    await bot.sendMessage(
      chatId,
      '⚠️ Set ADMIN_CHAT_IDS or ADMIN_USERNAMES in .env to enable /massdm.'
    );
    return;
  }

  if (!isAdmin(chatId, username)) {
    await bot.sendMessage(chatId, '⚠️ /massdm is restricted to the admin chat.');
    return;
  }

  const parsed = splitMassDmArgs(rawArgs);

  if (parsed.mode === 'off') {
    activeBroadcasts.delete(chatId);
    await bot.sendMessage(chatId, '✅ Mass DM mode turned off.');
    return;
  }

  const recipients = await parseRecipients(parsed.selection, chatId);
  if (!recipients.length) {
    await bot.sendMessage(
      chatId,
      `⚠️ No audience found for "${parsed.selection}".\n\n${getMassDmUsage()}`
    );
    return;
  }

  if (parsed.mode === 'send') {
    const result = await broadcastMessage(bot, chatId, recipients, parsed.messageText);
    if (result.deliveries.length) {
      await storage.saveLastMassDmBatch({
        senderChatId: chatId,
        selection: parsed.selection || 'all',
        messageText: parsed.messageText,
        deliveries: result.deliveries,
      });
    }
    await bot.sendMessage(
      chatId,
      [
        `✅ Mass DM sent to ${result.delivered} users.`,
        result.failed.length ? `Failed: ${result.failed.length}` : null,
      ]
        .filter(Boolean)
        .join('\n')
    );
    return;
  }

  activeBroadcasts.set(chatId, {
    recipients,
    selection: parsed.selection || 'all',
  });

  await bot.sendMessage(
    chatId,
    `📣 Mass DM armed for ${recipients.length} users. Send the next plain text message to broadcast, or use /massdm off to cancel.`
  );
}

async function handleChatCommand(msg, bot, rawArgs) {
  const chatId = String(msg.chat.id);
  const targetToken = String(rawArgs || '').trim();

  if (!targetToken) {
    await bot.sendMessage(chatId, getChatUsage());
    return;
  }

  if (/^off$/i.test(targetToken)) {
    await handleEndChatCommand(msg, bot);
    return;
  }

  const target = await resolveKnownTarget(targetToken);
  if (!target) {
    await bot.sendMessage(
      chatId,
      '⚠️ Target user not found. They need to have started the bot first.'
    );
    return;
  }

  const permission = await canMessageTarget(chatId, target.chatId);
  if (!permission.ok) {
    await bot.sendMessage(chatId, permission.message);
    return;
  }

  openChatBridge(chatId, target.chatId);

  await bot.sendMessage(
    chatId,
    `💬 Chat opened with ${formatPersonLabel(target)}. Send plain text messages here. If multiple chats are active, tag the person first. Use /chat off to stop.`
  );

  const sender =
    (await storage.findKnownUser(chatId)) || {
      chatId,
      username: '',
      projectName: '',
      fullName: '',
    };

  await bot.sendMessage(
    Number(target.chatId),
    [
      `💬 Chat with ${formatChatSenderLabel(sender)}`,
      buildReplyInstruction(sender),
    ].join('\n')
  );
}

async function handleEndChatCommand(msg, bot) {
  const chatId = String(msg.chat.id);

  const clearedCount = clearAllChatBridges(chatId);
  if (!clearedCount) {
    await bot.sendMessage(chatId, '⚠️ No active in-bot chat to close.');
    return;
  }

  await bot.sendMessage(
    chatId,
    clearedCount === 1 ? '✅ Chat turned off.' : `✅ ${clearedCount} chats turned off.`
  );
}

async function handleOutgoingMessage(msg, bot) {
  const chatId = String(msg.chat.id);
  const text = String(msg.text || '').trim();

  if (!text || text.startsWith('/')) return false;

  const pendingBroadcast = activeBroadcasts.get(chatId);
  if (pendingBroadcast) {
    activeBroadcasts.delete(chatId);
    const result = await broadcastMessage(
      bot,
      chatId,
      pendingBroadcast.recipients,
      text
    );
    if (result.deliveries.length) {
      await storage.saveLastMassDmBatch({
        senderChatId: chatId,
        selection: pendingBroadcast.selection || 'all',
        messageText: text,
        deliveries: result.deliveries,
      });
    }
    await bot.sendMessage(
      chatId,
      [
        `✅ Mass DM sent to ${result.delivered} users.`,
        result.failed.length ? `Failed: ${result.failed.length}` : null,
      ]
        .filter(Boolean)
        .join('\n')
    );
    return true;
  }

  const targets = await getActiveChatUsers(chatId);
  if (!targets.length) return false;

  let target = null;
  let outgoingText = text;

  if (targets.length === 1) {
    target = targets[0];
    const parsed = resolveTaggedTarget(text, targets);
    if (parsed.usedTag && (!parsed.target || !parsed.messageText)) {
      await bot.sendMessage(chatId, buildTaggedReplyUsage(targets));
      return true;
    }
    if (parsed.target && parsed.messageText) {
      target = parsed.target;
      outgoingText = parsed.messageText;
    }
  } else {
    const parsed = resolveTaggedTarget(text, targets);
    if (!parsed.target || !parsed.messageText) {
      await bot.sendMessage(chatId, buildTaggedReplyUsage(targets));
      return true;
    }
    target = parsed.target;
    outgoingText = parsed.messageText;
  }

  if (!target) {
    await bot.sendMessage(chatId, buildTaggedReplyUsage(targets));
    return true;
  }

  const latestTarget = await storage.findKnownUser(String(target.chatId));
  if (!latestTarget) {
    removeChatBridge(chatId, target.chatId);
    await bot.sendMessage(
      chatId,
      '⚠️ That user is no longer reachable through the bot. Chat closed.'
    );
    return true;
  }

  const permission = await canMessageTarget(chatId, latestTarget.chatId);
  if (!permission.ok) {
    removeChatBridge(chatId, latestTarget.chatId);
    await bot.sendMessage(chatId, permission.message);
    return true;
  }

  await sendRelayedMessage(bot, chatId, latestTarget, outgoingText);
  return true;
}

async function handleRemoveLastMassDmCommand(msg, bot) {
  const chatId = String(msg.chat.id);
  const username = msg.from && msg.from.username;

  if (!HAS_ADMIN_CONFIG) {
    await bot.sendMessage(
      chatId,
      '⚠️ Set ADMIN_CHAT_IDS or ADMIN_USERNAMES in .env to enable /removelastmassdm.'
    );
    return;
  }

  if (!isAdmin(chatId, username)) {
    await bot.sendMessage(chatId, '⚠️ /removelastmassdm is restricted to the admin chat.');
    return;
  }

  const result = await removeLastMassDm(bot, chatId);
  if (!result.found) {
    await bot.sendMessage(chatId, '⚠️ No previous mass DM batch found to remove.');
    return;
  }

  await bot.sendMessage(
    chatId,
    [
      `✅ Removed ${result.deleted} mass DM message(s).`,
      result.failed.length ? `Failed to remove: ${result.failed.length}` : null,
      result.remaining ? `Still pending removal: ${result.remaining}` : null,
    ]
      .filter(Boolean)
      .join('\n')
  );
}

async function openChatFromCallback(query, bot) {
  const data = String(query.data || '');
  if (!data.startsWith('chat_open_')) return false;

  const chatId = String(query.from.id);
  const targetChatId = data.slice('chat_open_'.length);

  const target = await storage.findKnownUser(String(targetChatId));
  if (!target) {
    await bot.answerCallbackQuery(query.id, {
      text: 'User not available anymore.',
      show_alert: true,
    });
    return true;
  }

  const permission = await canMessageTarget(chatId, target.chatId);
  if (!permission.ok) {
    await bot.answerCallbackQuery(query.id, {
      text: permission.message.replace(/^⚠️\s*/, '').slice(0, 180),
      show_alert: true,
    });
    return true;
  }

  openChatBridge(chatId, target.chatId);

  await bot.answerCallbackQuery(query.id, {
    text: 'Chat opened in bot.',
  });

  await bot.sendMessage(
    Number(chatId),
    `💬 Chat opened with ${formatPersonLabel(target)}. Send plain text messages here. If multiple chats are active, tag the person first. Use /chat off to stop.`
  );

  return true;
}

module.exports = {
  clearUserRuntimeState,
  openChatFromCallback,
  sendDirectMessage,
  handleAudienceCommand,
  handleChatCommand,
  handleDirectMessageCommand,
  handleEndChatCommand,
  handleMassDmCommand,
  handleRemoveLastMassDmCommand,
  handleOutgoingMessage,
};
