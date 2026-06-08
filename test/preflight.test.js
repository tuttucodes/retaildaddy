import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertPreflightReady,
  formatPreflightReport,
  getMissingSetupItems,
  getModeRequirements,
  normalizePreflightMode,
  runPreflight,
  validateDemoAssets,
  validateRequiredConfig
} from "../src/preflight.js";

function validScript(overrides = {}) {
  return {
    title: "RetailDaddy Demo",
    opening: "Hello, I will walk you through RetailDaddy.",
    closing: "That completes the walkthrough.",
    steps: [
      {
        id: "dashboard",
        title: "Dashboard",
        say: "This dashboard shows the operating summary.",
        action: { type: "navigate", url: "/" },
        highlight: "[data-demo='dashboard']",
        zoom: 1.05,
        keywords: ["dashboard", "summary"]
      }
    ],
    ...overrides
  };
}

function writeFixture({ script = validScript(), knowledge = "RetailDaddy tracks inventory." } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retaildaddy-preflight-"));
  const demoScript = path.join(dir, "demo-script.json");
  const productKnowledge = path.join(dir, "product-knowledge.md");
  fs.writeFileSync(demoScript, JSON.stringify(script, null, 2));
  fs.writeFileSync(productKnowledge, knowledge);
  return { dir, demoScript, productKnowledge };
}

function validConfig(overrides = {}) {
  const fixture = writeFixture(overrides.fixture);
  return {
    fixture,
    sarvam: { apiKey: "sarvam-key" },
    paths: {
      demoScript: fixture.demoScript,
      productKnowledge: fixture.productKnowledge
    },
    browser: {
      productUrl: "http://localhost:3000",
      meetUrl: "https://meet.google.com/abc-defg-hij",
      autoPresent: true,
      desktopCaptureSource: "RetailDaddy Agent Stage"
    },
    audio: {
      captureCommand: "ffmpeg -f avfoundation -i :0 recordings/client.wav",
      playCommand: ""
    },
    agent: { name: "RetailDaddy AI Demo Agent" },
    ...overrides.config
  };
}

describe("preflight mode requirements", () => {
  it("normalizes supported modes and rejects unknown modes", () => {
    assert.equal(normalizePreflightMode(" DEMO "), "demo");
    assert.throws(() => normalizePreflightMode("prod"), /Unsupported preflight mode/);
  });

  it("returns the stricter launch requirements", () => {
    const keys = getModeRequirements("launch").map((requirement) => requirement.key);
    assert.deepEqual(keys, [
      "SARVAM_API_KEY",
      "PRODUCT_URL",
      "DEMO_SCRIPT_PATH",
      "PRODUCT_KB_PATH",
      "GOOGLE_MEET_URL",
      "MEET_AUTO_PRESENT"
    ]);
  });

  it("reports missing config for launch mode", () => {
    const config = validConfig({
      config: {
        sarvam: { apiKey: "" },
        browser: {
          productUrl: "http://localhost:3000",
          meetUrl: "",
          autoPresent: false
        },
        audio: { captureCommand: "" }
      }
    });

    const missing = getMissingSetupItems(config, { mode: "launch" }).join("\n");

    assert.match(missing, /SARVAM_API_KEY/);
    assert.match(missing, /GOOGLE_MEET_URL/);
    assert.match(missing, /MEET_AUTO_PRESENT=true/);
  });

  it("warns but does not fail launch mode when audio capture is missing", () => {
    const config = validConfig({
      config: {
        audio: { captureCommand: "" }
      }
    });

    const result = runPreflight(config, { mode: "launch" });

    assert.equal(result.ready, true);
    assert.match(
      result.warnings.map((preflightIssue) => preflightIssue.message).join("\n"),
      /automatic spoken client Q&A will be disabled/
    );
  });

  it("does not require launch-only config in demo mode", () => {
    const config = validConfig({
      config: {
        browser: {
          productUrl: "http://localhost:3000",
          meetUrl: "https://meet.google.com/abc-defg-hij",
          autoPresent: false
        },
        audio: { captureCommand: "" }
      }
    });

    const issues = validateRequiredConfig(config, { mode: "demo" });

    assert.deepEqual(issues, []);
  });
});

describe("demo asset validation", () => {
  it("passes with readable script and knowledge files", () => {
    const config = validConfig();
    const result = runPreflight(config, { mode: "rehearse" });

    assert.equal(result.ready, true);
    assert.deepEqual(result.missingSetupItems, []);
    assert.deepEqual(result.warnings, []);
  });

  it("reports missing and unreadable asset paths as setup items", () => {
    const config = validConfig({
      config: {
        paths: {
          demoScript: "missing-script.json",
          productKnowledge: "missing-kb.md"
        }
      }
    });

    const issues = validateDemoAssets(config, { cwd: config.fixture.dir });
    const messages = issues.map((preflightIssue) => preflightIssue.message).join("\n");

    assert.match(messages, /Demo script does not exist/);
    assert.match(messages, /Product knowledge does not exist/);
  });

  it("validates script readiness beyond the base demo schema", () => {
    const config = validConfig({
      fixture: {
        script: validScript({
          opening: "",
          closing: "",
          steps: [
            {
              id: "dashboard",
              title: "Dashboard",
              say: "Dashboard",
              action: { type: "navigate", url: "/" },
              zoom: 2
            }
          ]
        })
      }
    });

    const result = runPreflight(config, { mode: "rehearse" });
    const errors = result.errors.map((preflightIssue) => preflightIssue.message).join("\n");
    const warnings = result.warnings.map((preflightIssue) => preflightIssue.message).join("\n");

    assert.equal(result.ready, false);
    assert.match(errors, /opening line/);
    assert.match(errors, /closing line/);
    assert.match(warnings, /zoom 2 will be clamped/);
    assert.match(warnings, /has no keywords/);
  });

  it("fails on invalid demo script JSON", () => {
    const config = validConfig();
    fs.writeFileSync(config.paths.demoScript, "{bad json");

    const result = runPreflight(config, { mode: "rehearse" });

    assert.equal(result.ready, false);
    assert.match(result.missingSetupItems.join("\n"), /Demo script is invalid/);
  });

  it("requires non-empty product knowledge", () => {
    const config = validConfig({ fixture: { knowledge: "   \n" } });
    const result = runPreflight(config, { mode: "rehearse" });

    assert.equal(result.ready, false);
    assert.match(result.missingSetupItems.join("\n"), /Product knowledge must not be empty/);
  });
});

describe("preflight reporting", () => {
  it("formats a readable report and throws when setup is incomplete", () => {
    const config = validConfig({
      config: {
        browser: {
          productUrl: "http://localhost:3000",
          meetUrl: ""
        }
      }
    });

    const result = runPreflight(config, { mode: "demo" });
    const report = formatPreflightReport(result);

    assert.match(report, /Preflight failed for demo mode/);
    assert.match(report, /Missing setup:/);
    assert.throws(() => assertPreflightReady(config, { mode: "demo" }), /Preflight failed/);
  });

  it("returns the result when setup is ready", () => {
    const config = validConfig();
    const result = assertPreflightReady(config, { mode: "launch" });

    assert.equal(result.ready, true);
    assert.equal(result.mode, "launch");
  });
});
