import crypto from "node:crypto";

/**
 * Validates a Twilio webhook request signature using HMAC-SHA1.
 *
 * Twilio signs the URL (scheme+host+path+query) concatenated with all POST
 * params sorted lexicographically (key+value, no separators), then HMAC-SHA1s
 * the result with the auth token and base64-encodes it.
 *
 * @param {object} opts
 * @param {string} opts.signatureHeader - Value of the X-Twilio-Signature header.
 * @param {string} opts.url             - The full URL Twilio called (reconstructed from public base + path + query).
 * @param {Record<string, string>} opts.params - Parsed POST form parameters.
 * @param {string} opts.authToken       - Twilio auth token used as the HMAC key.
 * @returns {boolean} true if the signature is valid.
 */
export function validateTwilioSignature({ signatureHeader, url, params, authToken }) {
  if (!signatureHeader || typeof signatureHeader !== "string") return false;
  if (!authToken || typeof authToken !== "string") return false;

  // Build the string to sign: URL + sorted key+value pairs (no separators).
  const sortedKeys = Object.keys(params || {}).sort();
  const stringToSign = sortedKeys.reduce((acc, key) => acc + key + (params[key] ?? ""), url);

  const expectedBuffer = Buffer.from(
    crypto.createHmac("sha1", authToken).update(stringToSign, "utf8").digest("base64"),
    "utf8"
  );

  let incomingBuffer;
  try {
    incomingBuffer = Buffer.from(signatureHeader, "utf8");
  } catch {
    return false;
  }

  // timingSafeEqual requires equal lengths; return false without revealing which
  // length is wrong.
  if (expectedBuffer.length !== incomingBuffer.length) return false;

  return crypto.timingSafeEqual(expectedBuffer, incomingBuffer);
}
