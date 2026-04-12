// handlers/matchHandler.js
'use strict';

const storage = require("../services/storage");
const matchService = require("../services/matchmaking");
const notification = require("../services/notification");
const reachability = require("../services/reachability");
const {
  matchedProjectCategories,
  matchedLookingFor,
} = require("../utils/categoryFilter");

/* ================= Safe util (no external require risk) ================= */
function getLatestTwitterProfileLink(u) {
  if (!u) return "";
  const uname = String(u).replace(/^@/, "");
  if (/^https?:\/\//i.test(uname)) return uname;
  return `https://x.com/${uname}`;
}

// Replace your escapeMDV2 with this:
function escapeMDV2(input = "") {
  return String(input).replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

function escapeUrlMDV2(url = "") {
  return String(url)
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}


function linkMDV2(text, url) {
  const t = escapeMDV2(text);
  const u = escapeUrlMDV2(url);
  return `[${t}](${u})`;
}

/* ================= Normalizers & helpers ================= */
function toArrMaybeCSV(v) {
  if (Array.isArray(v)) return v;
  if (!v) return [];
  if (typeof v === "string") {
    return v.split(",").map(s => s.trim()).filter(Boolean);
  }
  return [];
}

function normalizeRequests(rows = []) {
  return rows.map((r) => {
    if (Array.isArray(r)) {
      // Expecting [from, to, status, timestamp]
      return {
        from: String(r[0]),
        to: String(r[1]),
        status: String(r[2] || "").toLowerCase(),
      };
    }
    return {
      from: String(r.from),
      to: String(r.to),
      status: String(r.status || "").toLowerCase(),
    };
  });
}

function normalizeRequestStatus(value = '') {
  return String(value || '').trim().toLowerCase();
}

function hasBlockingRelationshipStatus(value = '') {
  return ['pending', 'accepted', 'admin_pending'].includes(
    normalizeRequestStatus(value)
  );
}

function hasAnyCurrentMatch(approvalState = {}) {
  return Array.isArray(approvalState.matchedKeywords) && approvalState.matchedKeywords.length > 0;
}

async function saveContactFlex(fromId, toId, ts) {
  if (typeof storage.saveContact !== "function") return;
  // Try object shape first, then array shape
  try {
    await storage.saveContact({ from: String(fromId), to: String(toId), timestamp: ts });
  } catch (_) {
    await storage.saveContact([String(fromId), String(toId), ts]);
  }
}

const intersects = (A = [], B = []) =>
  Array.isArray(A) && Array.isArray(B) && A.length > 0 && B.length > 0 && A.some((x) => B.includes(x));

/* ================= Formatting helpers ================= */
function formatProfileCard(profile = {}, counterpartProfile = {}) {
  const projectName = escapeMDV2(profile.projectName || "N/A");
  const xUrl = profile.xUrl
    ? linkMDV2("X link", getLatestTwitterProfileLink(profile.xUrl))
    : escapeMDV2("N/A");
  const fullName = escapeMDV2(profile.fullName || "N/A");
  const role = escapeMDV2(profile.role || "N/A");

  const projCatsArr =
    matchedProjectCategories(profile, counterpartProfile) || [];
  const lookingForArr = matchedLookingFor(profile, counterpartProfile) || [];
  const projCats = projCatsArr.map(escapeMDV2).join(", ");
  const lookingFor = lookingForArr.map(escapeMDV2).join(", ");

  return (
    `⭐ *Project:* ${projectName}\n` +
    `🔹 𝕏:${xUrl}\n` +
    `🔹 *Contact Person:* ${fullName}\n` +
    `🔹 *Role:* ${role}\n` +
    `🔹 *Project Category:* ${projCats || escapeMDV2("N/A")}\n` +
    `🔹 *Project is looking for:* ${lookingFor || escapeMDV2("N/A")}\n` +
    `🔹 *Telegram:* ${escapeMDV2("🔒")}\n\n` +
    `${escapeMDV2("Are you interested in partnering with this project?")}\n` +
    `${escapeMDV2(
      "(Note: Telegram details will be revealed after mutual acceptance.)"
    )}`
  );
}

function formatAdminProfileBlock(p = {}, cat, lookingForCat) {
  const projectName = escapeMDV2(p.projectName || "N/A");
  const xLink = p.xUrl
    ? linkMDV2("X link", getLatestTwitterProfileLink(p.xUrl))
    : escapeMDV2("N/A");
  const fullName = escapeMDV2(p.fullName || "N/A");
  const role = escapeMDV2(p.role || "N/A");

  const projCats = Array.isArray(cat)
    ? cat.map(escapeMDV2).join(", ")
    : escapeMDV2("N/A");
  const lookingFor = Array.isArray(lookingForCat)
    ? lookingForCat.map(escapeMDV2).join(", ")
    : escapeMDV2("N/A");

  const username = p.username
    ? `@${escapeMDV2(String(p.username).replace(/^@/, ""))}`
    : escapeMDV2("N/A");

  return (
    `⭐ *Project:* ${projectName}\n` +
    `🔹 𝕏: ${xLink}\n` +
    `🔹 *Contact Person:* ${fullName}\n` +
    `🔹 *Role:* ${role}\n` +
    `🔹 *Project Category:* ${projCats}\n` +
    `🔹 *Project is looking for:* ${lookingFor}\n` +
    `🔹 *Telegram:* ${username}`
  );
}

function formatRevealCard(who = {}, viewer = {}) {
  const projectName = escapeMDV2(who.projectName || "N/A");
  const xLink = who.xUrl
    ? linkMDV2("X link", getLatestTwitterProfileLink(who.xUrl))
    : escapeMDV2("N/A");
  const fullName = escapeMDV2(who.fullName || "N/A");
  const role = escapeMDV2(who.role || "N/A");
  const projCatsArr = matchedProjectCategories(who, viewer) || [];
  const lookingForArr = matchedLookingFor(who, viewer) || [];
  const projCats = projCatsArr.map(escapeMDV2).join(", ");
  const lookingFor = lookingForArr.map(escapeMDV2).join(", ");

  const tg = who.username
    ? `@${escapeMDV2(String(who.username).replace(/^@/, ""))}`
    : escapeMDV2("N/A");

  return (
    `⭐ *Project:* ${projectName}\n` +
    `🔹 𝕏: ${xLink}\n` +
    `🔹 *Contact Person:* ${fullName}\n` +
    `🔹 *Role:* ${role}\n` +
    `🔹 *Project Category:* ${projCats || escapeMDV2("N/A")}\n` +
    `🔹 *Project is looking for:* ${lookingFor || escapeMDV2("N/A")}\n` +
    `🔹 *Telegram:* ${tg}`
  );
}

function parseAdminMatchCallback(data = '') {
  const match = String(data || '').match(
    /^admin_match_(approve|reject)_(-?\d+)_(-?\d+)$/
  );
  if (!match) return null;

  return {
    action: match[1],
    fromId: String(match[2] || ''),
    toId: String(match[3] || ''),
  };
}

async function setInlineButtonState(bot, message, text) {
  if (!message?.chat?.id || !message?.message_id) return;

  try {
    await bot.editMessageReplyMarkup(
      {
        inline_keyboard: [[{ text, callback_data: 'noop' }]],
      },
      { chat_id: message.chat.id, message_id: message.message_id }
    );
  } catch (error) {
    if (!/message is not modified/i.test(String(error?.message || error))) {
      throw error;
    }
  }
}

async function sendApprovedConnectionNotice(bot, recipientId, counterpartProfile, viewerProfile) {
  await bot.sendMessage(
    Number(recipientId),
    `${escapeMDV2("✅ Admin approved this match. You are now connected.")}\n\n` +
      formatRevealCard(counterpartProfile, viewerProfile),
    {
      parse_mode: "MarkdownV2",
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [[
          { text: "💬 Message in Bot", callback_data: `chat_open_${counterpartProfile.chatId}` },
        ]],
      },
    }
  );
}

async function safeSendStatusMessage(bot, recipientId, text, username = '') {
  try {
    await bot.sendMessage(Number(recipientId), text, {
      parse_mode: "MarkdownV2",
      disable_web_page_preview: true,
    });
  } catch (error) {
    if (reachability.isTelegramUnavailableError(error)) {
      await reachability.markTelegramUnavailable(recipientId, {
        username,
        reason: reachability.getTelegramUnavailableReason(error),
        error,
      });
      return false;
    }
    throw error;
  }

  return true;
}

/* ================= Core flows ================= */

// After registration completes, trigger notifications to potential matches
async function onNewRegistration(profile, bot) {
  try {
    const matches = await matchService.findMatches(profile);
    if (!matches?.length) return;

    for (const m of matches) {
      if (!m?.chatId) continue; // cannot DM if they never started the bot
      await notification.notifyUser(bot, m.chatId, profile);
    }
  } catch (e) {
    console.error("onNewRegistration error:", e);
  }
}

async function showIncomingOnlyLeads(chatId, bot) {
  return bot.sendMessage(
    chatId,
    escapeMDV2(
      "📥 No leads available right now."
    ),
    { parse_mode: "MarkdownV2" }
  );
}

// /match — find and display mutual-interest + one-way (supply-only) matches
async function handleMatchCommand(msg, bot) {
  const chatId = msg.chat.id;

  try {
    if (await storage.isBlockedUser(chatId, msg.from?.username || '')) {
      return bot.sendMessage(chatId, '⛔ Your access to this bot is currently blocked.');
    }

    const users = await storage.getUsers();
    const rawRequests = await storage.getRequests();
    const requests = normalizeRequests(rawRequests);
    const contacts = await storage.getContactsFor(String(chatId));
    const connectedIds = new Set(
      (contacts || []).map((contact) => String(contact.contactId || ''))
    );

    const myProfile = users.find((u) => Number(u.chatId) === Number(chatId));
    if (!myProfile) {
      return bot.sendMessage(
        chatId,
        escapeMDV2("⚠️ You need to register first with /start."),
        { parse_mode: "MarkdownV2" }
      );
    }
    if (!storage.isActiveUserStatus(myProfile.status)) {
      return bot.sendMessage(
        chatId,
        escapeMDV2("⚠️ Your profile is not active right now."),
        { parse_mode: "MarkdownV2" }
      );
    }

    // Ensure arrays
    myProfile.categories  = toArrMaybeCSV(myProfile.categories);
    myProfile.lookingFor  = toArrMaybeCSV(myProfile.lookingFor);

    const leadAccess = await storage.getLeadAccess(myProfile);
    if (leadAccess.mode === "incoming_only") {
      return showIncomingOnlyLeads(chatId, bot);
    }

    const others = [];
    for (const user of users) {
      if (Number(user.chatId) === Number(chatId)) continue;
      if (!storage.isActiveUserStatus(user.status)) continue;
      if (await storage.isBlockedUser(user.chatId, user.username)) continue;
      if (reachability.isTelegramBlocked(user.chatId)) continue;
      others.push(user);
    }

    // --- 1) Mutual-interest (both directions intersect) ---
    const mutualMatches = others.filter((u) => {
      const uCats = toArrMaybeCSV(u.categories);
      const uLF   = toArrMaybeCSV(u.lookingFor);
      return (
        intersects(uCats, myProfile.lookingFor) && // they provide what I want
        intersects(myProfile.categories, uLF)      // I provide what they want
      );
    });

    // --- 2) One-way supply-only: they are looking for what I provide ---
    // Example: Kundan is looking for Development; Sumit provides Development,
    // even if Sumit isn't looking for Kundan's categories.
    const mutualIds = new Set(mutualMatches.map((m) => String(m.chatId)));

    const supplyOnlyMatches = others.filter((u) => {
      if (mutualIds.has(String(u.chatId))) return false; // de-dupe
      const uLF = toArrMaybeCSV(u.lookingFor);
      return intersects(uLF, myProfile.categories); // they need what I provide
    });

    // Final ordered list: mutual first (higher relevance), then supply-only
    const relationshipIds = new Set(
      requests
        .filter((request) => {
          const status = normalizeRequestStatus(request.status);
          if (!hasBlockingRelationshipStatus(status)) return false;

          return (
            (request.from === String(chatId) || request.to === String(chatId))
          );
        })
        .map((request) =>
          request.from === String(chatId) ? String(request.to) : String(request.from)
        )
    );

    const matches = [...mutualMatches, ...supplyOnlyMatches].filter((match) => {
      const id = String(match.chatId);
      return !connectedIds.has(id) && !relationshipIds.has(id);
    });

    if (matches.length === 0) {
      return bot.sendMessage(
        chatId,
        escapeMDV2("🔍 No new matching profiles found right now."),
        { parse_mode: "MarkdownV2" }
      );
    }

    for (const match of matches) {
      const text = formatProfileCard(match, myProfile);
      const button = { text: "🤝 Send Request", callback_data: `send_req_${match.chatId}` };

      await bot.sendMessage(chatId, text, {
        parse_mode: "MarkdownV2",
        disable_web_page_preview: true,
        reply_markup: { inline_keyboard: [[button]] },
      });
    }
  } catch (err) {
    console.error("❌ Error in handleMatchCommand:", err);
    await bot.sendMessage(
      chatId,
      escapeMDV2("⚠️ Something went wrong while finding matches."),
      { parse_mode: "MarkdownV2" }
    );
  }
}

/* ================= Inline callback handler ================= */

async function handleCallback(query, bot) {
  const data = query.data || "";
  const me   = String(query.from.id);
  const msg  = query.message;

  const adminAction = parseAdminMatchCallback(data);
  if (adminAction) {
    const { action, fromId, toId } = adminAction;

    try {
      const latestRequest = await storage.getLatestRequestBetween(fromId, toId);
      const latestStatus = normalizeRequestStatus(latestRequest?.status);

      if (latestStatus !== 'admin_pending') {
        const label =
          latestStatus === 'accepted'
            ? '✅ Approved'
            : latestStatus === 'admin_rejected'
              ? '❌ Rejected'
              : 'ℹ️ Already processed';
        await setInlineButtonState(bot, msg, label);
        await bot.answerCallbackQuery(query.id, {
          text:
            latestStatus === 'accepted'
              ? 'This match has already been approved.'
              : latestStatus === 'admin_rejected'
                ? 'This match has already been rejected.'
                : 'This match is no longer awaiting admin approval.',
        });
        return;
      }

      if (action === 'reject') {
        await storage.upsertRequestStatus(fromId, toId, 'admin_rejected');
        const sourceProfile = await storage.getSingleUser(fromId);
        const targetProfile = await storage.getSingleUser(toId);
        const rejectionText = escapeMDV2(
          "❌ This match could not be approved by admin, so profile details cannot be shared."
        );

        if (sourceProfile) {
          await safeSendStatusMessage(
            bot,
            fromId,
            rejectionText,
            sourceProfile.username
          );
        }
        if (targetProfile) {
          await safeSendStatusMessage(
            bot,
            toId,
            rejectionText,
            targetProfile.username
          );
        }
        await setInlineButtonState(bot, msg, '❌ Rejected');
        await bot.answerCallbackQuery(query.id, { text: '❌ Match rejected.' });
        return;
      }

      const sourceProfile = await storage.getSingleUser(fromId);
      const targetProfile = await storage.getSingleUser(toId);
      if (!sourceProfile || !targetProfile) {
        await bot.answerCallbackQuery(query.id, {
          text: '❌ One of these profiles no longer exists.',
          show_alert: true,
        });
        return;
      }

      const [sourceAvailability, targetAvailability] = await Promise.all([
        storage.canAttemptUserContact(sourceProfile),
        storage.canAttemptUserContact(targetProfile),
      ]);

      if (!sourceAvailability.ok || !targetAvailability.ok) {
        await bot.answerCallbackQuery(query.id, {
          text: '⚠️ One of these users is blocked, inactive, or unreachable right now.',
          show_alert: true,
        });
        return;
      }

      const approvalKeywords = await matchService.getAdminApprovalKeywords();
      const approvalState = matchService.getMatchApprovalState(
        sourceProfile,
        targetProfile,
        approvalKeywords
      );
      const stillMatching = hasAnyCurrentMatch(approvalState);

      if (!stillMatching) {
        await storage.upsertRequestStatus(fromId, toId, 'admin_rejected');
        await setInlineButtonState(bot, msg, '❌ No Longer Matching');
        await bot.answerCallbackQuery(query.id, {
          text: '❌ These profiles no longer match.',
          show_alert: true,
        });
        return;
      }

      const ts = new Date().toISOString();
      await storage.upsertRequestStatus(fromId, toId, 'accepted', ts);
      if (!(await storage.hasContactBetween(fromId, toId))) {
        await saveContactFlex(fromId, toId, ts);
        await saveContactFlex(toId, fromId, ts);
      }

      const notificationFailures = [];

      try {
        await sendApprovedConnectionNotice(bot, fromId, targetProfile, sourceProfile);
      } catch (error) {
        if (reachability.isTelegramUnavailableError(error)) {
          await reachability.markTelegramUnavailable(fromId, {
            username: sourceProfile.username,
            reason: reachability.getTelegramUnavailableReason(error),
            error,
          });
          notificationFailures.push(fromId);
        } else {
          throw error;
        }
      }

      try {
        await sendApprovedConnectionNotice(bot, toId, sourceProfile, targetProfile);
      } catch (error) {
        if (reachability.isTelegramUnavailableError(error)) {
          await reachability.markTelegramUnavailable(toId, {
            username: targetProfile.username,
            reason: reachability.getTelegramUnavailableReason(error),
            error,
          });
          notificationFailures.push(toId);
        } else {
          throw error;
        }
      }

      await setInlineButtonState(bot, msg, '✅ Approved');
      await bot.answerCallbackQuery(query.id, {
        text: notificationFailures.length
          ? 'Approved, but one user could not be notified.'
          : '✅ Match approved and users notified.',
      });
    } catch (err) {
      console.error("Error handling admin match approval:", err);
      await bot.answerCallbackQuery(query.id, {
        text: "❌ Admin action failed.",
        show_alert: true,
      });
    }
    return;
  }

  // 1) Send Request (no username reveal here)
  if (data.startsWith("send_req_")) {
    const target = data.split("_")[2];

    try {
      if (!target || isNaN(Number(target))) {
        await bot.answerCallbackQuery(query.id, {
          text: "❌ Could not send request (invalid target).",
          show_alert: true,
        });
        return;
      }

      const targetProfile = await storage.getSingleUser(String(target));
      const users = await storage.getUsers();
      const requester = users.find((u) => String(u.chatId) === me);

      if (!requester) {
        await bot.answerCallbackQuery(query.id, {
          text: "❌ Could not send request (requester not found).",
          show_alert: true,
        });
        return;
      }

      if (!storage.isActiveUserStatus(requester.status)) {
        await bot.answerCallbackQuery(query.id, {
          text: "Your profile is not active right now.",
          show_alert: true,
        });
        return;
      }

      if (targetProfile) {
        const targetAvailability = await storage.canAttemptUserContact(targetProfile);
        if (!targetAvailability.ok || reachability.isTelegramBlocked(target)) {
          await bot.answerCallbackQuery(query.id, {
            text:
              targetAvailability.reason === 'unreachable'
                ? "That user cannot be reached in the bot right now."
                : "That user is blocked or not active right now.",
            show_alert: true,
          });
          return;
        }
      }

      const latestRequest = await storage.getLatestRequestBetween(me, target);
      if (latestRequest && hasBlockingRelationshipStatus(latestRequest.status)) {
        const existingStatus = normalizeRequestStatus(latestRequest.status);
        if (existingStatus === 'accepted') {
          await setInlineButtonState(bot, msg, '✅ Connected');
        } else if (existingStatus === 'admin_pending') {
          await setInlineButtonState(bot, msg, '✅ Request Sent');
        } else {
          await setInlineButtonState(bot, msg, '✅ Request Sent');
        }
        await bot.answerCallbackQuery(query.id, {
          text:
            existingStatus === 'accepted'
              ? 'You are already connected with this user.'
              : 'You already sent a request to this user.',
          show_alert: true,
        });
        return;
      }

      // If target hasn't registered/started the bot, we cannot DM them → queue it and tell requester how to invite
      if (!targetProfile) {
        await storage.upsertRequestStatus(me, String(target), "pending");
        await setInlineButtonState(bot, msg, "✅ Request Sent");
        const meInfo = await bot.getMe();
        const deepLink = `https://t.me/${meInfo.username}?start=${me}`;
        await bot.answerCallbackQuery(query.id, { text: "✅ Request queued" });
        await bot.sendMessage(
          Number(me),
          escapeMDV2("📨 Your request is saved. Ask them to start the bot using this link so they receive it:\n") +
            escapeMDV2(deepLink),
          { parse_mode: "MarkdownV2" }
        );
        return;
      }

      await storage.upsertRequestStatus(me, String(target), "pending");
      await setInlineButtonState(bot, msg, "✅ Request Sent");

      // Target exists → DM with preview and Accept/Decline
      await bot.answerCallbackQuery(query.id, { text: "✅ Request sent!" });

      const card = formatProfileCard(requester, targetProfile);
      try {
        await bot.sendMessage(Number(target), card, {
          parse_mode: "MarkdownV2",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "✅ Accept",  callback_data: `accept_${me}` },
                { text: "❌ Decline", callback_data: `decline_${me}` },
              ],
            ],
          },
          disable_web_page_preview: true,
        });
      } catch (error) {
        if (reachability.isTelegramUnavailableError(error)) {
          await reachability.markTelegramUnavailable(target, {
            username: targetProfile.username,
            reason: reachability.getTelegramUnavailableReason(error),
            error,
          });
          await bot.answerCallbackQuery(query.id, {
            text: "That user cannot be reached in the bot right now.",
            show_alert: true,
          });
          return;
        }
        throw error;
      }
    } catch (err) {
      console.error("Error sending request:", err);
      await bot.answerCallbackQuery(query.id, {
        text: "❌ Could not send request.",
        show_alert: true,
      });
    }
    return;
  }

  // 2) Accept or Decline
  const [action, otherIdRaw] = data.split("_");
  if (action === "accept" || action === "decline") {
    const otherId = String(otherIdRaw);
    const status  = action === "accept" ? "accepted" : "declined";

    try {
      const actorProfile     = await storage.getSingleUser(me);
      const requesterProfile = await storage.getSingleUser(otherId);

      if (!actorProfile || !requesterProfile) {
        await bot.answerCallbackQuery(query.id, {
          text: "❌ Profile not found.",
          show_alert: true,
        });
        return;
      }

      const requesterAvailability = await storage.canAttemptUserContact(requesterProfile);
      if (
        !storage.isActiveUserStatus(actorProfile.status) ||
        !storage.isActiveUserStatus(requesterProfile.status) ||
        reachability.isTelegramBlocked(otherId) ||
        !requesterAvailability.ok
      ) {
        await bot.answerCallbackQuery(query.id, {
          text:
            requesterAvailability.reason === 'unreachable'
              ? "This user cannot be reached in the bot right now."
              : "This user is blocked or not active right now.",
          show_alert: true,
        });
        return;
      }

      const approvalKeywords = await matchService.getAdminApprovalKeywords();
      const approvalState = matchService.getMatchApprovalState(
        requesterProfile,
        actorProfile,
        approvalKeywords
      );
      const latestRelationship = await storage.getLatestRequestBetween(otherId, me);
      const latestRelationshipStatus = normalizeRequestStatus(latestRelationship?.status);

      if (latestRelationshipStatus === 'admin_pending') {
        await bot.answerCallbackQuery(query.id, {
          text: "✅ Request sent.",
        });
        await setInlineButtonState(bot, msg, "✅ Request Sent");
        return;
      }

      if (status === "accepted" && approvalState.requiresAdminApproval) {
        await storage.upsertRequestStatus(otherId, me, "admin_pending");
        await notification.notifyAdminsForApproval(
          bot,
          requesterProfile,
          actorProfile,
          approvalState
        );
        await bot.answerCallbackQuery(query.id, {
          text: "✅ Request sent.",
        });
        await setInlineButtonState(bot, msg, "✅ Request Sent");
        return;
      }

      await storage.upsertRequestStatus(otherId, me, status);

      // Acknowledge tap
      await bot.answerCallbackQuery(query.id, {
        text: status === "accepted" ? "✅ You accepted" : "❌ You declined",
      });

      // Flip local markup
      await setInlineButtonState(
        bot,
        msg,
        status === "accepted" ? "✅ Accepted" : "❌ Declined"
      );

      if (status === "accepted") {
        const ts = new Date().toISOString();

        // Two-way save contact
        await saveContactFlex(me, otherId, ts);
        await saveContactFlex(otherId, me, ts);

        // Build mirrored reveal cards
        const toRequester =
          `${escapeMDV2("🎉 Your request has been accepted!")}\n\n` +
          formatRevealCard(actorProfile, requesterProfile);

        const toAcceptor =
          `${escapeMDV2("🤝 Connection confirmed!")}\n\n` +
          formatRevealCard(requesterProfile, actorProfile);

        // Notify both parties
        try {
          await bot.sendMessage(Number(otherId), toRequester, {
            parse_mode: "MarkdownV2",
            disable_web_page_preview: true,
            reply_markup: {
              inline_keyboard: [[
                { text: "💬 Message in Bot", callback_data: `chat_open_${me}` },
              ]],
            },
          });
        } catch (error) {
          if (reachability.isTelegramUnavailableError(error)) {
            await reachability.markTelegramUnavailable(otherId, {
              username: requesterProfile.username,
              reason: reachability.getTelegramUnavailableReason(error),
              error,
            });
          } else {
            throw error;
          }
        }

        await bot.sendMessage(Number(me), toAcceptor, {
          parse_mode: "MarkdownV2",
          disable_web_page_preview: true,
          reply_markup: {
            inline_keyboard: [[
              { text: "💬 Message in Bot", callback_data: `chat_open_${otherId}` },
            ]],
          },
          reply_to_message_id: msg?.message_id,
        });
      } else {
        try {
          await bot.sendMessage(
            Number(otherId),
            escapeMDV2(`${actorProfile.projectName || "The project"} declined your request. ❌`),
            { parse_mode: "MarkdownV2" }
          );
        } catch (error) {
          if (reachability.isTelegramUnavailableError(error)) {
            await reachability.markTelegramUnavailable(otherId, {
              username: requesterProfile.username,
              reason: reachability.getTelegramUnavailableReason(error),
              error,
            });
          } else {
            throw error;
          }
        }
      }
    } catch (err) {
      console.error("Error handling accept/decline:", err);
      await bot.answerCallbackQuery(query.id, {
        text: "❌ Action failed.",
        show_alert: true,
      });
    }
    return;
  }

  // 3) No-op
  if (data === "noop") {
    return bot.answerCallbackQuery(query.id);
  }
}

/* ================= Exports ================= */
module.exports = {
  handleMatchCommand,
  handleCallback,
  onNewRegistration,
};
