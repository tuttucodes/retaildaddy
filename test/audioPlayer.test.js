import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { playAudio } from "../src/audioPlayer.js";

describe("playAudio abort", () => {
  it("rejects/stops promptly when the signal aborts", async () => {
    const controller = new AbortController();
    // 'sleep 5' stands in for a long playback command.
    const promise = playAudio("ignored", "sleep 5", { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    const start = Date.now();
    await promise.catch(() => {});
    assert.ok(Date.now() - start < 2000, "playback should stop soon after abort");
  });
});
