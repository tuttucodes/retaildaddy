import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeSpokenEmail, buildReadback } from "../src/booking/emailCapture.js";

describe("normalizeSpokenEmail", () => {
  it("converts spoken 'at' and 'dot' to symbols", () => {
    assert.equal(normalizeSpokenEmail("rahul at gmail dot com"), "rahul@gmail.com");
  });
  it("strips spaces and lowercases", () => {
    assert.equal(normalizeSpokenEmail("R A H U L @ Gmail . com"), "rahul@gmail.com");
  });
  it("repairs common domain mishears", () => {
    assert.equal(normalizeSpokenEmail("rahul@gmailcom"), "rahul@gmail.com");
    assert.equal(normalizeSpokenEmail("rahul at g mail dot com"), "rahul@gmail.com");
  });
  it("returns empty string when no plausible email is present", () => {
    assert.equal(normalizeSpokenEmail("I do not want to share"), "");
  });
});

describe("buildReadback", () => {
  it("spells the email back for confirmation", () => {
    assert.match(buildReadback("rahul@gmail.com"), /r a h u l/i);
    assert.match(buildReadback("rahul@gmail.com"), /gmail/i);
  });
});
