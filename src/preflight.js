import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { validateDemoScript } from "./demoScript.js";

export const PREFLIGHT_MODES = Object.freeze(["rehearse", "demo", "launch"]);

const COMMON_REQUIREMENTS = Object.freeze([
  {
    key: "SARVAM_API_KEY",
    configPath: "sarvam.apiKey",
    message: "Set SARVAM_API_KEY so Sarvam STT, TTS, and chat can run."
  },
  {
    key: "PRODUCT_URL",
    configPath: "browser.productUrl",
    message: "Set PRODUCT_URL to the SaaS app URL the agent should open during the walkthrough."
  },
  {
    key: "DEMO_SCRIPT_PATH",
    configPath: "paths.demoScript",
    message: "Set DEMO_SCRIPT_PATH to a readable JSON demo script."
  },
  {
    key: "PRODUCT_KB_PATH",
    configPath: "paths.productKnowledge",
    message: "Set PRODUCT_KB_PATH to a readable product knowledge file."
  }
]);

const DEMO_REQUIREMENTS = Object.freeze([
  {
    key: "GOOGLE_MEET_URL",
    configPath: "browser.meetUrl",
    message: "Set GOOGLE_MEET_URL to the Meet link before running a live demo."
  }
]);

const LAUNCH_REQUIREMENTS = Object.freeze([
  {
    key: "MEET_AUTO_PRESENT",
    configPath: "browser.autoPresent",
    requiredValue: true,
    message: "Set MEET_AUTO_PRESENT=true for launch mode so the agent attempts screen sharing."
  }
]);

function issue({ severity = "error", source, key, configPath, message }) {
  return { severity, source, key, configPath, message };
}

function getConfigValue(config, configPath) {
  return configPath.split(".").reduce((current, segment) => {
    if (current == null || typeof current !== "object") return undefined;
    return current[segment];
  }, config);
}

function hasValue(value) {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function cloneRequirement(requirement) {
  return { ...requirement };
}

export function normalizePreflightMode(mode = "rehearse") {
  const normalized = String(mode || "rehearse").trim().toLowerCase();
  if (!PREFLIGHT_MODES.includes(normalized)) {
    throw new Error(
      `Unsupported preflight mode "${mode}". Use one of: ${PREFLIGHT_MODES.join(", ")}.`
    );
  }
  return normalized;
}

export function getModeRequirements(mode = "rehearse") {
  const normalizedMode = normalizePreflightMode(mode);
  const requirements = [...COMMON_REQUIREMENTS];

  if (normalizedMode === "demo" || normalizedMode === "launch") {
    requirements.push(...DEMO_REQUIREMENTS);
  }

  if (normalizedMode === "launch") {
    requirements.push(...LAUNCH_REQUIREMENTS);
  }

  return requirements.map(cloneRequirement);
}

export function validateRequiredConfig(config, { mode = "rehearse" } = {}) {
  const normalizedMode = normalizePreflightMode(mode);
  const requirements = getModeRequirements(normalizedMode);

  return requirements.flatMap((requirement) => {
    const value = getConfigValue(config, requirement.configPath);
    const missing =
      "requiredValue" in requirement ? value !== requirement.requiredValue : !hasValue(value);

    if (!missing) return [];

    return [
      issue({
        source: "config",
        key: requirement.key,
        configPath: requirement.configPath,
        message: requirement.message
      })
    ];
  });
}

export function resolvePreflightPath(filePath, { cwd = process.cwd() } = {}) {
  if (!isNonEmptyString(filePath)) return "";
  return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
}

function validateReadableFile(filePath, { cwd, key, label }) {
  if (!isNonEmptyString(filePath)) return { absolutePath: "", issues: [] };

  const absolutePath = resolvePreflightPath(filePath, { cwd });
  const fileIssues = [];

  if (!fs.existsSync(absolutePath)) {
    fileIssues.push(
      issue({
        source: "asset",
        key,
        message: `${label} does not exist at ${absolutePath}.`
      })
    );
    return { absolutePath, issues: fileIssues };
  }

  const stat = fs.statSync(absolutePath);
  if (!stat.isFile()) {
    fileIssues.push(
      issue({
        source: "asset",
        key,
        message: `${label} must be a file, but ${absolutePath} is not a file.`
      })
    );
    return { absolutePath, issues: fileIssues };
  }

  try {
    fs.accessSync(absolutePath, fs.constants.R_OK);
  } catch {
    fileIssues.push(
      issue({
        source: "asset",
        key,
        message: `${label} is not readable at ${absolutePath}.`
      })
    );
  }

  return { absolutePath, issues: fileIssues };
}

function validateScriptReadiness(script, source) {
  const scriptIssues = [];

  if (!isNonEmptyString(script.opening)) {
    scriptIssues.push(
      issue({
        source: "asset",
        key: "DEMO_SCRIPT_PATH",
        message: `${source} must include a non-empty top-level opening line.`
      })
    );
  }

  if (!isNonEmptyString(script.closing)) {
    scriptIssues.push(
      issue({
        source: "asset",
        key: "DEMO_SCRIPT_PATH",
        message: `${source} must include a non-empty top-level closing line.`
      })
    );
  }

  const seenStepIds = new Set();
  for (const step of script.steps || []) {
    if (seenStepIds.has(step.id)) {
      scriptIssues.push(
        issue({
          source: "asset",
          key: "DEMO_SCRIPT_PATH",
          message: `${source} has duplicate step id "${step.id}".`
        })
      );
    }
    seenStepIds.add(step.id);

    if (step.highlight != null && !isNonEmptyString(step.highlight)) {
      scriptIssues.push(
        issue({
          source: "asset",
          key: "DEMO_SCRIPT_PATH",
          message: `${source} step "${step.id}" highlight must be a non-empty CSS selector string.`
        })
      );
    }

    if (step.zoom != null) {
      const zoom = Number(step.zoom);
      if (!Number.isFinite(zoom)) {
        scriptIssues.push(
          issue({
            source: "asset",
            key: "DEMO_SCRIPT_PATH",
            message: `${source} step "${step.id}" zoom must be a number.`
          })
        );
      } else if (zoom < 0.75 || zoom > 1.5) {
        scriptIssues.push(
          issue({
            severity: "warning",
            source: "asset",
            key: "DEMO_SCRIPT_PATH",
            message: `${source} step "${step.id}" zoom ${zoom} will be clamped to the 0.75-1.5 range.`
          })
        );
      }
    }

    if (!Array.isArray(step.keywords) || step.keywords.length === 0) {
      scriptIssues.push(
        issue({
          severity: "warning",
          source: "asset",
          key: "DEMO_SCRIPT_PATH",
          message: `${source} step "${step.id}" has no keywords, so question routing cannot revisit it.`
        })
      );
    }
  }

  return scriptIssues;
}

export function validateDemoAssets(config, { cwd = process.cwd() } = {}) {
  const assetIssues = [];
  const demoScriptPath = getConfigValue(config, "paths.demoScript");
  const productKnowledgePath = getConfigValue(config, "paths.productKnowledge");

  const scriptFile = validateReadableFile(demoScriptPath, {
    cwd,
    key: "DEMO_SCRIPT_PATH",
    label: "Demo script"
  });
  assetIssues.push(...scriptFile.issues);

  if (scriptFile.absolutePath && scriptFile.issues.length === 0) {
    try {
      const script = JSON.parse(fs.readFileSync(scriptFile.absolutePath, "utf8"));
      validateDemoScript(script, scriptFile.absolutePath);
      assetIssues.push(...validateScriptReadiness(script, scriptFile.absolutePath));
    } catch (error) {
      assetIssues.push(
        issue({
          source: "asset",
          key: "DEMO_SCRIPT_PATH",
          message: `Demo script is invalid: ${error.message}`
        })
      );
    }
  }

  const knowledgeFile = validateReadableFile(productKnowledgePath, {
    cwd,
    key: "PRODUCT_KB_PATH",
    label: "Product knowledge"
  });
  assetIssues.push(...knowledgeFile.issues);

  if (knowledgeFile.absolutePath && knowledgeFile.issues.length === 0) {
    const content = fs.readFileSync(knowledgeFile.absolutePath, "utf8");
    if (!content.trim()) {
      assetIssues.push(
        issue({
          source: "asset",
          key: "PRODUCT_KB_PATH",
          message: `Product knowledge must not be empty at ${knowledgeFile.absolutePath}.`
        })
      );
    }
  }

  return assetIssues;
}

export function formatPreflightIssue(preflightIssue) {
  return preflightIssue.message;
}

export function runPreflight(config, { mode = "rehearse", cwd = process.cwd() } = {}) {
  const normalizedMode = normalizePreflightMode(mode);
  const issues = [
    ...validateRequiredConfig(config, { mode: normalizedMode }),
    ...validateDemoAssets(config, { cwd })
  ];

  if (
    normalizedMode === "launch" &&
    !hasValue(getConfigValue(config, "audio.streamCommand")) &&
    !hasValue(getConfigValue(config, "audio.captureCommand"))
  ) {
    issues.push(
      issue({
        severity: "warning",
        source: "config",
        key: "AUDIO_STREAM_COMMAND",
        configPath: "audio.streamCommand",
        message:
          "Neither AUDIO_STREAM_COMMAND nor AUDIO_CAPTURE_COMMAND is set, so automatic spoken client Q&A will be disabled. Typed Q&A and scripted narration still work."
      })
    );
  }

  const errors = issues.filter((preflightIssue) => preflightIssue.severity === "error");
  const warnings = issues.filter((preflightIssue) => preflightIssue.severity === "warning");

  return {
    mode: normalizedMode,
    ready: errors.length === 0,
    issues,
    errors,
    warnings,
    missingSetupItems: errors.map(formatPreflightIssue)
  };
}

export function getMissingSetupItems(config, options = {}) {
  return runPreflight(config, options).missingSetupItems;
}

export function formatPreflightReport(result) {
  const lines = [
    result.ready
      ? `Preflight passed for ${result.mode} mode.`
      : `Preflight failed for ${result.mode} mode.`
  ];

  if (result.errors.length > 0) {
    lines.push("", "Missing setup:");
    for (const item of result.errors) {
      lines.push(`- ${formatPreflightIssue(item)}`);
    }
  }

  if (result.warnings.length > 0) {
    lines.push("", "Warnings:");
    for (const item of result.warnings) {
      lines.push(`- ${formatPreflightIssue(item)}`);
    }
  }

  return lines.join("\n");
}

export function assertPreflightReady(config, options = {}) {
  const result = runPreflight(config, options);
  if (!result.ready) {
    throw new Error(formatPreflightReport(result));
  }
  return result;
}

/**
 * @param {object} config
 * @returns {{ok: boolean, missing: string[]}}
 */
export function checkCallAgent(config) {
  const missing = [];
  if (!config.sarvam?.apiKey) missing.push("SARVAM_API_KEY");
  if (!config.calling?.publicBaseUrl) missing.push("CALL_PUBLIC_BASE_URL");
  if (config.booking?.emailLink) {
    if (!config.booking.googleClientId) missing.push("GOOGLE_AGENT_CLIENT_ID");
    if (!config.booking.googleClientSecret) missing.push("GOOGLE_AGENT_CLIENT_SECRET");
    if (!config.booking.googleRefreshToken) missing.push("GOOGLE_AGENT_REFRESH_TOKEN");
  }
  return { ok: missing.length === 0, missing };
}

/**
 * @param {object} config
 * @returns {{ok: boolean, missing: string[]}}
 */
export function checkMeetAgent(config) {
  const missing = [];
  if (!config.sarvam?.apiKey) missing.push("SARVAM_API_KEY");
  if (!config.browser?.meetUrl) missing.push("GOOGLE_MEET_URL");
  return { ok: missing.length === 0, missing };
}
