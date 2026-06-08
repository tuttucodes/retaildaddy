import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  absoluteProductUrl,
  findStepForQuestion,
  validateDemoScript
} from "../src/demoScript.js";

const script = {
  title: "Demo",
  steps: [
    {
      id: "inventory",
      title: "Inventory",
      say: "Inventory",
      keywords: ["inventory", "stock"],
      action: { type: "navigate", url: "/inventory" }
    },
    {
      id: "orders",
      title: "Orders",
      say: "Orders",
      keywords: ["orders"],
      action: { type: "navigate", url: "/orders" }
    }
  ]
};

describe("demo script helpers", () => {
  it("validates a supported script", () => {
    assert.doesNotThrow(() => validateDemoScript(script));
  });

  it("rejects unsupported actions", () => {
    assert.throws(
      () =>
        validateDemoScript({
          title: "Demo",
          steps: [{ id: "bad", title: "Bad", say: "Bad", action: { type: "drag" } }]
        }),
      /unsupported action/
    );
  });

  it("finds feature steps from question keywords", () => {
    const step = findStepForQuestion(script, "Can you explain low stock alerts?");
    assert.equal(step.id, "inventory");
  });

  it("builds product URLs from relative routes", () => {
    assert.equal(
      absoluteProductUrl("https://app.example.com/base", "/inventory"),
      "https://app.example.com/inventory"
    );
  });
});
