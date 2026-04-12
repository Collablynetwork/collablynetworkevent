const storage = require("../services/storage");
const { ADMIN_CHAT_IDS } = require("../config");
const { getLatestTwitterProfileLink } = require("../utils");
const matchService = require("./matchmaking");
const reachability = require("./reachability");

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function normalizeRequestStatus(value = "") {
  return String(value || "").trim().toLowerCase();
}

function hasBlockingRelationshipStatus(value = "") {
  return ["pending", "accepted", "admin_pending"].includes(
    normalizeRequestStatus(value)
  );
}

function formatAdminProfileSummary(profile = {}, matchLines = []) {
  const normalizedXUrl = getLatestTwitterProfileLink(profile.xUrl);
  const xLinkLine = normalizedXUrl
    ? `<a href="${escapeHtml(normalizedXUrl)}">X profile</a>`
    : "N/A";

  return [
    `🏷️ Project: <b>${escapeHtml(profile.projectName || "N/A")}</b>`,
    `🔗 X(Twitter): ${xLinkLine}`,
    `👤 Contact Person: ${escapeHtml(profile.fullName || "N/A")}`,
    `🧠 Role: ${escapeHtml(profile.role || "N/A")}`,
    `🧩 Project type: ${escapeHtml(
      Array.isArray(profile.categories) ? profile.categories.join(", ") || "N/A" : "N/A"
    )}`,
    `🔎 Looking for: ${escapeHtml(
      Array.isArray(profile.lookingFor) ? profile.lookingFor.join(", ") || "N/A" : "N/A"
    )}`,
    ...matchLines,
    `📞 Telegram: ${escapeHtml(
      profile.username ? `@${String(profile.username).replace(/^@/, "")}` : String(profile.chatId || "N/A")
    )}`,
  ].join("\n");
}

async function notifyAdminsForApproval(bot, sourceProfile, targetProfile, approvalState) {
  const fromId = String(sourceProfile.chatId || "").trim();
  const toId = String(targetProfile.chatId || "").trim();
  const adminChatIds = Array.isArray(ADMIN_CHAT_IDS) ? ADMIN_CHAT_IDS : [];

  if (!fromId || !toId) {
    return { notified: false, count: 0 };
  }

  if (!adminChatIds.length) {
    console.warn(
      `⚠️ Admin approval required for ${fromId} ↔ ${toId}, but no ADMIN_CHAT_IDS are configured.`
    );
    return { notified: false, count: 0 };
  }

  const approvalKeywords = Array.isArray(approvalState?.approvalMatchedKeywords)
    ? approvalState.approvalMatchedKeywords
    : [];

  const sourceMatchLines = [];
  const targetMatchLines = [];

  if (approvalState?.sourceToTarget?.builds?.length) {
    sourceMatchLines.push(
      `🎯 They build: ${escapeHtml(approvalState.sourceToTarget.builds.join(", "))}`
    );
  }
  if (approvalState?.sourceToTarget?.needs?.length) {
    sourceMatchLines.push(
      `🔍 They need: ${escapeHtml(approvalState.sourceToTarget.needs.join(", "))}`
    );
  }
  if (approvalState?.targetToSource?.builds?.length) {
    targetMatchLines.push(
      `🎯 They build: ${escapeHtml(approvalState.targetToSource.builds.join(", "))}`
    );
  }
  if (approvalState?.targetToSource?.needs?.length) {
    targetMatchLines.push(
      `🔍 They need: ${escapeHtml(approvalState.targetToSource.needs.join(", "))}`
    );
  }

  const text = [
    "🛡️ Admin approval required for this match",
    "",
    `🔐 Approval keywords: <b>${escapeHtml(approvalKeywords.join(", ") || "N/A")}</b>`,
    "",
    "<b>Profile 1</b>",
    formatAdminProfileSummary(sourceProfile, sourceMatchLines),
    "",
    "<b>Profile 2</b>",
    formatAdminProfileSummary(targetProfile, targetMatchLines),
    "",
    "Approve to connect both users and reveal their profiles in the bot.",
  ].join("\n");

  let sentCount = 0;

  for (const adminChatId of adminChatIds) {
    try {
      await bot.sendMessage(adminChatId, text, {
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: {
          inline_keyboard: [[
            {
              text: "✅ Approve Match",
              callback_data: `admin_match_approve_${fromId}_${toId}`,
            },
            {
              text: "❌ Reject Match",
              callback_data: `admin_match_reject_${fromId}_${toId}`,
            },
          ]],
        },
      });
      sentCount += 1;
    } catch (error) {
      console.warn(
        `⚠️ Failed to notify admin ${adminChatId} for match approval ${fromId} ↔ ${toId}:`,
        error?.message || error
      );
    }
  }

  return { notified: sentCount > 0, count: sentCount };
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

  if (await storage.hasContactBetween(newProfile.chatId, userId)) {
    return;
  }

  const latestRequest = await storage.getLatestRequestBetween(
    newProfile.chatId,
    userId
  );
  if (latestRequest && hasBlockingRelationshipStatus(latestRequest.status)) {
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

  const approvalKeywords = await matchService.getAdminApprovalKeywords();
  const approvalState = matchService.getMatchApprovalState(
    newProfile,
    user,
    approvalKeywords
  );

  if (approvalState.requiresAdminApproval) {
    await storage.upsertRequestStatus(
      String(newProfile.chatId || ""),
      String(userId || ""),
      "admin_pending"
    );
    await notifyAdminsForApproval(bot, newProfile, user, approvalState);
    return;
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

module.exports = { notifyUser, notifyAdminsForApproval };
