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
  it("interrupts in-flight speech when a live transcript arrives", async () => {
    const orch = makeOrchestrator();
    let aborted = false;
    // Stub TTS + playback to observe abort.
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
});
