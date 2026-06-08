import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SarvamClient } from "../src/sarvamClient.js";

const silentLogger = {
  warn() {}
};

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
    json: async () => payload
  };
}

describe("Sarvam client", () => {
  it("retries transient STT failures and normalizes transcript text", async () => {
    const audioPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "retaildaddy-sarvam-")), "q.wav");
    fs.writeFileSync(audioPath, "not a real wav but enough for request construction");
    const calls = [];
    const client = new SarvamClient({
      apiKey: "test-key",
      logger: silentLogger,
      maxRetries: 1,
      retryDelayMs: 0,
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        if (calls.length === 1) {
          return jsonResponse(503, { error: "try again" });
        }
        return jsonResponse(200, { text: "  hello client  " });
      }
    });

    const result = await client.transcribeFile(audioPath, {
      languageCode: "unknown",
      mode: "transcribe"
    });

    assert.equal(result.transcript, "hello client");
    assert.equal(calls.length, 2);
    assert.equal(calls[1].init.body.get("language_code"), null);
  });

  it("does not retry non-transient Sarvam errors", async () => {
    const audioPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "retaildaddy-sarvam-")), "q.wav");
    fs.writeFileSync(audioPath, "request body");
    let calls = 0;
    const client = new SarvamClient({
      apiKey: "test-key",
      logger: silentLogger,
      maxRetries: 2,
      retryDelayMs: 0,
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse(400, { error: "bad input" });
      }
    });

    await assert.rejects(() => client.transcribeFile(audioPath), /HTTP 400/);
    assert.equal(calls, 1);
  });
});
