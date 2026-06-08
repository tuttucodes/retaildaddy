import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DemoOrchestrator } from "../src/orchestrator.js";

function makeOrchestrator() {
  const logger = { info() {}, warn() {}, error() {} };
  const config = {
    sarvam: { apiKey: "k", sttModel: "m", sttMode: "transcribe", sttLanguageCode: "ml-IN", ttsModel: "bulbul:v3", ttsSpeaker: "anushka", ttsPace: 1, ttsSampleRate: 24000, ttsLanguageCode: "ml-IN", chatModel: "sarvam-105b" },
    agent: { name: "RetailDaddy", discloseAi: false, multilingual: true, confirmationPattern: "start demo" },
    paths: { demoScript: "demo/demo-script.example.json", productKnowledge: "demo/product-knowledge.example.md", audioOutDir: "/tmp", audioInputDir: "/tmp" },
    audio: {}, browser: {}, meet: { vadRms: 0.008, silenceMs: 650 }
  };
  const orch = new DemoOrchestrator({ config, logger });
  return orch;
}

describe("orchestrator barge-in", () => {
  it("interrupts in-flight speech when a live transcript arrives during playback", async () => {
    const orch = makeOrchestrator();
    let aborted = false;
    // Stub TTS as instant; playback blocks until abort.
    orch.sarvamClient.textToSpeechStream = async (_t, p) => p;
    orch.playWithSignal = async (_path, signal) => {
      await new Promise((resolve) => {
        if (signal.aborted) { aborted = true; return resolve(); }
        signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true });
      });
    };
    const speaking = orch.speak("a long sentence the user will interrupt", "test");
    // Simulate the human talking mid-utterance.
    setTimeout(() => orch.bargeIn.onUserSpeech(), 30);
    await speaking;
    assert.equal(aborted, true);
    assert.equal(orch.bargeIn.isSpeaking, false);
  });

  it("isSpeaking is true DURING slow TTS download and barge-in during that window aborts TTS", async () => {
    const orch = makeOrchestrator();
    let isSpeakingDuringTts = false;
    let ttsAborted = false;
    let playbackCalled = false;

    // Slow TTS stub: takes 80 ms and respects the abort signal.
    orch.sarvamClient.textToSpeechStream = async (_t, p, opts) => {
      // Record whether isSpeaking was already true when TTS started.
      isSpeakingDuringTts = orch.bargeIn.isSpeaking;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 80);
        opts?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          ttsAborted = true;
          const err = new Error("AbortError");
          err.name = "AbortError";
          reject(err);
        }, { once: true });
      });
      return p;
    };

    // Playback should never be reached because barge-in fires during TTS.
    orch.playWithSignal = async () => { playbackCalled = true; };

    const speaking = orch.speak("something the user interrupts mid-download", "test");

    // Barge-in fires 20 ms in — while the 80 ms TTS stub is still running.
    setTimeout(() => orch.bargeIn.onUserSpeech(), 20);

    // speak() should resolve (not throw) even though TTS was aborted.
    await speaking;

    assert.equal(isSpeakingDuringTts, true, "isSpeaking should be true when TTS begins");
    assert.equal(ttsAborted, true, "TTS fetch should have been aborted via signal");
    assert.equal(playbackCalled, false, "playback should be skipped after barge-in during TTS");
    assert.equal(orch.bargeIn.isSpeaking, false, "isSpeaking should be false after speak() resolves");
  });
});
