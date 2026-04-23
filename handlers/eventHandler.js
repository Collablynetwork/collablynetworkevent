const storage = require("../services/storage");
const reachability = require("../services/reachability");
const { getLatestTwitterProfileLink } = require("../utils");
const {
  matchedProjectCategories,
  matchedLookingFor,
} = require("../utils/categoryFilter");

/** ---------- helpers ---------- **/

function buildShareText(ev, botUsername) {
  return [
    `\n⭐ ${ev.title}`,
    `⌛${ev.description}`,
    `📅 ${ev.date}   🕒 ${ev.time}`,
    `🎟️ ${ev.apply}`,
    `📍 ${ev.location}`,
    ``,
    `👉 RSVP & details: https://t.me/${botUsername}`,
  ].join("\n");
}

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildEventConnectCallback(action, otherChatId, eventId) {
  return `event_connect_${action}_${String(otherChatId)}_${String(eventId)}`;
}

function parseEventConnectCallback(data) {
  const match = String(data || "").match(/^event_connect_(yes|no)_(-?\d+)_(.+)$/);
  if (!match) return null;

  return {
    action: match[1],
    otherChatId: String(match[2]),
    eventId: String(match[3]),
  };
}

function normalizeProfileList(values) {
  if (Array.isArray(values)) return values.filter(Boolean);
  return String(values || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function hasCompletedProfile(profile) {
  if (!profile) return false;

  return (
    String(profile.fullName || "").trim().length > 0 &&
    String(profile.projectName || "").trim().length > 0 &&
    String(profile.role || "").trim().length > 0 &&
    normalizeProfileList(profile.categories).length > 0 &&
    normalizeProfileList(profile.lookingFor).length > 0
  );
}

async function requireCompletedProfileForEvents(bot, chatId, query = null) {
  const profile = await storage.getSingleUser(String(chatId));
  if (hasCompletedProfile(profile)) {
    return profile;
  }

  const text = "Please complete your profile first before using Events.";

  if (query?.id) {
    await bot.answerCallbackQuery(query.id, {
      text: "Complete your profile first.",
      show_alert: true,
    });
  } else {
    await bot.sendMessage(chatId, text);
  }

  return null;
}

function buildMatchSummaryLines(otherUser, viewer) {
  const otherProfile = {
    ...otherUser,
    categories: normalizeProfileList(otherUser.categories),
    lookingFor: normalizeProfileList(otherUser.lookingFor),
  };
  const viewerProfile = {
    ...viewer,
    categories: normalizeProfileList(viewer.categories),
    lookingFor: normalizeProfileList(viewer.lookingFor),
  };

  const theyBuild = matchedProjectCategories(otherProfile, viewerProfile) || [];
  const theyNeed = matchedLookingFor(otherProfile, viewerProfile) || [];
  const lines = [];

  if (theyBuild.length) {
    lines.push(`🎯 They build: ${escapeHtml(theyBuild.join(", "))}`);
  }

  if (theyNeed.length) {
    lines.push(`🔍 They need: ${escapeHtml(theyNeed.join(", "))}`);
  }

  return lines;
}

function hasMutualCategoryMatch(otherUser, viewer) {
  const otherProfile = {
    ...otherUser,
    categories: normalizeProfileList(otherUser.categories),
    lookingFor: normalizeProfileList(otherUser.lookingFor),
  };
  const viewerProfile = {
    ...viewer,
    categories: normalizeProfileList(viewer.categories),
    lookingFor: normalizeProfileList(viewer.lookingFor),
  };

  const theyBuild = matchedProjectCategories(otherProfile, viewerProfile) || [];
  const theyNeed = matchedLookingFor(otherProfile, viewerProfile) || [];

  return theyBuild.length > 0 && theyNeed.length > 0;
}

function buildSameEventPromptText(event, otherUser, viewer) {
  const xUrl = getLatestTwitterProfileLink(otherUser.xUrl);
  const xLine = xUrl
    ? `<a href="${escapeHtml(xUrl)}">X profile</a>`
    : "N/A";
  const matchLines = buildMatchSummaryLines(otherUser, viewer);
  const eventTitle = escapeHtml(event.title || "this event");

  return [
    "🤝 Your event match is attending too",
    "",
    `You and your event match are both attending <b>${eventTitle}</b>.`,
    "This could be a strong opportunity to connect during the event.",
    "",
    `🎫 Event: <b>${eventTitle}</b>`,
    `📅 ${escapeHtml(event.date || "TBA")}   🕒 ${escapeHtml(event.time || "TBA")}`,
    "",
    `🏷️ Project: <b>${escapeHtml(otherUser.projectName || "N/A")}</b>`,
    `🔗 X(Twitter): ${xLine}`,
    `👤 Contact Person: ${escapeHtml(otherUser.fullName || "N/A")}`,
    `🧠 Role: ${escapeHtml(otherUser.role || "N/A")}`,
    matchLines.length ? "" : null,
    matchLines.length ? "<b>Why this could be relevant</b>" : null,
    ...matchLines,
    "",
    "Would you like to connect with them for this event?",
    "Their Telegram details will be shared only after both of you accept.",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildRevealedProfileText(event, otherUser, viewer) {
  const xUrl = getLatestTwitterProfileLink(otherUser.xUrl);
  const xLine = xUrl
    ? `<a href="${escapeHtml(xUrl)}">X profile</a>`
    : "N/A";
  const eventTitle = escapeHtml(event.title || "this event");
  const telegramLine = otherUser.username
    ? `@${escapeHtml(String(otherUser.username).replace(/^@/, ""))}`
    : "Continue in bot";
  const categories = normalizeProfileList(otherUser.categories);
  const lookingFor = normalizeProfileList(otherUser.lookingFor);
  const matchLines = buildMatchSummaryLines(otherUser, viewer);

  const lines = [
    "🤝 Your event match is attending too",
    "",
    `You and your event match are both attending <b>${eventTitle}</b>.`,
    "We recommend connecting before or during the event.",
    "",
    `🎫 Event: <b>${eventTitle}</b>`,
    `📅 ${escapeHtml(event.date || "TBA")}   🕒 ${escapeHtml(event.time || "TBA")}`,
    "",
    `🏷️ Project: <b>${escapeHtml(otherUser.projectName || "N/A")}</b>`,
    `🔗 X(Twitter): ${xLine}`,
    `👤 Contact Person: ${escapeHtml(otherUser.fullName || "N/A")}`,
    `🧠 Role: ${escapeHtml(otherUser.role || "N/A")}`,
    `📞 Telegram: ${telegramLine}`,
  ];

  if (categories.length) {
    lines.push(`🏗️ Building: ${escapeHtml(categories.join(", "))}`);
  }

  if (lookingFor.length) {
    lines.push(`🎯 Looking for: ${escapeHtml(lookingFor.join(", "))}`);
  }

  return [
    ...lines,
    matchLines.length ? "" : null,
    matchLines.length ? "<b>Why this is a fit</b>" : null,
    ...matchLines,
    "",
    `You can now connect directly and meet at <b>${eventTitle}</b>, or continue chatting inside the bot.`,
  ].filter(Boolean).join("\n");
}

async function sendSameEventPrompt(bot, event, viewer, otherUser) {
  try {
    await bot.sendMessage(
      Number(viewer.chatId),
      buildSameEventPromptText(event, otherUser, viewer),
      {
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: {
          inline_keyboard: [[
            {
              text: "✅ Yes, connect",
              callback_data: buildEventConnectCallback("yes", otherUser.chatId, event.eventId),
            },
            {
              text: "❌ No",
              callback_data: buildEventConnectCallback("no", otherUser.chatId, event.eventId),
            },
          ]],
        },
      }
    );
  } catch (error) {
    if (reachability.isTelegramUnavailableError(error)) {
      await reachability.markTelegramUnavailable(viewer.chatId, {
        username: viewer.username,
        reason: reachability.getTelegramUnavailableReason(error),
        error,
      });
      return;
    }
    throw error;
  }
}

async function notifySameEventMatches(bot, event, newAttendee) {
  if (!event || !newAttendee || !newAttendee.chatId) return;

  if (!storage.isActiveUserStatus(newAttendee.status)) {
    return;
  }

  const attendeeChatIds = await storage.getEventAttendeeChatIds(event.eventId);
  const otherChatIds = attendeeChatIds.filter(
    (chatId) => String(chatId) !== String(newAttendee.chatId)
  );

  for (const otherChatId of otherChatIds) {
    const otherUser = await storage.getSingleUser(String(otherChatId));
    if (!otherUser) continue;
    if (!storage.isActiveUserStatus(otherUser.status)) continue;
    if (!hasMutualCategoryMatch(otherUser, newAttendee)) continue;
    if (reachability.isTelegramBlocked(newAttendee.chatId)) continue;
    if (reachability.isTelegramBlocked(otherUser.chatId)) continue;
    if (!(await storage.canAttemptUserContact(newAttendee)).ok) continue;
    if (!(await storage.canAttemptUserContact(otherUser)).ok) continue;
    if (await storage.hasContactBetween(newAttendee.chatId, otherUser.chatId)) continue;

    const { connection, created } = await storage.createEventConnection(
      event.eventId,
      event.title,
      newAttendee.chatId,
      otherUser.chatId
    );

    if (!created || !connection) continue;

    await ensureMutualEventContact(newAttendee.chatId, otherUser.chatId);
    await sendMutualEventReveal(bot, event, newAttendee.chatId, otherUser);
    await sendMutualEventReveal(bot, event, otherUser.chatId, newAttendee);
  }
}

async function ensureMutualEventContact(chatIdA, chatIdB) {
  if (await storage.hasContactBetween(chatIdA, chatIdB)) {
    return;
  }

  const ts = new Date().toISOString();
  await storage.saveContact({ from: chatIdA, to: chatIdB, timestamp: ts });
  await storage.saveContact({ from: chatIdB, to: chatIdA, timestamp: ts });
}

async function sendMutualEventReveal(bot, event, chatId, otherUser) {
  const viewer = await storage.getSingleUser(String(chatId));
  if (!viewer || !otherUser) return;
  if (!storage.isActiveUserStatus(viewer.status)) return;
  if (reachability.isTelegramBlocked(chatId)) return;
  if (!(await storage.canAttemptUserContact(viewer)).ok) return;

  try {
    await bot.sendMessage(
      Number(chatId),
      buildRevealedProfileText(event, otherUser, viewer),
      {
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: {
          inline_keyboard: [[
            { text: "💬 Message in Bot", callback_data: `chat_open_${otherUser.chatId}` },
          ]],
        },
      }
    );
  } catch (error) {
    if (reachability.isTelegramUnavailableError(error)) {
      await reachability.markTelegramUnavailable(chatId, {
        username: viewer.username,
        reason: reachability.getTelegramUnavailableReason(error),
        error,
      });
      return;
    }
    throw error;
  }
}


// Parse D/M/YYYY or DD/MM/YYYY; fallback to native for ISO/natural dates
function parseDateFlexible(s) {
  if (!s) return null;
  const raw = String(s).trim();
  if (!raw) return null;

  // D/M/YYYY or DD/MM/YYYY
  let m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const day = Number(m[1]);
    const month = Number(m[2]) - 1; // zero-based
    const year = Number(m[3]);
    const d = new Date(year, month, day);
    return isNaN(d) ? null : new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  // Fallback: ISO or natural strings like "2025-09-29" / "29 Sep 2025"
  const native = new Date(raw);
  if (!isNaN(native)) {
    return new Date(native.getFullYear(), native.getMonth(), native.getDate());
  }

  return null;
}

function isTodayOrLater(dateLike) {
  const d = parseDateFlexible(dateLike);
  if (!d) return false;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return d >= today;
}

function scopeEvents(all, scope = "upcoming") {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const today = new Date(y, m, now.getDate());

  if (scope === "month") {
    return all.filter(ev => {
      const d = parseDateFlexible(ev.date);
      return d && d.getFullYear() === y && d.getMonth() === m && d >= today;
    });
  }
  if (scope === "year") {
    return all.filter(ev => {
      const d = parseDateFlexible(ev.date);
      return d && d.getFullYear() === y && d >= today;
    });
  }
  // default: upcoming (today or later)
  return all.filter(ev => isTodayOrLater(ev.date));
}

async function sendEventPage({ bot, chatId, scope = "upcoming", offset = 0 }) {
  const events = await storage.getEvents(); // [{eventId,title,date,time,description,apply,location}, ...]

  // Sort chronologically by parsed date then by time text
  events.sort((a, b) => {
    const da = (parseDateFlexible(a.date) || new Date(0)) - (parseDateFlexible(b.date) || new Date(0));
    if (da !== 0) return da;
    return String(a.time || "").localeCompare(String(b.time || ""));
  });

  // Apply scope (upcoming / month / year)
  let scoped = scopeEvents(events, scope);

  // If nothing matches (e.g., bad dates or all in past), fall back to showing all so users aren't blocked
  if (scoped.length === 0) {
    scoped = events.slice();
    scope = "all"; // used in pager callback
  }

  const slice = scoped.slice(offset, offset + 10);
  const moreExists = offset + 10 < scoped.length;

  // Mark "Going"
  const userItin = await storage.getItineraries(chatId);
  const goingIds = new Set((userItin || []).map(i => i.eventId));
  const botUsername = (await bot.getMe()).username;

  if (slice.length === 0 && offset === 0) {
    return bot.sendMessage(chatId, "No events found for this selection.");
  }
  if (slice.length === 0 && offset > 0) {
    return bot.sendMessage(chatId, "No more events.");
  }

  for (const ev of slice) {
    const htmlText =
      `🎫 <b>${ev.title}</b>\n` +
      `⌛${ev.description}\n` +
      `📅 ${ev.date}   🕒 ${ev.time}\n` +
      `🎟️ <a href="${ev.apply}">Register here</a>\n` +
      `📍 <a href="${ev.location}">View on Map</a>`;

    const shareText = buildShareText(ev, botUsername);

    const inlineKeyboard = goingIds.has(ev.eventId)
      ? [
          [
            { text: "✅ Going", callback_data: "noop" },
            { text: "🔗 Share", switch_inline_query: shareText },
          ],
        ]
      : [
          [
            { text: "📥 Going", callback_data: `going_${ev.eventId}` },
            { text: "🔗 Share", switch_inline_query: shareText },
          ],
        ];

    await bot.sendMessage(chatId, htmlText, {
      parse_mode: "HTML",
      disable_web_page_preview: false,
      reply_markup: { inline_keyboard: inlineKeyboard },
    });
  }

  // Pager + scope controls
  const controlsKeyboard = [];
  if (moreExists) {
    controlsKeyboard.push([
      { text: "▶️ Show more", callback_data: `events_more_${scope}_${offset + 10}` },
    ]);
  }

  controlsKeyboard.push([
    { text: "📅 This month", callback_data: "events_scope_month" },
    { text: "📅 This year",  callback_data: "events_scope_year"  },
  ]);

  if (scope !== "upcoming") {
    controlsKeyboard.push([{ text: "↩️ Back to upcoming", callback_data: "events_scope_upcoming" }]);
  }

  await bot.sendMessage(chatId, "\u200B", {
    reply_markup: { inline_keyboard: controlsKeyboard },
  });
}

/** ---------- commands & callbacks ---------- **/

/**
 * Entry: show first 10 upcoming events with pager.
 */
async function handleEventsCommand(msg, bot) {
  const chatId = msg.chat.id;
  const profile = await requireCompletedProfileForEvents(bot, chatId);
  if (!profile) return;
  return sendEventPage({ bot, chatId, scope: "upcoming", offset: 0 });
}

/**
 * Handle callbacks for:
 *  - going_<id>
 *  - noop
 *  - events_more_<scope>_<offset>
 *  - events_scope_month | events_scope_year | events_scope_upcoming
 */
async function handleEventCallback(query, bot) {
  const data = query.data;
  const chatId = query.from.id;

  const eventConnectAction = parseEventConnectCallback(data);
  if (eventConnectAction) {
    try {
      const actorId = String(chatId);
      const otherUser = await storage.getSingleUser(eventConnectAction.otherChatId);
      const actor = await storage.getSingleUser(actorId);

      if (!actor || !otherUser) {
        await bot.answerCallbackQuery(query.id, {
          text: "One of the attendee profiles is no longer available.",
          show_alert: true,
        });
        return;
      }

      const connection = await storage.getEventConnection(
        eventConnectAction.eventId,
        actorId,
        eventConnectAction.otherChatId
      );

      if (!connection) {
        await bot.answerCallbackQuery(query.id, {
          text: "This event connection is no longer active.",
          show_alert: true,
        });
        return;
      }

      const updatedConnection = await storage.updateEventConnectionStatus(
        eventConnectAction.eventId,
        actorId,
        eventConnectAction.otherChatId,
        eventConnectAction.action === "yes" ? "accepted" : "declined"
      );

      await bot.editMessageReplyMarkup(
        {
          inline_keyboard: [[{
            text: eventConnectAction.action === "yes" ? "✅ Interested" : "❌ Passed",
            callback_data: "noop",
          }]],
        },
        {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
        }
      );

      const actorStatus =
        updatedConnection.userAChatId === actorId
          ? updatedConnection.userAStatus
          : updatedConnection.userBStatus;
      const otherStatus =
        updatedConnection.userAChatId === actorId
          ? updatedConnection.userBStatus
          : updatedConnection.userAStatus;

      if (eventConnectAction.action === "no") {
        await bot.answerCallbackQuery(query.id, {
          text: "You passed on this event connection.",
        });
        return;
      }

      if (actorStatus === "accepted" && otherStatus === "accepted") {
        const events = await storage.getEvents();
        const event =
          events.find((item) => String(item.eventId) === eventConnectAction.eventId) || {
            eventId: eventConnectAction.eventId,
            title: updatedConnection.eventTitle || "Upcoming event",
            date: "",
            time: "",
          };

        await ensureMutualEventContact(actorId, otherUser.chatId);
        await sendMutualEventReveal(bot, event, actorId, otherUser);
        await sendMutualEventReveal(bot, event, otherUser.chatId, actor);

        await bot.answerCallbackQuery(query.id, {
          text: "Mutual yes. Profiles shared.",
        });
        return;
      }

      await bot.answerCallbackQuery(query.id, {
        text:
          otherStatus === "declined"
            ? "You accepted, but the other attendee has passed."
            : "Interest saved. Waiting for the other attendee.",
      });
    } catch (err) {
      console.error("Error handling same-event connection:", err);
      await bot.answerCallbackQuery(query.id, {
        text: "Could not update this event connection.",
        show_alert: true,
      });
    }
    return;
  }

  // pagination "more"
  if (data.startsWith("events_more_")) {
    const profile = await requireCompletedProfileForEvents(bot, chatId, query);
    if (!profile) return;
    const [, , scope, offStr] = data.split("_"); // scope can be "upcoming" | "month" | "year" | "all"
    const offset = Number(offStr) || 0;
    await bot.answerCallbackQuery(query.id);
    return sendEventPage({ bot, chatId, scope, offset });
  }

  // scope switching
  if (data === "events_scope_month" || data === "events_scope_year" || data === "events_scope_upcoming") {
    const profile = await requireCompletedProfileForEvents(bot, chatId, query);
    if (!profile) return;
    const scope = data.replace("events_scope_", ""); // "month" | "year" | "upcoming"
    await bot.answerCallbackQuery(query.id);
    return sendEventPage({ bot, chatId, scope, offset: 0 });
  }

  // 1) Going
  if (data.startsWith("going_")) {
    const attendee = await requireCompletedProfileForEvents(bot, chatId, query);
    if (!attendee) return;
    const eventId = data.slice("going_".length);
    try {
      const saveResult = await storage.saveItinerary(eventId, chatId);

      await bot.answerCallbackQuery(query.id, {
        text: saveResult.created ? "✅ Added to your itinerary!" : "✅ Already in your itinerary.",
      });

      const events = await storage.getEvents();
      const ev = events.find((e) => e.eventId === eventId);
      if (!ev) {
        await bot.sendMessage(
          Number(chatId),
          "⚠️ This event is no longer available."
        );
        return;
      }

      const botUsername = (await bot.getMe()).username;
      const shareText = buildShareText(ev, botUsername);

      // Replace buttons: ✅ Going + 🔗 Share
      await bot.editMessageReplyMarkup(
        {
          inline_keyboard: [
            [
              { text: "✅ Going", callback_data: "noop" },
              { text: "🔗 Share", switch_inline_query: shareText },
            ],
          ],
        },
        {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
        }
      );

      if (saveResult.created && ev) {
        await notifySameEventMatches(bot, ev, attendee);
      }
    } catch (err) {
      console.error("Error saving itinerary:", err);
      await bot.answerCallbackQuery(query.id, {
        text: "❌ Could not add.",
        show_alert: true,
      });
    }
    return;
  }

  // 2) No-op
  if (data === "noop") {
    return bot.answerCallbackQuery(query.id);
  }
}

/**
 * Show the user's personal itinerary (/itinerary).
 */
async function handleItineraryCommand(msg, bot) {
  const chatId = msg.chat.id;
  const itins = await storage.getItineraries(chatId);
  const intinsReverse = (itins || []).slice().reverse();
  if (intinsReverse.length === 0) {
    return bot.sendMessage(
      chatId,
      "You have no upcoming events in your itinerary."
    );
  }

  const events = await storage.getEvents();
  const htmlLines = intinsReverse.map((i, idx) => {
    const ev = events.find((e) => e.eventId === i.eventId);
    if (!ev) return `${idx + 1}: Event ID ${i.eventId}`;
    return (
      `${idx + 1}: <b>${ev.title}</b>\n` +
      `📅 ${ev.date} at ${ev.time}\n` +
      `🎟️ <a href="${ev.apply}">Register here</a>\n` +
      `📍 <a href="${ev.location}">View on Map</a>`
    );
  });

  const shareLines = intinsReverse.map((i, idx) => {
    const ev = events.find((e) => e.eventId === i.eventId);
    if (!ev) return `${idx + 1}: Event ID ${i.eventId}`;
    return (
      `\n${idx + 1}: ${ev.title}\n` +
      `Date: ${ev.date} at ${ev.time}\n` +
      `Location: ${ev.location}\n` +
      `Apply: ${ev.apply}`
    );
  });

  const botUsername = (await bot.getMe()).username;
  shareLines.push(
    ``,
    `👉 See details & RSVP: https://t.me/${botUsername}`
  );
  const shareText = shareLines.join("\n");

  const inlineKeyboard = [
    [
      { text: "🔗 Share Itinerary", switch_inline_query: shareText },
    ],
  ];

  await bot.sendMessage(
    chatId,
    `<b>Your Itinerary 📋</b>\n\n` + htmlLines.join("\n\n"),
    {
      parse_mode: "HTML",
      disable_web_page_preview: false,
      reply_markup: { inline_keyboard: inlineKeyboard },
    }
  );
}

module.exports = {
  handleEventsCommand,
  handleEventCallback,
  handleItineraryCommand,
};
