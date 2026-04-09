const storage = require("../services/storage");
const { getLatestTwitterProfileLink } = require("../utils");
const reachability = require("./reachability");

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function notifyUser(bot, userId, newProfile) {
  if (!userId || isNaN(Number(userId))) {
    console.warn(`❌ Invalid userId: ${userId}`);
    return;
  }

  const normalizedUserId = String(userId);
  if (reachability.isTelegramBlocked(normalizedUserId)) {
    return;
  }

  const targetAvailability = await storage.canAttemptUserContact(userId);
  if (!targetAvailability.ok) {
    return;
  }

  const sourceAvailability = await storage.canAttemptUserContact(newProfile);
  if (!sourceAvailability.ok) {
    return;
  }

  const user = targetAvailability.user;

  const requests = await storage.getRequests();
  const existingRequest = requests.some((request) => {
    const status = String(request.status || '').toLowerCase();
    const from = String(request.from || '');
    const to = String(request.to || '');
    const newChatId = String(newProfile.chatId || '');
    const targetChatId = String(userId || '');

    return (
      (status === 'pending' || status === 'accepted') &&
      ((from === newChatId && to === targetChatId) ||
        (from === targetChatId && to === newChatId))
    );
  });

  if (existingRequest) {
    return;
  }

  // 🎯 Match: newProfile.categories ∩ user.lookingFor
  const newCategories = Array.isArray(newProfile.categories) ? newProfile.categories : [];
  const newLookingFor = Array.isArray(newProfile.lookingFor) ? newProfile.lookingFor : [];
  const userLookingFor = Array.isArray(user.lookingFor) ? user.lookingFor : [];
  const userCategories = Array.isArray(user.categories) ? user.categories : [];

  const matchedProjectCategories = newCategories.filter((cat) =>
    userLookingFor.includes(cat)
  );

  // 🔍 Match: newProfile.lookingFor ∩ user.categories
  const matchedLookingFor = newLookingFor.filter((looking) =>
      userCategories.includes(looking)
  );
  const normalizedXUrl = getLatestTwitterProfileLink(newProfile.xUrl);
  const xLinkLine = normalizedXUrl
    ? `<a href="${escapeHtml(normalizedXUrl)}">X profile</a>`
    : "N/A";

  const perfectMatchLines = [];
  if (matchedProjectCategories.length) {
    perfectMatchLines.push(
      `🎯 They build: ${escapeHtml(
        matchedProjectCategories.join(", ")
      )}`
    );
  }
  if (matchedLookingFor.length) {
    perfectMatchLines.push(
      `🔍 They need: ${escapeHtml(
        matchedLookingFor.join(", ")
      )}`
    );
  }

  const text = [
    "🤝 A potential partner match was found",
    "",
    `🏷️ Project: <b>${escapeHtml(newProfile.projectName || "N/A")}</b>`,
    `🔗 X(Twitter): ${xLinkLine}`,
    `👤 Contact Person: ${escapeHtml(newProfile.fullName || "N/A")}`,
    `🧠 Role: ${escapeHtml(newProfile.role || "N/A")}`,
    perfectMatchLines.length ? "" : null,
    perfectMatchLines.length ? "<b>Perfect match</b>" : null,
    ...perfectMatchLines,
    "",
    "📞 Telegram: 🔒",
    "",
    "Are you interested in partnering with this project?",
    "Telegram details will be revealed only after mutual acceptance.",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    await bot.sendMessage(userId, text, {
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "🤝 Send Request",
              callback_data: `send_req_${newProfile.chatId}`,
            },
          ],
        ],
      },
    });
  } catch (err) {
    if (reachability.isTelegramUnavailableError(err)) {
      const reason = reachability.getTelegramUnavailableReason(err) || 'unreachable';
      await reachability.markTelegramUnavailable(normalizedUserId, {
        username: user.username,
        reason,
        error: err,
      });
      console.warn(`ℹ️ Skipping notifications for ${userId}: Telegram user is ${reason}.`);
      return;
    }
    console.error(`⚠️ Failed to notify user ${userId}:`, err.message);
  }
}

module.exports = { notifyUser };
