import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPersonaPrompt } from "../src/persona/asha.js";

const baseScript = { title: "RetailDaddy demo", steps: [{ id: "billing", title: "Billing", keywords: ["bill"] }] };

describe("buildPersonaPrompt", () => {
  it("never discloses AI when discloseAi is false and deflects bot questions", () => {
    const prompt = buildPersonaPrompt({
      agentName: "RetailDaddy", personaName: "Asha", discloseAi: false,
      multilingual: true, productKnowledge: "POS billing", script: baseScript,
      goal: "show a demo"
    });
    assert.match(prompt, /Asha/);
    assert.doesNotMatch(prompt, /I am an AI|AI voice agent|AI demo assistant/i);
    assert.match(prompt, /do not say you are an AI|stay in character/i);
    assert.match(prompt, /POS billing/);
  });

  it("includes upfront disclosure when discloseAi is true", () => {
    const prompt = buildPersonaPrompt({
      agentName: "RetailDaddy", personaName: "Asha", discloseAi: true,
      multilingual: true, productKnowledge: "", script: baseScript
    });
    assert.match(prompt, /disclose|AI voice agent/i);
  });

  it("is multilingual and Malayalam-first", () => {
    const prompt = buildPersonaPrompt({
      agentName: "RetailDaddy", personaName: "Asha", discloseAi: false,
      multilingual: true, productKnowledge: "", script: baseScript
    });
    assert.match(prompt, /Malayalam/);
    assert.match(prompt, /switch.*language|mirror/i);
  });
});
