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
      ttsSampleRate: numberFromEnv("SARVAM_TTS_SAMPLE_RATE", 24000),
      chatModel: process.env.SARVAM_CHAT_MODEL || "sarvam-105b"
    },
    agent: {
      name: process.env.AGENT_NAME || "RetailDaddy AI Demo Agent",
      discloseAi: boolFromEnv("DISCLOSE_AI", false),
      multilingual: boolFromEnv("AGENT_MULTILINGUAL", false),
      waitForConfirmation: boolFromEnv("MEET_WAIT_FOR_CONFIRMATION", true),
      confirmationPattern:
        process.env.DEMO_CONFIRMATION_PATTERN ||
        "start demo|start presenting|start now|begin demo|go ahead|you can start|yes.*start|okay.*start|ok.*start|do it|demo തുടങ്ങ|തുടങ്ങാം|തുടങ്ങു|ആരംഭിക്ക|കാണിക്കൂ"
    },
    calling: {
      agentName: process.env.CALL_AGENT_NAME || "RetailDaddy AI Calling Agent",
      personaName: process.env.CALL_AGENT_PERSONA_NAME || "Asha",
      port: numberFromEnv("CALL_AGENT_PORT", 4180),
      host: process.env.CALL_AGENT_HOST || "0.0.0.0",
      publicBaseUrl: process.env.CALL_PUBLIC_BASE_URL || "",
      provider: process.env.CALL_PROVIDER || "twilio",
      transport: process.env.CALL_AGENT_TRANSPORT || "stream",
      multilingual: boolFromEnv("CALL_AGENT_MULTILINGUAL", true),
      transferPhone: process.env.CALL_AGENT_TRANSFER_PHONE || "",
      chatModel: process.env.CALL_AGENT_CHAT_MODEL || "sarvam-30b",
      chatMaxTokens: numberFromEnv("CALL_AGENT_MAX_TOKENS", 95),
      chatTemperature: numberFromEnv("CALL_AGENT_TEMPERATURE", 0.42),
      recordMaxLength: numberFromEnv("CALL_RECORD_MAX_LENGTH", 7),
      recordTimeout: numberFromEnv("CALL_RECORD_TIMEOUT", 1),
      ttsSpeaker: process.env.CALL_AGENT_TTS_SPEAKER || process.env.SARVAM_TTS_SPEAKER || "shubh",
      ttsPace: numberFromEnv("CALL_AGENT_TTS_PACE", 1.08),
      ttsSampleRate: numberFromEnv("CALL_AGENT_TTS_SAMPLE_RATE", 8000),
      streamSttEnabled: boolFromEnv("CALL_STREAM_STT_ENABLED", true),
      streamTtsEnabled: boolFromEnv("CALL_STREAM_TTS_ENABLED", true),
      streamVadRms: numberFromEnv("CALL_STREAM_VAD_RMS", 0.008),
      streamSilenceMs: numberFromEnv("CALL_STREAM_SILENCE_MS", 650),
      streamMinSpeechMs: numberFromEnv("CALL_STREAM_MIN_SPEECH_MS", 220),
      streamMaxSpeechMs: numberFromEnv("CALL_STREAM_MAX_SPEECH_MS", 9000),
      streamFallbackTranscriptMs: numberFromEnv("CALL_STREAM_FALLBACK_TRANSCRIPT_MS", 900),
      streamTtsMinBufferSize: numberFromEnv("CALL_STREAM_TTS_MIN_BUFFER_SIZE", 20),
      streamTtsMaxChunkLength: numberFromEnv("CALL_STREAM_TTS_MAX_CHUNK_LENGTH", 90),
      validateSignature: boolFromEnv("TWILIO_VALIDATE_SIGNATURE", true),
      goal:
        process.env.CALL_AGENT_GOAL ||
        "qualify retail store leads, answer RetailDaddy questions, capture the caller's need, and move interested callers toward a product demo or human follow-up"
    },
    booking: {
      emailLink: boolFromEnv("CALL_EMAIL_LINK", false),
      googleClientId: process.env.GOOGLE_AGENT_CLIENT_ID || "",
      googleClientSecret: process.env.GOOGLE_AGENT_CLIENT_SECRET || "",
      googleRefreshToken: process.env.GOOGLE_AGENT_REFRESH_TOKEN || "",
      googleEmail: process.env.GOOGLE_AGENT_EMAIL || "",
      calendarId: process.env.GOOGLE_AGENT_CALENDAR_ID || "primary"
    },
    meet: {
      vadRms: numberFromEnv("MEET_VAD_RMS", 0.008),
      silenceMs: numberFromEnv("MEET_SILENCE_MS", 650),
      joinRetries: numberFromEnv("MEET_JOIN_RETRIES", 1)
    },
    paths: {
      demoScript: resolveProjectPath(process.env.DEMO_SCRIPT_PATH || "demo/demo-script.example.json"),
      productKnowledge: resolveProjectPath(
        process.env.PRODUCT_KB_PATH || "demo/product-knowledge.example.md"
      ),
      audioOutDir: resolveProjectPath(process.env.AUDIO_OUT_DIR || "audio-out"),
      audioInputDir: resolveProjectPath(process.env.AUDIO_INPUT_DIR || "recordings"),
      chromeProfileDir: resolveProjectPath(process.env.CHROME_PROFILE_DIR || "playwright-profile"),
      meetDiagnosticsDir: resolveProjectPath(process.env.MEET_DIAGNOSTICS_DIR || ".meet-diagnostics")
    },
    browser: {
      productUrl: process.env.PRODUCT_URL || "http://localhost:3000",
      meetUrl: process.env.GOOGLE_MEET_URL || "",
      meetDisplayName: process.env.MEET_DISPLAY_NAME || process.env.AGENT_NAME || "RetailDaddy AI Demo Agent",
      autoPresent: boolFromEnv("MEET_AUTO_PRESENT", false),
      desktopCaptureSource: process.env.DESKTOP_CAPTURE_SOURCE || "RetailDaddy Agent Stage",
      stageTitle: process.env.AGENT_STAGE_TITLE || process.env.DESKTOP_CAPTURE_SOURCE || "RetailDaddy Agent Stage",
      viewportWidth: numberFromEnv("BROWSER_VIEWPORT_WIDTH", 1920),
      viewportHeight: numberFromEnv("BROWSER_VIEWPORT_HEIGHT", 1080),
      headless: boolFromEnv("HEADLESS", false),
      channel: process.env.BROWSER_CHANNEL || "",
      saveDiagnostics: boolFromEnv("MEET_SAVE_DIAGNOSTICS", true)
    },
    audio: {
      playCommand: process.env.AUDIO_PLAY_COMMAND || "",
      captureCommand: process.env.AUDIO_CAPTURE_COMMAND || "",
      streamCommand: process.env.AUDIO_STREAM_COMMAND || "",
      streamSampleRate: numberFromEnv("AUDIO_STREAM_SAMPLE_RATE", 16000),
      autoListen: boolFromEnv("AUDIO_AUTO_LISTEN", false),
      browserPlayback: boolFromEnv("BROWSER_AUDIO_PLAYBACK", false),
      captionListen: boolFromEnv("MEET_CAPTION_LISTEN", false),
      captionPollMs: numberFromEnv("MEET_CAPTION_POLL_MS", 700),
      inboxPollMs: numberFromEnv("AUDIO_INBOX_POLL_MS", 250),
      inboxStablePolls: numberFromEnv("AUDIO_INBOX_STABLE_POLLS", 1),
      minBytes: numberFromEnv("AUDIO_MIN_BYTES", 24000),
      minRms: numberFromEnv("AUDIO_MIN_RMS", 0.002),
      requireRemoteUnmuted: boolFromEnv("MEET_REQUIRE_REMOTE_UNMUTED", true)
    }
  };
}

export function requireSarvamKey(config) {
  if (!config.sarvam.apiKey) {
    throw new Error("Missing SARVAM_API_KEY. Add it to .env before using Sarvam voice or chat.");
  }
}
