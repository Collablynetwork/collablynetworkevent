// qr-poster.js
const QRCode = require("qrcode");
const { createCanvas, loadImage } = require("canvas");
const fs = require("fs");
const path = require("path");

const THEMES = {
  classic: { background: "#ffffff", foreground: "#000000", textColor: "#000000" },
  telegram: { background: "#e8f0fd", foreground: "#0088cc", textColor: "#005a87" },
  dark: { background: "#1e1e1e", foreground: "#ffffff", textColor: "#ffffff" },
  modern: { background: "#f4f4f0", foreground: "#012840", textColor: "#333" },
};

/**
 * Generate a full-screen (default 1080x1920) poster-style QR where
 * the QR and the username sit together as one vertically centered block.
 *
 * @param {string} url            - Data to encode in the QR
 * @param {string} username       - Telegram username (shown just below the QR)
 * @param {string} filename       - Output filename (e.g., "qr-profile.png")
 * @param {string} themeName      - One of Object.keys(THEMES)
 * @param {object} opts           - Layout options
 *   opts.width          number   - Canvas width (default 1080)
 *   opts.height         number   - Canvas height (default 1920)
 *   opts.padding        number   - Outer padding (default ~8% of width)
 *   opts.fontScale      number   - Username font size as % of width (default 0.05)
 *   opts.gapMultiplier  number   - Gap under QR as multiple of font size (default 0.4)
 *   opts.logoSize       number   - Logo size as % of width (default 0.08)
 *   opts.logoPath       string   - Custom logo path (fallback to telegram logo)
 *   opts.autoDeleteSeconds number - Auto-delete output after N seconds (default 5; set 0/false to disable)
 */
async function generateStylizedQR(
  url,
  username,
  filename = "qr-profile.png",
  themeName = "classic",
  opts = {}
) {
  const theme = THEMES[themeName] || THEMES.dark;

  // Canvas sizing (9:16 by default)
  const width = Number(opts.width) || 1080;
  const height = Number(opts.height) || 1920;

  // Layout parameters
  const padding = Number(opts.padding) || Math.round(width * 0.08);
  const fontScale = opts.fontScale != null ? Number(opts.fontScale) : 0.05; // 5% of width
  const fontSize = Math.max(14, Math.round(width * fontScale)); // clamp minimal readability
  const gapMultiplier = opts.gapMultiplier != null ? Number(opts.gapMultiplier) : 0.4;
  const gapBelowQR = Math.round(fontSize * gapMultiplier);
  const logoSize = Number.isFinite(opts.logoSize)
    ? Math.round(width * Number(opts.logoSize))
    : Math.round(width * 0.08);

  // Canvas & context
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  // Full-bleed background
  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, width, height);

  // Compute QR size so that [QR + gap + text] fits within vertical space (minus padding)
  const maxQRWidth = width - padding * 2;
  const maxBlockHeight = height - padding * 2;
  // qrSize + gap + fontSize <= maxBlockHeight
  let qrSize = Math.min(maxQRWidth, maxBlockHeight - (gapBelowQR + fontSize));
  qrSize = Math.max(200, Math.floor(qrSize)); // ensure it never gets too tiny

  // Prepare QR on an off-screen canvas for crisp scaling
  const qrCanvas = createCanvas(qrSize, qrSize);
  await QRCode.toCanvas(qrCanvas, url, {
    margin: 2,
    width: qrSize,
    color: { dark: theme.foreground, light: theme.background },
  });

  // Center the combined block (QR + gap + username) vertically
  const totalBlockHeight = qrSize + gapBelowQR + fontSize;
  const blockTopY = Math.round((height - totalBlockHeight) / 2);

  // Position QR (centered horizontally)
  const qrX = Math.round((width - qrSize) / 2);
  const qrY = blockTopY;
  ctx.drawImage(qrCanvas, qrX, qrY);

  // Optional centered logo overlay inside the QR
  try {
    const defaultLogoPath = path.join(__dirname, "..", "assets", "telegram-logo.png");
    const logoPath = opts.logoPath || defaultLogoPath;
    const logo = await loadImage(logoPath);
    const lx = Math.round(width / 2 - logoSize / 2);
    const ly = Math.round(qrY + qrSize / 2 - logoSize / 2);
    ctx.drawImage(logo, lx, ly, logoSize, logoSize);
  } catch (e) {
    // Non-fatal if logo missing
    console.warn("Logo load failed, skipping overlay:", e.message);
  }

  // Username just below the QR, centered
  if (username) {
    ctx.font = `bold ${fontSize}px Sans-serif`;
    ctx.fillStyle = theme.textColor;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const usernameY = qrY + qrSize + gapBelowQR;
    ctx.fillText(`@${username}`, width / 2, usernameY);
  }

  // Ensure output folder exists
  const outputDir = path.join(__dirname, "..", "output");
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  // Write file
  const outPath = path.join(outputDir, filename);
  fs.writeFileSync(outPath, canvas.toBuffer("image/png"));

  // Optional auto-clean
  const autoDeleteSeconds =
    opts.autoDeleteSeconds === 0 || opts.autoDeleteSeconds === false
      ? 0
      : Number.isFinite(opts.autoDeleteSeconds)
      ? Number(opts.autoDeleteSeconds)
      : 5;

  if (autoDeleteSeconds > 0) {
    setTimeout(() => {
      if (fs.existsSync(outPath)) {
        fs.unlink(outPath, (err) => {
          if (err) console.error(`❌ Error deleting ${filename}:`, err);
          else console.log(`🗑️ Deleted QR: ${filename}`);
        });
      }
    }, autoDeleteSeconds * 1000);
  }

  return outPath;
}

module.exports = { generateStylizedQR, THEMES };

/* -------------------------
Example usage:

const { generateStylizedQR } = require('./qr-poster');

(async () => {
  await generateStylizedQR(
    "https://t.me/your_username",
    "your_username",
    "qr-poster.png",
    "telegram",
    {
      width: 1080,
      height: 1920,
      padding: 96,
      fontScale: 0.05,     // username font ≈ 5% of width
      gapMultiplier: 0.45, // space between QR and username ≈ 45% of font size
      logoSize: 0.08,      // logo ≈ 8% of width
      autoDeleteSeconds: 0 // keep file; set >0 to auto-delete
    }
  );
})();
------------------------- */
