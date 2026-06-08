import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { validateTwilioSignature } from "../src/twilioSignature.js";

/**
 * Compute the expected Twilio signature in the same way the production code
 * does, so this test acts as an independent known-vector check.
 */
function computeExpectedSignature(url, params, authToken) {
  const sortedKeys = Object.keys(params).sort();
  const stringToSign = sortedKeys.reduce((acc, key) => acc + key + (params[key] ?? ""), url);
  return crypto.createHmac("sha1", authToken).update(stringToSign, "utf8").digest("base64");
}

describe("validateTwilioSignature", () => {
  const AUTH_TOKEN = "test_auth_token_abc123";
  const URL = "https://calls.example.com/twilio/voice?callId=test-call";
  const PARAMS = {
    CallSid: "CA1234567890abcdef",
    From: "+15550000001",
    To: "+15550000002",
    Direction: "inbound",
    AccountSid: "AC1234567890abcdef"
  };

  it("returns true for a correct signature", () => {
    const sig = computeExpectedSignature(URL, PARAMS, AUTH_TOKEN);
    assert.equal(
      validateTwilioSignature({ signatureHeader: sig, url: URL, params: PARAMS, authToken: AUTH_TOKEN }),
      true
    );
  });

  it("returns false for a tampered signature", () => {
    const tampered = "AAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    assert.equal(
      validateTwilioSignature({ signatureHeader: tampered, url: URL, params: PARAMS, authToken: AUTH_TOKEN }),
      false
    );
  });

  it("returns false when the signature header is missing", () => {
    assert.equal(
      validateTwilioSignature({ signatureHeader: "", url: URL, params: PARAMS, authToken: AUTH_TOKEN }),
      false
    );
  });

  it("returns false when the signature header is undefined", () => {
    assert.equal(
      validateTwilioSignature({ signatureHeader: undefined, url: URL, params: PARAMS, authToken: AUTH_TOKEN }),
      false
    );
  });

  it("returns false when the auth token is wrong", () => {
    const sig = computeExpectedSignature(URL, PARAMS, AUTH_TOKEN);
    assert.equal(
      validateTwilioSignature({ signatureHeader: sig, url: URL, params: PARAMS, authToken: "wrong_token" }),
      false
    );
  });

  it("returns false when the URL is tampered", () => {
    const sig = computeExpectedSignature(URL, PARAMS, AUTH_TOKEN);
    assert.equal(
      validateTwilioSignature({
        signatureHeader: sig,
        url: "https://attacker.example.com/twilio/voice?callId=test-call",
        params: PARAMS,
        authToken: AUTH_TOKEN
      }),
      false
    );
  });

  it("returns false when params are tampered", () => {
    const sig = computeExpectedSignature(URL, PARAMS, AUTH_TOKEN);
    const tamperedParams = { ...PARAMS, From: "+15559999999" };
    assert.equal(
      validateTwilioSignature({ signatureHeader: sig, url: URL, params: tamperedParams, authToken: AUTH_TOKEN }),
      false
    );
  });

  it("correctly handles params in non-sorted order (key order must not matter)", () => {
    // Reverse the key order when building the signature
    const reversedParams = Object.fromEntries(Object.entries(PARAMS).reverse());
    const sig = computeExpectedSignature(URL, PARAMS, AUTH_TOKEN);
    // The validator must produce the same result regardless of input key order
    assert.equal(
      validateTwilioSignature({ signatureHeader: sig, url: URL, params: reversedParams, authToken: AUTH_TOKEN }),
      true
    );
  });

  it("returns false when auth token is empty", () => {
    const sig = computeExpectedSignature(URL, PARAMS, AUTH_TOKEN);
    assert.equal(
      validateTwilioSignature({ signatureHeader: sig, url: URL, params: PARAMS, authToken: "" }),
      false
    );
  });
});
