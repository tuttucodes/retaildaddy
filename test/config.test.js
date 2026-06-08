import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

describe("config persona + booking + meet keys", () => {
  const saved = {};
  const keys = ["DISCLOSE_AI", "CALL_EMAIL_LINK", "GOOGLE_AGENT_EMAIL", "MEET_VAD_RMS", "MEET_SILENCE_MS", "CALL_AGENT_TTS_SPEAKER"];
  beforeEach(() => { for (const k of keys) saved[k] = process.env[k]; for (const k of keys) process.env[k] = ""; });
  afterEach(() => { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  it("defaults DISCLOSE_AI to false (human persona)", () => {
    assert.equal(loadConfig().agent.discloseAi, false);
  });

  it("exposes booking + meet barge-in config with sane defaults", () => {
    const c = loadConfig();
    assert.equal(c.booking.emailLink, false);
    assert.equal(c.booking.googleEmail, "");
    assert.equal(c.meet.vadRms, 0.008);
    assert.equal(c.meet.silenceMs, 650);
  });
});
