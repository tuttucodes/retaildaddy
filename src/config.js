import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

export function loadDotEnv(filePath = ".env") {
  const absolutePath = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(absolutePath)) {
    return;
  }

  const lines = fs.readFileSync(absolutePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

export function boolFromEnv(name, defaultValue = false) {
  const value = process.env[name];
  if (value == null || value === "") return defaultValue;
  return TRUE_VALUES.has(value.toLowerCase());
}

export function numberFromEnv(name, defaultValue) {
  const value = process.env[name];
  if (value == null || value === "") return defaultValue;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

export function resolveProjectPath(filePath) {
  if (!filePath) return undefined;
  return path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
}

export function loadConfig() {
  loadDotEnv();

  return {
    sarvam: {
      apiKey: process.env.SARVAM_API_KEY || "",
      sttModel: process.env.SARVAM_STT_MODEL || "saaras:v3",
      sttMode: process.env.SARVAM_STT_MODE || "transcribe",
      sttLanguageCode: process.env.SARVAM_STT_LANGUAGE_CODE || "unknown",
      ttsModel: process.env.SARVAM_TTS_MODEL || "bulbul:v3",
      ttsLanguageCode: process.env.SARVAM_TTS_LANGUAGE_CODE || "en-IN",
      ttsSpeaker: process.env.SARVAM_TTS_SPEAKER || "shubh",
      ttsPace: numberFromEnv("SARVAM_TTS_PACE", 1),
      chatModel: process.env.SARVAM_CHAT_MODEL || "sarvam-105b"
    },
    agent: {
      name: process.env.AGENT_NAME || "RetailDaddy AI Demo Agent",
      discloseAi: boolFromEnv("DISCLOSE_AI", true)
    },
    paths: {
      demoScript: resolveProjectPath(process.env.DEMO_SCRIPT_PATH || "demo/demo-script.example.json"),
      productKnowledge: resolveProjectPath(
        process.env.PRODUCT_KB_PATH || "demo/product-knowledge.example.md"
      ),
      audioOutDir: resolveProjectPath(process.env.AUDIO_OUT_DIR || "audio-out"),
      audioInputDir: resolveProjectPath(process.env.AUDIO_INPUT_DIR || "recordings"),
      chromeProfileDir: resolveProjectPath(process.env.CHROME_PROFILE_DIR || "playwright-profile")
    },
    browser: {
      productUrl: process.env.PRODUCT_URL || "http://localhost:3000",
      meetUrl: process.env.GOOGLE_MEET_URL || "",
      meetDisplayName: process.env.MEET_DISPLAY_NAME || process.env.AGENT_NAME || "RetailDaddy AI Demo Agent",
      autoPresent: boolFromEnv("MEET_AUTO_PRESENT", false),
      desktopCaptureSource: process.env.DESKTOP_CAPTURE_SOURCE || "RetailDaddy Agent Stage",
      stageTitle: process.env.AGENT_STAGE_TITLE || process.env.DESKTOP_CAPTURE_SOURCE || "RetailDaddy Agent Stage",
      headless: boolFromEnv("HEADLESS", false)
    },
    audio: {
      playCommand: process.env.AUDIO_PLAY_COMMAND || "",
      captureCommand: process.env.AUDIO_CAPTURE_COMMAND || "",
      autoListen: boolFromEnv("AUDIO_AUTO_LISTEN", false)
    }
  };
}

export function requireSarvamKey(config) {
  if (!config.sarvam.apiKey) {
    throw new Error("Missing SARVAM_API_KEY. Add it to .env before using Sarvam voice or chat.");
  }
}
