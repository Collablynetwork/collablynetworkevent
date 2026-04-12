const storage = require("./storage");
const {
  matchedProjectCategories,
  matchedLookingFor,
} = require("../utils/categoryFilter");
const DEFAULT_ADMIN_APPROVAL_KEYWORDS = ["CEX"];

const ADMIN_TELEGRAM = ["collablynetwork_admin"];
let adminApprovalKeywordsCache = DEFAULT_ADMIN_APPROVAL_KEYWORDS.slice();
let adminApprovalKeywordsLoaded = false;

function normalizeList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }

  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeKeyword(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

async function hydrateAdminApprovalKeywords(force = false) {
  if (adminApprovalKeywordsLoaded && !force) {
    return adminApprovalKeywordsCache.slice();
  }

  const rows = await storage.getApprovalKeywords();
  adminApprovalKeywordsCache = rows
    .map((row) => String(row.keyword || '').trim())
    .filter(Boolean);
  adminApprovalKeywordsLoaded = true;

  return adminApprovalKeywordsCache.slice();
}

function getAdminApprovalKeywordsSync() {
  return adminApprovalKeywordsCache.slice();
}

async function getAdminApprovalKeywords() {
  return hydrateAdminApprovalKeywords(false);
}

function hasAdminApprovalKeyword(values = [], keywords = adminApprovalKeywordsCache) {
  const normalizedValues = normalizeList(values).map(normalizeKeyword);
  const normalizedKeywords = (Array.isArray(keywords) ? keywords : [])
    .map(normalizeKeyword)
    .filter(Boolean);

  return normalizedValues.some((value) => normalizedKeywords.includes(value));
}

function normalizeProfile(profile = {}) {
  return {
    ...profile,
    categories: normalizeList(profile.categories),
    lookingFor: normalizeList(profile.lookingFor),
  };
}

function uniquePreservingOrder(values = []) {
  const seen = new Set();
  const output = [];

  for (const value of values) {
    const raw = String(value || '').trim();
    const normalized = normalizeKeyword(raw);
    if (!raw || !normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(raw);
  }

  return output;
}

function getMatchApprovalState(profileA, profileB, keywords = adminApprovalKeywordsCache) {
  const left = normalizeProfile(profileA);
  const right = normalizeProfile(profileB);

  const leftBuildsForRight = matchedProjectCategories(left, right);
  const leftNeedsFromRight = matchedLookingFor(left, right);
  const rightBuildsForLeft = matchedProjectCategories(right, left);
  const rightNeedsFromLeft = matchedLookingFor(right, left);

  const matchedKeywords = uniquePreservingOrder([
    ...leftBuildsForRight,
    ...leftNeedsFromRight,
    ...rightBuildsForLeft,
    ...rightNeedsFromLeft,
  ]);

  const normalizedKeywordSet = new Set(
    (Array.isArray(keywords) ? keywords : [])
      .map(normalizeKeyword)
      .filter(Boolean)
  );

  const approvalMatchedKeywords = matchedKeywords.filter((keyword) =>
    normalizedKeywordSet.has(normalizeKeyword(keyword))
  );

  return {
    matchedKeywords,
    approvalMatchedKeywords,
    requiresAdminApproval:
      matchedKeywords.length > 0 &&
      approvalMatchedKeywords.length === matchedKeywords.length,
    sourceToTarget: {
      builds: leftBuildsForRight,
      needs: leftNeedsFromRight,
    },
    targetToSource: {
      builds: rightBuildsForLeft,
      needs: rightNeedsFromLeft,
    },
  };
}

async function findMatches(newProfile) {
  if (await storage.isBlockedUser(newProfile.chatId, newProfile.username)) {
    return [];
  }
  if (!storage.isActiveUserStatus(newProfile.status)) {
    return [];
  }

  const users = await storage.getUsers();
  const myCategories = normalizeList(newProfile.categories);
  const myLookingFor = normalizeList(newProfile.lookingFor);

  const matches = [];

  for (const u of users) {
    // 1) Skip yourself
    if (u.chatId === newProfile.chatId) continue;
    const candidateAvailability = await storage.canAttemptUserContact(u);
    if (!candidateAvailability.ok) continue;

    const theirCategories = normalizeList(u.categories);
    const theirLookingFor = normalizeList(u.lookingFor);

    // 2) Does existing user “want” one of my project categories?
    const theyWant = theirLookingFor.some((cat) =>
      myCategories.includes(cat)
    );

    // 3) Do I “want” one of their project categories?
    const iWant = myLookingFor.some((cat) =>
      theirCategories.includes(cat)
    );

    if (!(theyWant && iWant)) continue;

    // Reserved for future premium lead workflows.
    const hasApprovedCategory = hasAdminApprovalKeyword(u.categories);

    // if (hasApprovedCategory) {
    //   await storage.saveLead(u); 
    // }

    matches.push(u);
  }

  return matches;
}

module.exports = {
  findMatches,
  DEFAULT_ADMIN_APPROVAL_KEYWORDS,
  ADMIN_TELEGRAM,
  hydrateAdminApprovalKeywords,
  getAdminApprovalKeywords,
  getAdminApprovalKeywordsSync,
  hasAdminApprovalKeyword,
  getMatchApprovalState,
};
