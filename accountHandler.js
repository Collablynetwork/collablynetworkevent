// handlers/accountHandler.js
const notifyService = require("../services/notification");
const matchService  = require("../services/matchmaking");
const storage       = require("../services/storage");
const contactHandler = require("./contactHandler");
const { getLatestTwitterProfileLink } = require("../utils");
const { sendMainMenu } = require("../utils/menu");
const { generateStylizedQR } = require("../utils/generateStylizedQR");
const { PROJECT_CATEGORY_OPTIONS } = require("../utils/projectCategories");
const fs = require("fs");

const sessions = {};

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────
const NOTIF_ACTIVE = "active";
const NOTIF_MUTED  = "muted";

// ─────────────────────────────────────────────────────────────
// Field flow config
// ─────────────────────────────────────────────────────────────
const FIELDS = [
  { key: "fullName",    prompt: "Enter your full name:",                     type: "text" },
  { key: "projectName", prompt: "Enter your project name:",                  type: "text" },
  {
    key: "xUrl",
    prompt: "Send your project's X handle or profile link (username, @username, or https://x.com/username):",
    type: "text",
  },
  { key: "role",        prompt: "What is your role in the project?",         type: "text" },
  {
    key: "categories",
    prompt: "Please choose your project type. You may select up to 8 categories:",
    type: "multi",
    options: PROJECT_CATEGORY_OPTIONS,
    limit: 8,
  },
  {
    key: "lookingFor",
    prompt: "What kind of project are you looking for? Pick up to 30 categories:",
    type: "multi",
    options: PROJECT_CATEGORY_OPTIONS,
    limit: 40,
  },
];

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
function initFlow(chatId, mode, initialData = {}) {
  sessions[chatId] = { mode, step: 0, data: { ...initialData } };
}

function hasActiveSession(chatId) {
  return Boolean(sessions[chatId]);
}

function buildKeyboard(field, selected) {
  const { options, key } = field;
  const perRow = 3;
  const rows = [];

  options.forEach((opt, i) => {
    const text = (selected.has(opt) ? "✅ " : "") + opt;
    const btn = { text, callback_data: `${key}_${opt}` };
    const r = Math.floor(i / perRow);
    rows[r] = rows[r] || [];
    rows[r].push(btn);
  });

  rows.push([{ text: "Submit", callback_data: `submit_${key}` }]);
  return rows;
}

function toggleSet(set, value, limit) {
  if (set.has(value)) {
    set.delete(value);
    return true;
  }
  if (set.size < limit) {
    set.add(value);
    return true;
  }
  return false;
}

function arrFromMaybeSet(v) {
  if (v instanceof Set) return Array.from(v);
  if (Array.isArray(v)) return v;
  if (!v) return [];
  if (typeof v === "string") return v.split(",").map(s => s.trim()).filter(Boolean);
  return [];
}

function normalizeComparableSelection(value) {
  return arrFromMaybeSet(value)
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
}

function haveSameSelections(left, right) {
  const normalizedLeft = normalizeComparableSelection(left);
  const normalizedRight = normalizeComparableSelection(right);

  if (normalizedLeft.length !== normalizedRight.length) return false;
  return normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

function shouldRefreshMatchesForProfileUpdate(previousProfile, nextProfile) {
  if (!previousProfile) return true;

  return !(
    haveSameSelections(previousProfile.categories, nextProfile.categories) &&
    haveSameSelections(previousProfile.lookingFor, nextProfile.lookingFor)
  );
}

async function pruneOutdatedContactsAfterProfileUpdate(profile) {
  const chatId = String(profile?.chatId || "").trim();
  if (!chatId) {
    return {
      removedUsers: [],
      removedContacts: 0,
      removedRequests: 0,
    };
  }

  const [contacts, users] = await Promise.all([
    storage.getContactsFor(chatId),
    storage.getUsers(),
  ]);

  const userByChatId = new Map(
    users.map((user) => [String(user.chatId || "").trim(), user])
  );
  const seen = new Set();
  const removedUsers = [];
  let removedContacts = 0;
  let removedRequests = 0;

  for (const contact of contacts || []) {
    const otherChatId = String(contact?.contactId || "").trim();
    if (!otherChatId || seen.has(otherChatId)) continue;
    seen.add(otherChatId);

    const otherUser = userByChatId.get(otherChatId);
    if (!otherUser) continue;

    const approvalState = matchService.getMatchApprovalState(profile, otherUser);
    const stillMutual =
      approvalState.sourceToTarget.builds.length > 0 &&
      approvalState.sourceToTarget.needs.length > 0;

    if (stillMutual) continue;

    const removal = await storage.clearMatchRelationship(chatId, otherChatId);
    if (!removal.removedContacts && !removal.removedRequests) {
      continue;
    }

    removedContacts += Number(removal.removedContacts || 0);
    removedRequests += Number(removal.removedRequests || 0);
    removedUsers.push(otherUser);
  }

  return {
    removedUsers,
    removedContacts,
    removedRequests,
  };
}

async function notifyAllMatchedProfiles(bot, profile, matches = []) {
  const myChatId = Number(profile?.chatId);
  const seen = new Set();

  for (const match of Array.isArray(matches) ? matches : []) {
    const matchChatId = Number(match?.chatId);
    if (!matchChatId || matchChatId === myChatId || seen.has(matchChatId)) {
      continue;
    }
    seen.add(matchChatId);

    await notifyService.notifyUser(bot, matchChatId, profile);
    await notifyService.notifyUser(bot, myChatId, match);
  }
}

function statusLabel(s) {
  const v = String(s || "").toLowerCase();
  return v === NOTIF_MUTED ? "🔕 Notification switched OFF" : "🔔 Notification switched ON";
}

function isMutedStatus(s) {
  const v = String(s || "").toLowerCase();
  // backward-compat with older values
  return v === NOTIF_MUTED || v === "mute" || v === "paused" || v === "pause";
}

function normalizeStatus(s) {
  return isMutedStatus(s) ? NOTIF_MUTED : NOTIF_ACTIVE;
}

function isMessageNotModifiedError(error) {
  const message = String(
    error?.response?.body?.description || error?.message || error || ""
  );
  return /message is not modified/i.test(message);
}

function formatProfileEditUnlockDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "after 30 days";
  return date.toLocaleString("en-IN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function buildEditLimitReachedMessage(allowance) {
  const nextDate = allowance && allowance.nextAvailableAt
    ? formatProfileEditUnlockDate(allowance.nextAvailableAt)
    : "30 days";

  return [
    "⚠️ You have already used 2 profile updates in the last 30 days.",
    `You can update your profile again after ${nextDate}.`,
  ].join("\n");
}

function buildPostEditLimitMessage(allowance) {
  if (!allowance) return "✅ Profile updated!";

  if (allowance.remaining === 1) {
    return [
      "✅ Profile updated!",
      "You have one more chance left to update your profile within 30 days.",
    ].join("\n");
  }

  if (allowance.remaining <= 0) {
    const nextDate = allowance.nextAvailableAt
      ? formatProfileEditUnlockDate(allowance.nextAvailableAt)
      : "30 days";

    return [
      "✅ Profile updated!",
      `You have used both profile updates in the last 30 days. You can update your profile again after ${nextDate}.`,
    ].join("\n");
  }

  return "✅ Profile updated!";
}

// ─────────────────────────────────────────────────────────────
// Start / Edit
// ─────────────────────────────────────────────────────────────
async function handleStart(msg, bot) {
  const chatId = msg.chat.id;
  const users  = await storage.getUsers();
  const exists = users.some(u => Number(u.chatId) === chatId);

  if (exists) {
    const me = await storage.getSingleUser(String(chatId));
    await bot.sendMessage(chatId, "👋 You are already registered!");
    return sendMainMenu(bot, chatId, normalizeStatus(me && me.status));
  }

  initFlow(chatId, "register");
  sessions[chatId].data.username = msg.from.username || "";

  await bot.sendMessage(chatId, "👋 Welcome! Let’s set up your profile.");
  await askField(chatId, bot);
}

async function startEditProfile(msg, bot) {
  const chatId = msg.chat.id;
  const users  = await storage.getUsers();
  const me     = users.find(u => Number(u.chatId) === chatId);
  if (!me) {
    return bot.sendMessage(chatId, "⚠️ You need to register first with /start.");
  }
  const allowance = await storage.getProfileEditAllowance(me);
  if (!allowance.ok) {
    return bot.sendMessage(chatId, buildEditLimitReachedMessage(allowance));
  }
  initFlow(chatId, "edit", me);
  sessions[chatId].data.username = me.username || "";
  sessions[chatId].originalData = {
    ...me,
    categories: arrFromMaybeSet(me.categories),
    lookingFor: arrFromMaybeSet(me.lookingFor),
  };
  await bot.sendMessage(chatId, "✏️ Let’s update your profile.");
  await askField(chatId, bot);
}

// ─────────────────────────────────────────────────────────────
// Field Flow
// ─────────────────────────────────────────────────────────────
async function askField(chatId, bot) {
  const session = sessions[chatId];
  const field   = FIELDS[session.step];

  if (!field) return finalizeFlow(chatId, bot);

  if (field.type === "text") {
    return bot.sendMessage(chatId, field.prompt);
  }

  if (field.type === "multi") {
    if (!(session.data[field.key] instanceof Set)) {
      session.data[field.key] = new Set(arrFromMaybeSet(session.data[field.key]));
    }
    return bot.sendMessage(chatId, field.prompt, {
      reply_markup: { inline_keyboard: buildKeyboard(field, session.data[field.key]) },
    });
  }
}

async function handleMessage(msg, bot) {
  const chatId = msg.chat.id;
  const session = sessions[chatId];
  if (!session) return;

  const field = FIELDS[session.step];
  if (!field) return;

  if (field.type !== "text") {
    await bot.sendMessage(chatId, "Use the buttons to select options, then tap Submit.");
    return;
  }

  const rawValue = (msg.text || "").trim();
  session.data[field.key] =
    field.key === "xUrl" ? (getLatestTwitterProfileLink(rawValue) || "") : rawValue;
  session.step++;
  await askField(chatId, bot);
}

async function handleCallbackQuery(query, bot) {
  const chatId = query.message.chat.id;
  const session = sessions[chatId];
  if (!session) return;

  const field = FIELDS[session.step];
  const data  = query.data || "";

  if (field && field.type === "multi") {
    const prefix = `${field.key}_`;
    if (data.startsWith(prefix)) {
      const choice = data.slice(prefix.length);
      const changed = toggleSet(session.data[field.key], choice, field.limit);

      if (!changed) {
        await bot.answerCallbackQuery(query.id, {
          text: `You can select up to ${field.limit}.`,
          show_alert: false,
        });
        return;
      }

      await bot.answerCallbackQuery(query.id);

      try {
        await bot.editMessageReplyMarkup(
          { inline_keyboard: buildKeyboard(field, session.data[field.key]) },
          { chat_id: chatId, message_id: query.message.message_id }
        );
      } catch (error) {
        if (!isMessageNotModifiedError(error)) {
          throw error;
        }
      }
      return;
    }
    if (data === `submit_${field.key}`) {
      await bot.answerCallbackQuery(query.id);
      session.data[field.key] = Array.from(session.data[field.key] || []);
      session.step++;
      await askField(chatId, bot);
      return;
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Finalize & Save
// ─────────────────────────────────────────────────────────────
async function finalizeFlow(chatId, bot) {
  const session = sessions[chatId];
  const data    = session.data;
  const originalProfile = session.originalData || null;

  const cats  = arrFromMaybeSet(data.categories);
  const looks = arrFromMaybeSet(data.lookingFor);

  // default to ACTIVE on new registration; on edit keep previous (if present)
  const intendedStatus =
    session.mode === "register" ? NOTIF_ACTIVE : normalizeStatus(data.status);

  const row = [
    data.fullName || "",
    data.projectName || "",
    getLatestTwitterProfileLink(data.xUrl) || getLatestTwitterProfileLink(data.username) || "",
    data.role || "",
    cats.join(","),
    looks.join(","),
    String(data.chatId || chatId),
    data.username || "",
    intendedStatus,
  ];
  const profile = {
    ...data,
    fullName: data.fullName || "",
    projectName: data.projectName || "",
    xUrl: getLatestTwitterProfileLink(data.xUrl) || getLatestTwitterProfileLink(data.username) || "",
    role: data.role || "",
    categories: cats,
    lookingFor: looks,
    chatId,
    username: data.username || "",
    status: intendedStatus,
  };

  if (session.mode === "register") {
    await storage.saveUser(row);
    await contactHandler.handleProfileCompleted(bot, String(data.chatId || chatId));

    const approvalKeywords = await matchService.getAdminApprovalKeywords();
    if (matchService.hasAdminApprovalKeyword(looks, approvalKeywords)) {
      await storage.saveLead({
        username: data.username || "",
        categories: cats,
        lookingFor: looks,
        xUrl: getLatestTwitterProfileLink(data.xUrl) || "",
        projectName: data.projectName || "",
        chatId: String(data.chatId || chatId),
      });
    }
    await bot.sendMessage(chatId, "✅ Profile created!");
  } else {
    const allowanceBeforeSave = await storage.getProfileEditAllowance(profile);
    if (!allowanceBeforeSave.ok) {
      delete sessions[chatId];
      await bot.sendMessage(chatId, buildEditLimitReachedMessage(allowanceBeforeSave));
      const meAfterBlocked = await storage.getSingleUser(String(chatId));
      await sendMainMenu(bot, chatId, normalizeStatus(meAfterBlocked && meAfterBlocked.status));
      return;
    }

    await storage.updateUser(row);
    await storage.recordProfileUpdate(profile);

    let prunedRelationships = {
      removedUsers: [],
      removedContacts: 0,
      removedRequests: 0,
    };
    if (shouldRefreshMatchesForProfileUpdate(originalProfile, profile)) {
      prunedRelationships = await pruneOutdatedContactsAfterProfileUpdate(profile);
    }

    const allowanceAfterSave = await storage.getProfileEditAllowance(profile);
    const updateMessage = buildPostEditLimitMessage(allowanceAfterSave);
    const removalLine = prunedRelationships.removedUsers.length
      ? `Removed ${prunedRelationships.removedUsers.length} contact(s) that no longer match your updated profile.`
      : "";
    await bot.sendMessage(
      chatId,
      [updateMessage, removalLine].filter(Boolean).join("\n")
    );
  }

  const shouldRefreshMatches =
    session.mode === "register" ||
    shouldRefreshMatchesForProfileUpdate(originalProfile, profile);

  if (shouldRefreshMatches) {
    const matches = await matchService.findMatches(profile);
    await notifyAllMatchedProfiles(bot, profile, matches);
  }

  delete sessions[chatId];

  const meAfter = await storage.getSingleUser(String(chatId));
  await sendMainMenu(bot, chatId, normalizeStatus(meAfter && meAfter.status));
}

// ─────────────────────────────────────────────────────────────
// Notifications: active/muted
// ─────────────────────────────────────────────────────────────
async function writeStatusToStorage(me, newStatus) {
  const chatId = String(me.chatId);

  // Try dedicated methods first
  if (typeof storage.updateUserStatus === "function") {
    return storage.updateUserStatus(chatId, newStatus);
  }
  if (typeof storage.setUserStatus === "function") {
    return storage.setUserStatus(chatId, newStatus);
  }
  // Try partial update style
  if (typeof storage.updateUser === "function") {
    try { return await storage.updateUser(chatId, { status: newStatus }); } catch {}
  }
  if (typeof storage.upsertUser === "function") {
    try { return await storage.upsertUser(chatId, { status: newStatus }); } catch {}
  }
  // Try full row rewrite (fallback to your row schema)
  const cats  = arrFromMaybeSet(me.categories);
  const looks = arrFromMaybeSet(me.lookingFor);
  const rowArray = [
    me.fullName || "",
    me.projectName || "",
    me.xUrl || "",
    me.role || "",
    cats.join(","),
    looks.join(","),
    String(chatId),
    me.username || "",
    newStatus,
  ];
  if (typeof storage.updateUser === "function") {
    return storage.updateUser(rowArray);
  }
  if (typeof storage.saveUser === "function") {
    return storage.saveUser(rowArray);
  }
  // Last resort
  if (typeof storage.setFieldForUser === "function") {
    return storage.setFieldForUser(chatId, "status", newStatus);
  }
  throw new Error("No storage method available to persist user status.");
}

async function handleChangeStatus(msg, bot) {
  const chatId = String(msg.chat.id);
  try {
    const me = await storage.getSingleUser(chatId);
    if (!me) {
      await bot.sendMessage(chatId, "⚠️ You need to register first with /start.");
      return;
    }

    const current   = normalizeStatus(me.status);
    const newStatus = current === NOTIF_MUTED ? NOTIF_ACTIVE : NOTIF_MUTED;

    await writeStatusToStorage(me, newStatus);
    return sendMainMenu(
      bot,
      chatId,
      newStatus,
      `Status updated: ${statusLabel(newStatus)}`
    );
  } catch (err) {
    console.error("handleChangeStatus error:", err);
    await bot.sendMessage(chatId, "⚠️ Couldn't change your status. Please try again.");
  }
}

// ─────────────────────────────────────────────────────────────
// Share Profile
// ─────────────────────────────────────────────────────────────
async function shareProfile(msg, bot) {
  const chatId = msg.chat.id;
  const users  = await storage.getUsers();
  const me     = users.find(u => Number(u.chatId) === chatId);

  if (!me) {
    return bot.sendMessage(chatId, "❌ You need to register first.");
  }

  const meInfo      = await bot.getMe();
  const botUsername = meInfo.username;
  const shareLink   = `https://t.me/${botUsername}?start=${me.chatId}`;

  const qrPath = await generateStylizedQR(
    shareLink,
    me.username || "user",
    `qr-${me.chatId}.png`,
    "dark"
  );

  await bot.sendPhoto(chatId, fs.readFileSync(qrPath), {
    caption: `⛶ Your QR Profile — scan to connect.\nOr share this link:\n${shareLink}`,
});
}
// ─────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────
module.exports = {
  handleMessage,
  handleCallbackQuery,
  handleStart,
  hasActiveSession,
  startEditProfile,
  shareProfile,
  handleChangeStatus,
  statusLabel,
  getLatestTwitterProfileLink,
};
