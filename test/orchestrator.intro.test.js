import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DemoOrchestrator } from "../src/orchestrator.js";

describe("orchestrator human intro + join retry", () => {
  it("retries a failing join up to meet.joinRetries then succeeds", async () => {
    const logger = { info() {}, warn() {}, error() {} };
    const config = {
      sarvam: { apiKey: "k", sttModel: "m", sttMode: "x", sttLanguageCode: "ml-IN", ttsModel: "bulbul:v3", ttsSpeaker: "anushka", ttsPace: 1, ttsSampleRate: 24000, ttsLanguageCode: "ml-IN", chatModel: "c" },
      agent: { name: "RetailDaddy", discloseAi: false, multilingual: true, confirmationPattern: "start demo" },
      paths: { demoScript: "demo/demo-script.example.json", productKnowledge: "demo/product-knowledge.example.md", audioOutDir: "/tmp", audioInputDir: "/tmp" },
      audio: {}, browser: {}, meet: { vadRms: 0.008, silenceMs: 650, joinRetries: 2 }
    };
    const orch = new DemoOrchestrator({ config, logger });
    let attempts = 0;
    orch.meetAgent.launch = async () => {};
    orch.meetAgent.joinMeet = async () => { attempts += 1; if (attempts < 2) throw new Error("join flaked"); };
    await orch.joinMeetWithRetry({ autoPresent: false });
    assert.equal(attempts, 2);
  });

  it("builds a human intro line in the persona voice", () => {
    const logger = { info() {}, warn() {}, error() {} };
    const config = {
      sarvam: { apiKey: "k", sttModel: "m", sttMode: "x", sttLanguageCode: "ml-IN", ttsModel: "bulbul:v3", ttsSpeaker: "anushka", ttsPace: 1, ttsSampleRate: 24000, ttsLanguageCode: "ml-IN", chatModel: "c" },
      agent: { name: "RetailDaddy", discloseAi: false, multilingual: true, confirmationPattern: "start demo" },
      paths: { demoScript: "demo/demo-script.example.json", productKnowledge: "demo/product-knowledge.example.md", audioOutDir: "/tmp", audioInputDir: "/tmp" },
      audio: {}, browser: {}, meet: { vadRms: 0.008, silenceMs: 650, joinRetries: 1 }
    };
    const orch = new DemoOrchestrator({ config, logger });
    const intro = orch.buildJoinIntro();
    assert.match(intro, /RetailDaddy/);
    assert.doesNotMatch(intro, /\bAI\b/i);
  });
});
