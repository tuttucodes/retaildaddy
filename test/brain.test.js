import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSystemPrompt } from "../src/brain.js";

describe("brain prompt", () => {
  it("requires AI disclosure when enabled", () => {
    const prompt = buildSystemPrompt({
      agentName: "RetailDaddy AI Demo Agent",
      discloseAi: true,
      productKnowledge: "Inventory tracking exists.",
      script: {
        title: "Demo",
        steps: [{ id: "inventory", title: "Inventory", keywords: ["stock"] }]
      }
    });

    assert.match(prompt, /identify yourself as an AI demo assistant/);
    assert.match(prompt, /Inventory tracking exists/);
  });
});
