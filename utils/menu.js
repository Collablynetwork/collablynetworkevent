// utils/menu.js
function sendMainMenu(bot, chatId, status = "active") {
  const isMuted = String(status || "").toLowerCase() === "muted";
  const toggleLabel = isMuted ? "🔔 Unmute Notification" : "🔕 Mute Notification";

  return bot.sendMessage(chatId, "🛡️ Protect Every Connection — 📅 Events & Contacts in One Place:", {
    reply_markup: {
      keyboard: [
        ["📥 Leads", "📞 Contacts"],
        ["📅 Events", "📋 Itinerary"],
        ["✏️ Edit Profile", "⛶ Your QR Profile"],
        [toggleLabel]
      ],
      resize_keyboard: true,
      one_time_keyboard: false
    }
  });
}

module.exports = { sendMainMenu };
