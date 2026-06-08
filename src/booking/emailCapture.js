// src/booking/emailCapture.js
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN_FIXES = [
  [/g\s*mail/g, "gmail"],
  [/gmailcom$/i, "gmail.com"],
  [/yahoocom$/i, "yahoo.com"],
  [/outlookcom$/i, "outlook.com"],
  [/hotmailcom$/i, "hotmail.com"]
];

/**
 * Turn a spoken email transcript into a normalized address, or "" if not plausible.
 * @param {string} spoken
 * @returns {string}
 */
export function normalizeSpokenEmail(spoken) {
  if (!spoken) return "";
  let value = String(spoken).toLowerCase();
  value = value.replace(/\s+at\s+/g, "@").replace(/\s+dot\s+/g, ".");
  value = value.replace(/\s+/g, "");
  for (const [pattern, replacement] of DOMAIN_FIXES) value = value.replace(pattern, replacement);
  if (!value.includes("@") && /gmailcom|yahoocom/.test(value)) {
    value = value.replace(/(gmail|yahoo)/, "@$1");
  }
  return EMAIL_RE.test(value) ? value : "";
}

/**
 * Produce a spoken read-back string for confirmation.
 * @param {string} email
 * @returns {string}
 */
export function buildReadback(email) {
  if (!email) return "";
  const [local, domain] = email.split("@");
  const spelledLocal = local.split("").join(" ");
  return `Let me confirm — ${spelledLocal}, at ${domain}. Is that right?`;
}
