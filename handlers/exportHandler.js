'use strict';

const fs = require('fs');

const { HAS_ADMIN_CONFIG, isAdmin } = require('../config');
const exportService = require('../services/exportService');
const storage = require('../services/storage');

function normalizeFormat(value) {
  const lookup = String(value || '')
    .trim()
    .toLowerCase();

  if (['csv'].includes(lookup)) return 'csv';
  if (['google', 'sheet', 'sheets', 'excel', 'googleexcel'].includes(lookup)) {
    return 'google';
  }
  return null;
}

function buildUsageText() {
  return (
    'Usage:\n' +
    '/export csv\n' +
    '/export google\n' +
    '/export excel\n' +
    '/forceexport\n' +
    '/export csv users\n' +
    '/export google contacts\n' +
    '/forceexport contacts\n\n' +
    `Available datasets: ${storage.listDatasets().join(', ')}`
  );
}

async function runGoogleExport(bot, chatId, dataset, source, successLabel) {
  const result = await exportService.exportGoogleSnapshot(dataset, {
    source,
    includeDerived: true,
  });
  const lines = result.exported.map(
    (item) => `• ${item.dataset} → ${item.sheetName} (${item.rowCount} rows)`
  );

  await bot.sendMessage(
    chatId,
    [
      successLabel,
      ...lines,
      result.spreadsheetUrl ? `Open: ${result.spreadsheetUrl}` : null,
    ]
      .filter(Boolean)
      .join('\n')
  );
}

async function handleExportCommand(msg, bot, rawArgs) {
  const chatId = msg.chat.id;
  const username = msg.from && msg.from.username;

  if (!HAS_ADMIN_CONFIG) {
    await bot.sendMessage(
      chatId,
      '⚠️ Set ADMIN_CHAT_IDS or ADMIN_USERNAMES in .env to enable /export.'
    );
    return;
  }

  if (!isAdmin(chatId, username)) {
    await bot.sendMessage(chatId, '⚠️ /export is restricted to the admin chat.');
    return;
  }

  const tokens = String(rawArgs || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  const format = normalizeFormat(tokens[0] || 'csv');
  const dataset = tokens[1] || 'all';

  if (!format) {
    await bot.sendMessage(chatId, buildUsageText());
    return;
  }

  try {
    if (format === 'csv') {
      const files = await exportService.exportCsv(dataset);

      for (const file of files) {
        try {
          await bot.sendDocument(chatId, fs.createReadStream(file.filePath), {
            caption: `${file.dataset} (${file.rowCount} rows)`,
          });
        } finally {
          fs.unlink(file.filePath, () => {});
        }
      }

      await bot.sendMessage(
        chatId,
        `✅ CSV export complete from ${storage.getStorageBackend()} storage.`
      );
      return;
    }

    await runGoogleExport(
      bot,
      chatId,
      dataset,
      storage.getStorageBackend() === 'sqlite' ? 'sqlite' : 'storage',
      '✅ Google Sheets export complete.'
    );
  } catch (err) {
    await bot.sendMessage(chatId, `⚠️ Export failed: ${err.message}`);
  }
}

async function handleForceExportCommand(msg, bot, rawArgs) {
  const chatId = msg.chat.id;
  const username = msg.from && msg.from.username;

  if (!HAS_ADMIN_CONFIG) {
    await bot.sendMessage(
      chatId,
      '⚠️ Set ADMIN_CHAT_IDS or ADMIN_USERNAMES in .env to enable /forceexport.'
    );
    return;
  }

  if (!isAdmin(chatId, username)) {
    await bot.sendMessage(chatId, '⚠️ /forceexport is restricted to the admin chat.');
    return;
  }

  const dataset = String(rawArgs || '').trim() || 'all';

  try {
    await runGoogleExport(
      bot,
      chatId,
      dataset,
      'sqlite',
      '✅ Forced SQLite → Google Sheets export complete.'
    );
  } catch (err) {
    await bot.sendMessage(chatId, `⚠️ Force export failed: ${err.message}`);
  }
}

module.exports = {
  handleExportCommand,
  handleForceExportCommand,
};
