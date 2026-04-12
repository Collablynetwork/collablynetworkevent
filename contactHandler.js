// handlers/contactHandler.js
'use strict';

const storage = require("../services/storage");
const matchService = require("../services/matchmaking");
const chatHandler = require("./chatHandler");
const { getLatestTwitterProfileLink } = require("../utils");
const {
  FOUNDER_NAME,
  FOUNDER_TELEGRAM_USERNAME_DISPLAY,
  isAdmin,
} = require("../config");
const {
  matchedProjectCategories,
  matchedLookingFor,
} = require("../utils/categoryFilter");

const FOUNDER_TITLE = "Founder & CEO, Collably Network";
const FOUNDER_LINKEDIN_URL = "https://www.linkedin.com/in/sumitkumarblockchain";
const COLLAB_NETWORK_X_URL = "https://x.com/collablynetwork/";
const REMINDER_COOLDOWN_HOURS = 72;
const REMINDER_COOLDOWN_MS = REMINDER_COOLDOWN_HOURS * 60 * 60 * 1000;
const trackedContactMessages = new Map();
const trackedMessagesByTarget = new Map();
const reminderReactivationTimers = new Map();

/* ============ MarkdownV2 helpers ============ */
function escapeMDV2(input = "") {
  const s = String(input);
  return s
    .replace(/\\/g, "\\\\")                                   // backslash first
    .replace(/[_*[\](){}`>#+\-=|{}.!]/g, (m) => "\\" + m);    // escape MDV2 specials
}
function escapeUrlMDV2(url = "") {
  return String(url)
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}
function linkMDV2(text, url) {
  return `[${escapeMDV2(text)}](${escapeUrlMDV2(url)})`;
}

function toArrMaybeCSV(v) {
  if (Array.isArray(v)) return v;
  if (!v) return [];
  if (typeof v === "string") return v.split(",").map(s => s.trim()).filter(Boolean);
  return [];
}

function formatContactCard(u, myProfile) {
  // Normalize admin-approved list once
  const ADMIN = (matchService.getAdminApprovalKeywordsSync?.() || [])
    .map((x) => String(x).toLowerCase().trim());

  const anyApproved = (arr) =>
    Array.isArray(arr) &&
    arr.some((c) => ADMIN.includes(String(c).toLowerCase().trim()));

  const projectName = escapeMDV2(u?.projectName || "N/A");
  const xLink = u?.xUrl
    ? linkMDV2("Check X Profile", getLatestTwitterProfileLink(u.xUrl))
    : escapeMDV2("N/A");
  const fullName = escapeMDV2(u?.fullName || "N/A");
  const role = escapeMDV2(u?.role || "N/A");

  // Get raw matched arrays first (not escaped, not joined)
  const projCatsArr = matchedProjectCategories(u || {}, myProfile || {}) || [];
  const lookingForArr = matchedLookingFor(u || {}, myProfile || {}) || [];

  // Display-friendly strings
  const projCats =
    projCatsArr.length ? projCatsArr.map(escapeMDV2).join(", ") : escapeMDV2("N/A");
  const lookingFor =
    lookingForArr.length ? lookingForArr.map(escapeMDV2).join(", ") : escapeMDV2("N/A");

  // Determine if any admin-approved category is present among matched sets
  const isAdminApprovedMatch = anyApproved(projCatsArr) || anyApproved(lookingForArr);

  // Telegram handle
  const userHandle = u?.username
    ? `@${escapeMDV2(String(u.username).replace(/^@/, ""))}`
    : escapeMDV2("N/A");
  const adminHandle = escapeMDV2("@collablynetwork_admin");
  const tgid = isAdminApprovedMatch ? adminHandle : userHandle;

  return (
    `⭐ *Project:* ${projectName}\n` +
    `🔹 *𝕏:* ${xLink}\n` +
    `🔹 *Contact Person:* ${fullName}\n` +
    `🔹 *Role:* ${role}\n` +
    `🔹 *Project Category:* ${projCats}\n` +
    `🔹 *Project is looking for:* ${lookingFor}\n` +
    `🔹 *Telegram:* ${tgid}`
  );
}

function formatPendingContactCard(u) {
  const userHandle = u?.username
    ? `@${escapeMDV2(String(u.username).replace(/^@/, ""))}`
    : escapeMDV2("N/A");

  return (
    `⭐ *Project:* ${escapeMDV2("Profile not created yet")}\n` +
    `🔹 *Status:* ${escapeMDV2("Started the bot but has not completed profile setup")}\n` +
    `🔹 *Telegram:* ${userHandle}`
  );
}

function buildProfileReminderMessage(user) {
  const userHandle = String(user?.username || "").trim().replace(/^@/, "");
  const greeting = userHandle ? `Hey @${userHandle},` : "Hey,";
  const founderTelegram = String(FOUNDER_TELEGRAM_USERNAME_DISPLAY || "collablynetworkCEO")
    .trim()
    .replace(/^@/, "");

  return [
    greeting,
    "please create a profile to find your perfect match.",
    "",
    "Regards,",
    FOUNDER_NAME || "Sumit",
    FOUNDER_TITLE,
    `X: ${COLLAB_NETWORK_X_URL}`,
    `LinkedIn: ${FOUNDER_LINKEDIN_URL}`,
    `TG: @${founderTelegram}`,
  ].join("\n");
}

function getReminderCooldownState(user) {
  const lastReminderAt = String(user?.lastReminderAt || "").trim();
  const lastReminderTs = Date.parse(lastReminderAt);

  if (!lastReminderAt || Number.isNaN(lastReminderTs)) {
    return { active: false, lastReminderAt: "" };
  }

  return {
    active: Date.now() - lastReminderTs < REMINDER_COOLDOWN_MS,
    lastReminderAt,
  };
}

function getTrackedMessageKey(chatId, messageId) {
  return `${chatId}:${messageId}`;
}

function getPendingTargetIdsForPage(bundle, start = 0) {
  const end = Math.min(start + PAGE_SIZE, bundle.mine.length);
  const pendingTargetIds = [];

  for (let i = start; i < end; i++) {
    const c = bundle.mine[i];
    const nonUser = bundle.nonUsers.find((x) => String(x.chatId) === String(c.contactId));
    if (nonUser) {
      pendingTargetIds.push(String(nonUser.chatId));
    }
  }

  return pendingTargetIds;
}

function removeTrackedMessage(messageKey) {
  const existing = trackedContactMessages.get(messageKey);
  if (!existing) return;

  for (const targetChatId of existing.targetChatIds) {
    const messageKeys = trackedMessagesByTarget.get(targetChatId);
    if (!messageKeys) continue;

    messageKeys.delete(messageKey);
    if (!messageKeys.size) {
      trackedMessagesByTarget.delete(targetChatId);
    }
  }

  trackedContactMessages.delete(messageKey);
}

function updateTrackedMessage(message, bundle, start = 0, username = '') {
  const chatId = String(message?.chat?.id || '');
  const messageId = message?.message_id;
  if (!chatId || !messageId) return;

  const messageKey = getTrackedMessageKey(chatId, messageId);
  removeTrackedMessage(messageKey);

  const targetChatIds = getPendingTargetIdsForPage(bundle, start);
  if (!targetChatIds.length) return;

  const record = {
    chatId,
    messageId,
    viewerChatId: String(bundle.viewerChatId || chatId),
    username: String(username || ''),
    start,
    targetChatIds,
  };

  trackedContactMessages.set(messageKey, record);

  for (const targetChatId of targetChatIds) {
    const messageKeys = trackedMessagesByTarget.get(targetChatId) || new Set();
    messageKeys.add(messageKey);
    trackedMessagesByTarget.set(targetChatId, messageKeys);
  }
}

function scheduleVisibleReminderRefreshes(bot, bundle, start = 0) {
  const end = Math.min(start + PAGE_SIZE, bundle.mine.length);

  for (let i = start; i < end; i++) {
    const c = bundle.mine[i];
    const nonUser = bundle.nonUsers.find((x) => String(x.chatId) === String(c.contactId));
    if (!nonUser) continue;

    const reminderState = getReminderCooldownState(nonUser);
    if (reminderState.active) {
      scheduleReminderReactivation(bot, nonUser.chatId, nonUser.lastReminderAt);
    }
  }
}

/* ============ Internal helpers for pagination & dedupe ============ */
const PAGE_SIZE = 10;
const CONTACT_SEPARATOR = escapeMDV2("┄┄┄┄┄┄┄┄┄┄┄┄");

async function loadMyContactsBundle(chatId) {
  const me = String(chatId);

  // Pull all contacts (support both getContactsFor and getContacts)
  let rows = [];
  if (typeof storage.getContactsFor === 'function') {
    rows = await storage.getContactsFor(me);
  } else if (typeof storage.getContacts === 'function') {
    rows = await storage.getContacts();
  } else {
    rows = [];
  }

  // Normalize rows to { from, to, timestamp }
  const contacts = (Array.isArray(rows) ? rows : []).map((c) => {
    if (Array.isArray(c)) {
      return {
        from: String(c[0] ?? ""),
        to: String(c[1] ?? ""),
        timestamp: String(c[2] ?? ""),
      };
    }
    const from = c.from ?? c.user ?? "";
    const to = c.to ?? c.contactId ?? c.contactName ?? "";
    const ts = c.timestamp ?? c.ts ?? "";
    return { from: String(from), to: String(to), timestamp: String(ts) };
  });

  // Keep only relationships involving me, normalize to outward direction (me -> other)
  const mapped = contacts
    .filter((r) => r.from === me || r.to === me)
    .map((r) => ({
      user: (r.from === me ? me : r.to),
      contactId: (r.from === me ? r.to : r.from),
      timestamp: r.timestamp || "",
    }))
    .filter((c) => c.user === me && c.contactId);

  // DEDUPE by contactId, keeping the LATEST timestamp
  const latestByOther = new Map();
  for (const c of mapped) {
    const prev = latestByOther.get(c.contactId);
    const curTs = Date.parse(c.timestamp || 0) || 0;
    const prevTs = prev ? (Date.parse(prev.timestamp || 0) || 0) : -1;
    if (!prev || curTs > prevTs) latestByOther.set(c.contactId, c);
  }
  // Sorted newest first
  const mine = Array.from(latestByOther.values())
    .sort((a, b) => (Date.parse(b.timestamp || 0) || 0) - (Date.parse(a.timestamp || 0) || 0));

  // Load profiles
  const [users, nonUsers, myProfile] = await Promise.all([
    storage.getUsers(),
    (typeof storage.getNonRegisteredUsers === 'function' ? storage.getNonRegisteredUsers() : Promise.resolve([])),
    storage.getSingleUser(me),
  ]);

  return { mine, users, nonUsers, myProfile };
}

function renderContactsSlice({ mine, users, nonUsers, myProfile }, start = 0, viewer = {}) {
  const end = Math.min(start + PAGE_SIZE, mine.length);
  const lines = [];
  const buttons = [];
  const viewerIsAdmin = isAdmin(viewer.chatId, viewer.username);

  for (let i = start; i < end; i++) {
    const c = mine[i];
    const u = users.find((x) => String(x.chatId) === String(c.contactId));
    if (u) {
      lines.push(formatContactCard(u, myProfile));
    } else {
      const nonUser = nonUsers.find((x) => String(x.chatId) === String(c.contactId));
      if (nonUser) {
        lines.push(formatPendingContactCard(nonUser));
        if (viewerIsAdmin) {
          const handle = nonUser.username
            ? `@${String(nonUser.username).replace(/^@/, "")}`
            : `chat ${nonUser.chatId}`;
          const reminderState = getReminderCooldownState(nonUser);
          buttons.push([{
            text: reminderState.active ? "✅ Reminder sent" : `💬 Remind ${handle}`,
            callback_data: reminderState.active
              ? "noop"
              : `contacts_remind_profile_${start}_${nonUser.chatId}`,
          }]);
        }
      } else {
        lines.push(
          `🆔 *Contact ID:* ${escapeMDV2(String(c.contactId))}\n` +
          `${escapeMDV2('ℹ️ Details not available yet.')}` // ← ESCAPED (dot included)
        );
      }
    }

    if (i < end - 1) {
      lines.push("");
      lines.push(CONTACT_SEPARATOR);
      lines.push("");
    }
  }

  const body = lines.join("\n").trim();
  const header = escapeMDV2("Your Contacts");
  const title =
    mine.length > 0
      ? `${header}\n_${escapeMDV2(`Showing ${start + 1}-${end} of ${mine.length}`)}_`
      : header;

  return {
    text: `${title}\n\n${body}`,
    hasMore: end < mine.length,
    nextStart: end,
    buttons,
  };
}

function buildContactsMessage(bundle, start = 0, username = '') {
  const { text, hasMore, nextStart, buttons } = renderContactsSlice(bundle, start, {
    chatId: bundle.viewerChatId,
    username,
  });

  const keyboard = [...buttons];
  if (hasMore) {
    keyboard.push([{ text: "▶️ Show more", callback_data: `contacts_more_${nextStart}` }]);
  }

  return {
    text,
    options: {
      parse_mode: "MarkdownV2",
      disable_web_page_preview: true,
      reply_markup: keyboard.length ? { inline_keyboard: keyboard } : undefined,
    },
  };
}

async function sendContactsPage(bot, chatId, start = 0, username = '') {
  const bundle = await loadMyContactsBundle(chatId);
  if (bundle.mine.length === 0) {
    return bot.sendMessage(chatId, escapeMDV2("You have no contacts yet."), {
      parse_mode: "MarkdownV2",
    });
  }

  bundle.viewerChatId = chatId;
  const { text, options } = buildContactsMessage(bundle, start, username);
  const sentMessage = await bot.sendMessage(chatId, text, options);
  updateTrackedMessage(sentMessage, bundle, start, username);
  scheduleVisibleReminderRefreshes(bot, bundle, start);
  return sentMessage;
}

async function refreshContactsMessage(bot, message, chatId, start = 0, username = '') {
  const bundle = await loadMyContactsBundle(chatId);

  if (bundle.mine.length === 0) {
    try {
      await bot.editMessageText(escapeMDV2("You have no contacts yet."), {
        chat_id: message.chat.id,
        message_id: message.message_id,
        parse_mode: "MarkdownV2",
      });
    } catch (_) {}
    return;
  }

  bundle.viewerChatId = chatId;
  const { text, options } = buildContactsMessage(bundle, start, username);

  try {
    await bot.editMessageText(text, {
      chat_id: message.chat.id,
      message_id: message.message_id,
      ...options,
    });
  } catch (err) {
    const msg = String(err?.message || err?.description || "");
    if (!/message is not modified/i.test(msg)) {
      throw err;
    }
  }

  updateTrackedMessage(message, bundle, start, username);
  scheduleVisibleReminderRefreshes(bot, bundle, start);
}

async function refreshTrackedMessagesForTarget(bot, targetChatId) {
  const messageKeys = Array.from(
    trackedMessagesByTarget.get(String(targetChatId)) || []
  );

  for (const messageKey of messageKeys) {
    const record = trackedContactMessages.get(messageKey);
    if (!record) continue;

    try {
      await refreshContactsMessage(
        bot,
        { chat: { id: Number(record.chatId) }, message_id: record.messageId },
        record.viewerChatId,
        record.start,
        record.username
      );
    } catch (err) {
      console.warn("refreshTrackedMessagesForTarget failed:", err?.message || err);
      removeTrackedMessage(messageKey);
    }
  }
}

function clearReminderReactivationTimer(targetChatId) {
  const existing = reminderReactivationTimers.get(String(targetChatId));
  if (existing) {
    clearTimeout(existing);
    reminderReactivationTimers.delete(String(targetChatId));
  }
}

function scheduleReminderReactivation(bot, targetChatId, lastReminderAt) {
  const targetId = String(targetChatId);
  const reminderTs = Date.parse(String(lastReminderAt || ""));
  if (Number.isNaN(reminderTs)) return;

  clearReminderReactivationTimer(targetId);

  const delay = Math.max(0, reminderTs + REMINDER_COOLDOWN_MS - Date.now());
  const timer = setTimeout(async () => {
    reminderReactivationTimers.delete(targetId);
    await refreshTrackedMessagesForTarget(bot, targetId);
  }, delay);

  reminderReactivationTimers.set(targetId, timer);
}

async function handleProfileCompleted(bot, targetChatId) {
  clearReminderReactivationTimer(targetChatId);
  await refreshTrackedMessagesForTarget(bot, targetChatId);
}

function clearUserRuntimeState(identifier) {
  const chatId =
    identifier && typeof identifier === 'object'
      ? String(identifier.chatId || '').trim()
      : String(identifier || '').trim();

  if (!chatId) {
    return {
      trackedContactMessages: 0,
      reminderTimers: 0,
    };
  }

  const messageKeys = new Set([
    ...Array.from(trackedMessagesByTarget.get(chatId) || []),
  ]);

  for (const [messageKey, record] of trackedContactMessages.entries()) {
    const targetChatIds = Array.isArray(record?.targetChatIds) ? record.targetChatIds : [];
    if (
      String(record?.viewerChatId || '') === chatId ||
      String(record?.chatId || '') === chatId ||
      targetChatIds.some((targetId) => String(targetId) === chatId)
    ) {
      messageKeys.add(messageKey);
    }
  }

  let trackedMessageCount = 0;
  for (const messageKey of messageKeys) {
    if (!trackedContactMessages.has(messageKey)) continue;
    removeTrackedMessage(messageKey);
    trackedMessageCount += 1;
  }

  const hadTimer = reminderReactivationTimers.has(chatId);
  clearReminderReactivationTimer(chatId);

  return {
    trackedContactMessages: trackedMessageCount,
    reminderTimers: hadTimer ? 1 : 0,
  };
}

/* ============ /contacts command (first page) ============ */
async function showContacts(msg, bot) {
  const chatId = String(msg.chat.id);
  try {
    await sendContactsPage(bot, chatId, 0, msg.from?.username || '');
  } catch (err) {
    console.error("Error in showContacts:", err);
    await bot.sendMessage(chatId, escapeMDV2("⚠️ Failed to load contacts."), {
      parse_mode: "MarkdownV2",
    });
  }
}

/* ============ Inline callbacks ============ */
async function handleCallback(query, bot) {
  const data = query?.data || "";
  const chatId = String(query.message?.chat?.id ?? query.from.id);

  try {
    // Pagination: contacts_more_<offset>
    if (data.startsWith("contacts_more_")) {
      const offsetStr = data.slice("contacts_more_".length);
      const offset = Math.max(0, Number(offsetStr) || 0);

      await bot.answerCallbackQuery(query.id);

      // Optional: clear old button to avoid duplicate presses
      try {
        await bot.editMessageReplyMarkup(
          { inline_keyboard: [] },
          { chat_id: query.message.chat.id, message_id: query.message.message_id }
        );
      } catch (_) {}

      return sendContactsPage(bot, chatId, offset, query.from?.username || '');
    }

    if (data.startsWith("contacts_remind_profile_")) {
      const payload = data.slice("contacts_remind_profile_".length);
      const parts = payload.split("_");
      const pageStart = Math.max(0, Number(parts[0]) || 0);
      const targetChatId = parts.slice(1).join("_");
      const target = await storage.findKnownUser(targetChatId);

      if (!isAdmin(chatId, query.from?.username || '')) {
        await bot.answerCallbackQuery(query.id, {
          text: "Admin only.",
          show_alert: true,
        });
        return;
      }

      if (!target || target.registered) {
        await refreshContactsMessage(
          bot,
          query.message,
          chatId,
          pageStart,
          query.from?.username || ''
        );
        await bot.answerCallbackQuery(query.id, {
          text: "This user already completed the profile or is unavailable.",
          show_alert: true,
        });
        return;
      }

      const pendingUsers = await storage.getNonRegisteredUsers();
      const pendingTarget = pendingUsers.find(
        (user) => String(user.chatId) === String(target.chatId)
      );
      const reminderState = getReminderCooldownState(pendingTarget);

      if (reminderState.active) {
        await refreshContactsMessage(
          bot,
          query.message,
          chatId,
          pageStart,
          query.from?.username || ''
        );
        await bot.answerCallbackQuery(query.id, {
          text: "Reminder already sent. Try again after 72 hours.",
        });
        return;
      }

      const reminderTimestamp = new Date().toISOString();
      await chatHandler.sendDirectMessage(bot, chatId, target.chatId, buildProfileReminderMessage(target));
      await storage.markNonRegisteredReminderSent(target.chatId, reminderTimestamp);
      scheduleReminderReactivation(bot, target.chatId, reminderTimestamp);
      await refreshContactsMessage(
        bot,
        query.message,
        chatId,
        pageStart,
        query.from?.username || ''
      );

      await bot.answerCallbackQuery(query.id, {
        text: "Reminder sent in bot.",
      });
      return;
    }

    // Accept button (if you’re using it here): accept_<id>
    if (data.startsWith("accept_")) {
      const otherId = data.slice(7);

      if (!otherId || isNaN(Number(otherId))) {
        await bot.answerCallbackQuery(query.id, {
          text: "❌ Invalid contact.",
          show_alert: true,
        });
        return;
      }

      // Best-effort no-duplicate save
      try {
        // First check existing
        let existing = [];
        if (typeof storage.getContactsFor === 'function') {
          existing = await storage.getContactsFor(chatId);
        } else if (typeof storage.getContacts === 'function') {
          existing = await storage.getContacts();
        }
        const norm = (Array.isArray(existing) ? existing : []).map((c) => {
          if (Array.isArray(c)) return { from: String(c[0]||''), to: String(c[1]||'') };
          const from = c.from ?? c.user ?? '';
          const to = c.to ?? c.contactId ?? c.contactName ?? '';
          return { from: String(from), to: String(to) };
        });
        const exists = norm.some(
          (r) =>
            (r.from === chatId && r.to === String(otherId)) ||
            (r.from === String(otherId) && r.to === chatId)
        );
        if (!exists) {
          try {
            await storage.saveContact({ user: chatId, contactId: String(otherId), timestamp: new Date().toISOString() });
          } catch {
            await storage.saveContact([chatId, String(otherId), new Date().toISOString()]);
          }
        }
      } catch {}

      await bot.answerCallbackQuery(query.id, {
        text: "✅ Added to contacts!",
      });
      return;
    }

    // ignore others
  } catch (err) {
    console.error("handleCallback error:", err);
    if (query?.id) {
      await bot.answerCallbackQuery(query.id, {
        text: "❌ Something went wrong.",
        show_alert: true,
      });
    }
  }
}

module.exports = { showContacts, handleCallback, handleProfileCompleted, clearUserRuntimeState };
