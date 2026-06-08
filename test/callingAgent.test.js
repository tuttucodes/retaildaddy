import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CallingAgent, buildCallingAgentSystemPrompt } from "../src/callingAgent.js";

function testConfig(audioOutDir) {
  return {
    sarvam: {
      sttModel: "saaras:v3",
      sttMode: "transcribe",
      sttLanguageCode: "unknown",
      ttsModel: "bulbul:v3",
      ttsLanguageCode: "en-IN",
      ttsSpeaker: "shubh",
      ttsPace: 1,
      chatModel: "sarvam-105b"
    },
    agent: {
      name: "RetailDaddy AI Demo Agent",
      discloseAi: true
    },
    calling: {
      agentName: "RetailDaddy AI Calling Agent",
      personaName: "Asha",
      multilingual: true,
      goal: "qualify leads",
      chatModel: "sarvam-30b",
      chatMaxTokens: 95,
      chatTemperature: 0.42,
      ttsSampleRate: 8000,
      ttsSpeaker: "shubh",
      ttsPace: 1.08
    },
    paths: {
      audioOutDir
    }
  };
}

function testScript() {
  return {
    title: "RetailDaddy Demo",
    language: "en-IN",
    steps: [{ id: "billing", title: "Billing", keywords: ["billing", "pos"] }]
  };
}

function fakeSarvamClient() {
  return {
    async chat(messages) {
      const latest = messages[messages.length - 1].content;
      return `I can help with that. You asked: ${latest}`;
    },
    async textToSpeechStream(_text, outputPath) {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, "wav");
      return outputPath;
    },
    async transcribeFile() {
      return { transcript: "I want pricing and a demo" };
    }
  };
}

function recordingSarvamClient(calls) {
  return {
    async chat(messages) {
      return messages[messages.length - 1].content;
    },
    async textToSpeechStream(_text, outputPath, options) {
      calls.push(options);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, "wav");
      return outputPath;
    },
    async transcribeFile() {
      return { transcript: "" };
    }
  };
}

describe("calling agent", () => {
  it("builds a voice-agent prompt with AI disclosure and product knowledge", () => {
    const prompt = buildCallingAgentSystemPrompt({
      agentName: "RetailDaddy AI Calling Agent",
      discloseAi: true,
      multilingual: true,
      goal: "qualify leads",
      productKnowledge: "RetailDaddy supports POS billing.",
      script: testScript()
    });

    assert.match(prompt, /AI voice agent/);
    assert.match(prompt, /Asha/);
    assert.match(prompt, /retail-tech consultant/);
    assert.match(prompt, /POS billing/);
    assert.match(prompt, /qualify leads/);
    assert.match(prompt, /speech-to-speech/);
    assert.match(prompt, /Malayalam/);
    assert.match(prompt, /Actively listen/);
  });

  it("starts a call, answers a turn, and updates call intent state", async () => {
    const audioOutDir = fs.mkdtempSync(path.join(os.tmpdir(), "retaildaddy-call-audio-"));
    const agent = new CallingAgent({
      sarvamClient: fakeSarvamClient(),
      config: testConfig(audioOutDir),
      script: testScript(),
      productKnowledge: "RetailDaddy supports POS billing.",
      logger: { info() {}, warn() {}, error() {} }
    });

    const started = await agent.startCall({ callerName: "Rahul", callerPhone: "+91 999" });
    assert.equal(started.session.status, "active");
    assert.match(started.answer, /RetailDaddy/);
    assert.ok(fs.existsSync(started.audioPath));

    const turn = await agent.handleText(started.session.id, "What is the price? Can I book a demo?");
    assert.equal(turn.session.interest, "demo");
    assert.equal(turn.session.nextAction, "schedule_demo");
    assert.match(turn.answer, /price/);

    const summary = await agent.summarize(started.session.id);
    assert.match(summary.summary, /You asked/);
  });

  it("uses English TTS fallback for English text in multilingual calls", async () => {
    const audioOutDir = fs.mkdtempSync(path.join(os.tmpdir(), "retaildaddy-call-audio-"));
    const config = testConfig(audioOutDir);
    config.sarvam.ttsLanguageCode = "ml-IN";
    const ttsCalls = [];
    const agent = new CallingAgent({
      sarvamClient: recordingSarvamClient(ttsCalls),
      config,
      script: testScript(),
      productKnowledge: "RetailDaddy supports POS billing.",
      logger: { info() {}, warn() {}, error() {} }
    });

    await agent.startCall({ callerName: "Rahul", callerPhone: "+91 999" });

    assert.equal(ttsCalls[0].languageCode, "en-IN");
    assert.equal(ttsCalls[0].sampleRate, 8000);
  });

  it("handles greeting-only turns without calling chat", async () => {
    const audioOutDir = fs.mkdtempSync(path.join(os.tmpdir(), "retaildaddy-call-audio-"));
    let chatCalls = 0;
    const sarvamClient = {
      async chat() {
        chatCalls += 1;
        return "chat should not be needed";
      },
      async textToSpeechStream(_text, outputPath) {
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, "wav");
        return outputPath;
      },
      async transcribeFile() {
        return { transcript: "" };
      }
    };
    const agent = new CallingAgent({
      sarvamClient,
      config: testConfig(audioOutDir),
      script: testScript(),
      productKnowledge: "RetailDaddy supports POS billing.",
      logger: { info() {}, warn() {}, error() {} }
    });

    const started = await agent.startCall({ callerName: "Rahul", callerPhone: "+91 999" });
    const turn = await agent.handleText(started.session.id, "hello hello");

    assert.equal(chatCalls, 0);
    assert.match(turn.answer, /I'm here, Rahul/);
  });

  it("can answer a text turn without synthesizing audio for streaming transports", async () => {
    const audioOutDir = fs.mkdtempSync(path.join(os.tmpdir(), "retaildaddy-call-audio-"));
    let ttsCalls = 0;
    const sarvamClient = {
      async chat() {
        return "Sure, I can help with that.";
      },
      async textToSpeechStream(_text, outputPath) {
        ttsCalls += 1;
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, "wav");
        return outputPath;
      },
      async transcribeFile() {
        return { transcript: "" };
      }
    };
    const agent = new CallingAgent({
      sarvamClient,
      config: testConfig(audioOutDir),
      script: testScript(),
      productKnowledge: "RetailDaddy supports POS billing.",
      logger: { info() {}, warn() {}, error() {} }
    });

    const started = await agent.startCall({ callerName: "Rahul", callerPhone: "+91 999" });
    const turn = await agent.handleText(started.session.id, "I need billing help", { synthesize: false });

    assert.equal(ttsCalls, 1);
    assert.equal(turn.answer, "Sure, I can help with that.");
    assert.equal(turn.audioPath, undefined);
  });
});

describe("calling agent human persona", () => {
  it("does not disclose AI by default and stays in character", () => {
    const prompt = buildCallingAgentSystemPrompt({
      agentName: "RetailDaddy", productKnowledge: "POS", script: { title: "d", steps: [] },
      goal: "demo", personaName: "Asha", discloseAi: false, multilingual: true
    });
    assert.doesNotMatch(prompt, /AI voice agent|I am an AI/i);
    assert.match(prompt, /stay in character|do not say you are an AI/i);
  });

  it("opens outbound calls interest-led without an AI disclosure", async () => {
    const fakeSarvam = {
      chat: async () => "ok",
      textToSpeechStream: async (_t, p) => p,
      transcribeFile: async () => ({ transcript: "" })
    };
    const agent = new CallingAgent({
      sarvamClient: fakeSarvam,
      config: {
        sarvam: { ttsModel: "bulbul:v3", ttsSpeaker: "anushka", ttsSampleRate: 8000, ttsPace: 1.08, ttsLanguageCode: "ml-IN" },
        calling: { personaName: "Asha", multilingual: true, ttsSpeaker: "anushka" },
        agent: { discloseAi: false, name: "RetailDaddy" },
        paths: { audioOutDir: "/tmp" }
      },
      script: { title: "d", steps: [] }, productKnowledge: "", logger: { info() {}, warn() {}, error() {} }
    });
    const { answer } = await agent.startCall({ callerName: "Rahul", direction: "outbound" });
    assert.doesNotMatch(answer, /AI voice agent/i);
    assert.match(answer, /demo|RetailDaddy/i);
  });
});

describe("calling agent demo booking", () => {
  function makeAgent(overrides = {}) {
    const fakeSarvam = { chat: async () => "Sure.", textToSpeechStream: async (_t, p) => p, transcribeFile: async () => ({ transcript: "" }) };
    return new CallingAgent({
      sarvamClient: fakeSarvam,
      config: {
        sarvam: { ttsModel: "bulbul:v3", ttsSpeaker: "anushka", ttsSampleRate: 8000, ttsPace: 1.08, ttsLanguageCode: "ml-IN" },
        calling: { personaName: "Asha", multilingual: true, ttsSpeaker: "anushka" },
        agent: { discloseAi: false, name: "RetailDaddy" },
        booking: { emailLink: true, googleEmail: "agent@x.com" },
        paths: { audioOutDir: "/tmp" }
      },
      script: { title: "d", steps: [] }, productKnowledge: "", logger: { info() {}, warn() {}, error() {} },
      createMeetEvent: overrides.createMeetEvent
    });
  }

  it("captures a spoken email and books a Meet link when email-link is enabled", async () => {
    let booked = null;
    const agent = makeAgent({
      createMeetEvent: async ({ attendeeEmail }) => { booked = attendeeEmail; return { meetUrl: "https://meet.google.com/abc", eventId: "e1", startIso: "now" }; }
    });
    const session = agent.createSession({ callerName: "Rahul", direction: "outbound" });
    session.nextAction = "schedule_demo";
    await agent.maybeBookDemo(session, "my email is rahul at gmail dot com");
    assert.equal(booked, "rahul@gmail.com");
    assert.equal(session.demo.meetUrl, "https://meet.google.com/abc");
    assert.equal(session.demo.email, "rahul@gmail.com");
  });

  it("does nothing when email-link is disabled", async () => {
    const agent = makeAgent();
    agent.config.booking.emailLink = false;
    const session = agent.createSession({ callerName: "Rahul" });
    session.nextAction = "schedule_demo";
    await agent.maybeBookDemo(session, "rahul at gmail dot com");
    assert.equal(session.demo, undefined);
  });
});
