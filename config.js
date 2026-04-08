const fs = require("fs");
const path = require("path");

require("dotenv").config();

const {
  TELEGRAM_TOKEN,
  GOOGLE_SHEET_ID,
  GOOGLE_CREDENTIALS_JSON,
  GOOGLE_CREDENTIALS_FILE,
  STORAGE_BACKEND,
  SQLITE_PATH,
  ADMIN_CHAT_ID,
  ADMIN_CHAT_IDS,
  ADMIN_USERNAMES,
  FOUNDER_NAME,
  FOUNDER_TELEGRAM_USERNAME,
  FOUNDER_X_HANDLE,
  COLLAB_NETWORK_TELEGRAM_USERNAME,
  COLLAB_NETWORK_X_HANDLE,
} = process.env;

if (!TELEGRAM_TOKEN) {
  throw new Error("Missing TELEGRAM_TOKEN in .env");
}

let GOOGLE_CREDENTIALS = null;
let GOOGLE_CONFIG_ERROR = null;
let GOOGLE_CREDENTIALS_SOURCE = null;

function logGoogleCredentialsSummary(credentials) {
  console.log("🔐 Service account:", {
    source: GOOGLE_CREDENTIALS_SOURCE || 'unknown',
    client_email: !!credentials.client_email,
    hasPrivateKey: !!credentials.private_key,
    hasClientID: !!credentials.client_id,
    hasAuthURI: !!credentials.auth_uri,
    hasTokenURI: !!credentials.token_uri,
  });
}

function resolveProjectPath(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (path.isAbsolute(raw)) return raw;
  return path.join(__dirname, raw);
}

function tryLoadGoogleCredentialsFromFile(filePath) {
  const resolvedPath = resolveProjectPath(filePath);
  const raw = fs.readFileSync(resolvedPath, "utf8");
  const credentials = JSON.parse(raw);
  GOOGLE_CREDENTIALS_SOURCE = resolvedPath;
  return credentials;
}

function findDefaultGoogleCredentialsFile() {
  const candidates = [
    GOOGLE_CREDENTIALS_FILE,
    process.env.GOOGLE_APPLICATION_CREDENTIALS,
    path.join(__dirname, "service-account.json"),
    path.join(__dirname, "google-service-account.json"),
  ]
    .filter(Boolean)
    .map((value) => resolveProjectPath(value));

  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

const googleCredentialsFile = findDefaultGoogleCredentialsFile();

if (GOOGLE_CREDENTIALS_JSON) {
  try {
    GOOGLE_CREDENTIALS = JSON.parse(GOOGLE_CREDENTIALS_JSON);
    GOOGLE_CREDENTIALS_SOURCE = "GOOGLE_CREDENTIALS_JSON";
    logGoogleCredentialsSummary(GOOGLE_CREDENTIALS);
  } catch (e) {
    GOOGLE_CONFIG_ERROR = `Invalid GOOGLE_CREDENTIALS_JSON: ${e.message}`;
    console.warn(`⚠️ ${GOOGLE_CONFIG_ERROR}. Falling back to SQLite if needed.`);
  }
} else if (googleCredentialsFile) {
  try {
    GOOGLE_CREDENTIALS = tryLoadGoogleCredentialsFromFile(googleCredentialsFile);
    logGoogleCredentialsSummary(GOOGLE_CREDENTIALS);
  } catch (e) {
    GOOGLE_CONFIG_ERROR = `Invalid GOOGLE_CREDENTIALS_FILE (${googleCredentialsFile}): ${e.message}`;
    console.warn(`⚠️ ${GOOGLE_CONFIG_ERROR}. Falling back to SQLite if needed.`);
  }
}

const normalizedStorageBackend = String(STORAGE_BACKEND || "auto")
  .trim()
  .toLowerCase();

const parsedAdminChatIds = Array.from(
  new Set(
    [ADMIN_CHAT_IDS, ADMIN_CHAT_ID]
      .filter(Boolean)
      .flatMap((value) => String(value).split(','))
      .map((value) => String(value).trim())
      .filter(Boolean)
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value))
  )
);

const parsedAdminUsernames = Array.from(
  new Set(
    String(ADMIN_USERNAMES || '')
      .split(',')
      .map((value) => String(value).trim().replace(/^@/, '').toLowerCase())
      .filter(Boolean)
  )
);

function normalizeUsername(value) {
  return String(value || '')
    .trim()
    .replace(/^@/, '')
    .toLowerCase();
}

function usernameDisplay(value, fallback = '') {
  return String(value || fallback || '')
    .trim()
    .replace(/^@/, '');
}

function normalizeXHandle(value) {
  return String(value || '')
    .trim()
    .replace(/^https?:\/\/(www\.)?x\.com\//i, '')
    .replace(/^https?:\/\/(www\.)?twitter\.com\//i, '')
    .replace(/^@/, '')
    .replace(/\/+$/, '');
}

function isAdmin(chatId, username) {
  const id = Number(chatId);
  const normalizedUsername = normalizeUsername(username);

  return (
    (Number.isFinite(id) && parsedAdminChatIds.includes(id)) ||
    (normalizedUsername && parsedAdminUsernames.includes(normalizedUsername))
  );
}

const founderTelegramUsername =
  normalizeUsername(FOUNDER_TELEGRAM_USERNAME) || parsedAdminUsernames[0] || '';

const founderTelegramUsernameDisplay = usernameDisplay(
  FOUNDER_TELEGRAM_USERNAME,
  founderTelegramUsername
);

const collabNetworkTelegramUsername =
  normalizeUsername(COLLAB_NETWORK_TELEGRAM_USERNAME) ||
  parsedAdminUsernames.find((username) => username === 'collablynetwork_admin') ||
  parsedAdminUsernames[1] ||
  '';

const collabNetworkTelegramUsernameDisplay = usernameDisplay(
  COLLAB_NETWORK_TELEGRAM_USERNAME,
  collabNetworkTelegramUsername
);

const founderXHandle = normalizeXHandle(FOUNDER_X_HANDLE);
const collabNetworkXHandle = normalizeXHandle(COLLAB_NETWORK_X_HANDLE);

module.exports = {
  TELEGRAM_TOKEN,
  SHEET_ID: GOOGLE_SHEET_ID || "",
  GOOGLE_CREDENTIALS,
  GOOGLE_CONFIG_ERROR,
  GOOGLE_CREDENTIALS_SOURCE,
  STORAGE_BACKEND: normalizedStorageBackend,
  SQLITE_PATH: SQLITE_PATH
    ? path.resolve(SQLITE_PATH)
    : path.join(__dirname, "data", "eventpartner.sqlite"),
  ADMIN_CHAT_ID: parsedAdminChatIds[0] || null,
  ADMIN_CHAT_IDS: parsedAdminChatIds,
  ADMIN_USERNAMES: parsedAdminUsernames,
  HAS_ADMIN_CONFIG: Boolean(
    parsedAdminChatIds.length || parsedAdminUsernames.length
  ),
  FOUNDER_NAME: String(FOUNDER_NAME || 'Sumit').trim() || 'Sumit',
  FOUNDER_TELEGRAM_USERNAME: founderTelegramUsername,
  FOUNDER_TELEGRAM_USERNAME_DISPLAY: founderTelegramUsernameDisplay,
  FOUNDER_X_HANDLE: founderXHandle,
  COLLAB_NETWORK_TELEGRAM_USERNAME: collabNetworkTelegramUsername,
  COLLAB_NETWORK_TELEGRAM_USERNAME_DISPLAY: collabNetworkTelegramUsernameDisplay,
  COLLAB_NETWORK_X_HANDLE: collabNetworkXHandle,
  isGoogleConfigured: Boolean(
    GOOGLE_SHEET_ID &&
      GOOGLE_CREDENTIALS &&
      GOOGLE_CREDENTIALS.client_email &&
      GOOGLE_CREDENTIALS.private_key
  ),
  isAdmin,
};
