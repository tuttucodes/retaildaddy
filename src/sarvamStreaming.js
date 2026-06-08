import { EventEmitter } from "node:events";
import WebSocket from "ws";
import {
  encodePcm16ToMuLaw,
  parsePcm16Wav
} from "./telephonyAudio.js";

const SARVAM_WS_BASE_URL = "wss://api.sarvam.ai";

function waitForOpen(ws, { timeoutMs = 6000 } = {}) {
  if (ws.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("WebSocket did not open in time."));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      ws.off("open", handleOpen);
      ws.off("error", handleError);
      ws.off("close", handleClose);
    };
    const handleOpen = () => {
      cleanup();
      resolve();
    };
    const handleError = (error) => {
      cleanup();
      reject(error);
    };
    const handleClose = (code, reason) => {
      cleanup();
      reject(new Error(`WebSocket closed before open: ${code} ${reason?.toString?.() || ""}`.trim()));
    };
    ws.on("open", handleOpen);
    ws.on("error", handleError);
    ws.on("close", handleClose);
  });
}

function parseJsonMessage(raw) {
  if (Buffer.isBuffer(raw)) return JSON.parse(raw.toString("utf8"));
  return JSON.parse(String(raw));
}

function sarvamWsHeaders(apiKey) {
  return {
    "Api-Subscription-Key": apiKey
  };
}

function isOpen(ws) {
  return ws?.readyState === WebSocket.OPEN;
}

function coerceSarvamAudioToMulaw(audioBuffer, contentType = "") {
  const bytes = Buffer.from(audioBuffer || []);
  const normalizedType = String(contentType || "").toLowerCase();
  if (!bytes.length) return bytes;
  if (normalizedType.includes("mulaw") || normalizedType.includes("basic")) return bytes;
  if (normalizedType.includes("wav") || bytes.toString("ascii", 0, 4) === "RIFF") {
    const wav = parsePcm16Wav(bytes);
    if (wav.sampleRate !== 8000 || wav.channels !== 1) {
      throw new Error(`Sarvam TTS returned ${wav.sampleRate}Hz/${wav.channels}ch WAV; expected 8000Hz mono.`);
    }
    return encodePcm16ToMuLaw(wav.pcm);
  }
  if (normalizedType.includes("linear16") || normalizedType.includes("pcm")) {
    return encodePcm16ToMuLaw(bytes);
  }
  if (normalizedType.includes("mp3") || normalizedType.includes("mpeg")) {
    throw new Error("Sarvam TTS returned MP3 for a Twilio stream; expected raw 8kHz mulaw.");
  }
  return bytes;
}

function normalizeSarvamSttMessage(message) {
  if (message?.type === "data" && message.data?.transcript) {
    return {
      type: "transcript",
      transcript: String(message.data.transcript || "").trim(),
      languageCode: message.data.language_code || "",
      raw: message
    };
  }
  if (message?.type === "events") {
    const signalType = message.data?.signal_type || "";
    if (signalType === "START_SPEECH") return { type: "speech_start", raw: message };
    if (signalType === "END_SPEECH") return { type: "speech_end", raw: message };
  }
  if (message?.type === "speech_start" || message?.type === "speech_end") {
    return { type: message.type, raw: message };
  }
  if (message?.type === "transcript" && (message.text || message.transcript)) {
    return {
      type: "transcript",
      transcript: String(message.text || message.transcript || "").trim(),
      languageCode: message.language_code || message.languageCode || "",
      raw: message
    };
  }
  if (message?.type === "error") {
    return {
      type: "error",
      error: new Error(message.data?.error || message.data?.message || message.error || "Sarvam STT stream error."),
      raw: message
    };
  }
  return { type: "unknown", raw: message };
}

export class SarvamStreamingStt extends EventEmitter {
  constructor({
    apiKey,
    logger,
    model = "saaras:v3",
    mode = "transcribe",
    languageCode = "unknown",
    sampleRate = 8000,
    highVadSensitivity = true,
    vadSignals = true,
    flushSignal = true,
    inputAudioCodec = "pcm_s16le",
    WebSocketImpl = WebSocket
  }) {
    super();
    this.apiKey = apiKey;
    this.logger = logger;
    this.sampleRate = sampleRate;
    this.inputAudioCodec = inputAudioCodec;
    this.WebSocketImpl = WebSocketImpl;

    const url = new URL("/speech-to-text/ws", SARVAM_WS_BASE_URL);
    url.searchParams.set("language-code", languageCode || "unknown");
    url.searchParams.set("model", model || "saaras:v3");
    url.searchParams.set("mode", mode || "transcribe");
    url.searchParams.set("sample_rate", String(sampleRate));
    url.searchParams.set("input_audio_codec", inputAudioCodec);
    url.searchParams.set("high_vad_sensitivity", String(Boolean(highVadSensitivity)));
    url.searchParams.set("vad_signals", String(Boolean(vadSignals)));
    url.searchParams.set("flush_signal", String(Boolean(flushSignal)));
    this.url = url.toString();
    this.ws = null;
    this.opened = false;
  }

  async connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return this;
    }
    this.ws = new this.WebSocketImpl(this.url, { headers: sarvamWsHeaders(this.apiKey) });
    this.ws.on("message", (raw) => this.handleMessage(raw));
    this.ws.on("error", (error) => {
      this.logger?.warn?.(`Sarvam STT WebSocket error: ${error.message}`);
      this.emit("error", error);
    });
    this.ws.on("close", (code, reason) => {
      this.opened = false;
      this.emit("close", { code, reason: reason?.toString?.() || "" });
    });
    await waitForOpen(this.ws);
    this.opened = true;
    return this;
  }

  handleMessage(raw) {
    let message;
    try {
      message = parseJsonMessage(raw);
    } catch (error) {
      this.logger?.warn?.(`Could not parse Sarvam STT message: ${error.message}`);
      return;
    }

    const normalized = normalizeSarvamSttMessage(message);
    if (normalized.type === "error") {
      this.emit("error", normalized.error);
      return;
    }
    this.emit(normalized.type, normalized);
    this.emit("message", normalized);
  }

  sendPcm16(pcm16Buffer) {
    if (!isOpen(this.ws)) return false;
    const data = Buffer.from(pcm16Buffer || []);
    if (!data.length) return false;
    // Sarvam's per-message audio.encoding enum only accepts "audio/wav"; the real
    // codec (pcm_s16le) is declared at connect time via the input_audio_codec query param.
    this.ws.send(
      JSON.stringify({
        audio: {
          data: data.toString("base64"),
          sample_rate: this.sampleRate,
          encoding: "audio/wav"
        }
      })
    );
    return true;
  }

  flush() {
    if (!isOpen(this.ws)) return false;
    this.ws.send(JSON.stringify({ type: "flush" }));
    return true;
  }

  close() {
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) this.ws.close();
  }
}

export async function streamSarvamTextToSpeechMulaw({
  apiKey,
  text,
  languageCode = "en-IN",
  speaker = "shubh",
  model = "bulbul:v3",
  pace = 1,
  temperature = 0.6,
  minBufferSize = 20,
  maxChunkLength = 90,
  logger,
  signal,
  WebSocketImpl = WebSocket,
  onAudio
}) {
  const url = new URL("/text-to-speech/ws", SARVAM_WS_BASE_URL);
  url.searchParams.set("model", model || "bulbul:v3");
  url.searchParams.set("send_completion_event", "true");

  const ws = new WebSocketImpl(url.toString(), { headers: sarvamWsHeaders(apiKey) });
  let settled = false;
  let audioBytes = 0;

  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error("Sarvam TTS WebSocket timed out.")), 20000);
    const abort = () => finish(new Error("Sarvam TTS WebSocket was aborted."));
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener?.("abort", abort);
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
      if (error) reject(error);
      else resolve({ audioBytes });
    };

    signal?.addEventListener?.("abort", abort, { once: true });

    ws.on("open", () => {
      // Only the documented streaming-config fields are accepted; sending extras
      // (temperature, speech_sample_rate, enable_preprocessing) triggers
      // "Input parameters has to be a valid dictionary" and the request is rejected.
      ws.send(
        JSON.stringify({
          type: "config",
          data: {
            target_language_code: languageCode,
            speaker,
            pace,
            output_audio_codec: "mulaw",
            min_buffer_size: minBufferSize,
            max_chunk_length: maxChunkLength
          }
        })
      );
      ws.send(JSON.stringify({ type: "text", data: { text } }));
      ws.send(JSON.stringify({ type: "flush" }));
    });

    ws.on("message", (raw) => {
      let message;
      try {
        message = parseJsonMessage(raw);
      } catch (error) {
        finish(error);
        return;
      }

      if (message.type === "audio") {
        try {
          const audio = Buffer.from(message.data?.audio || "", "base64");
          const mulaw = coerceSarvamAudioToMulaw(audio, message.data?.content_type || "");
          if (mulaw.length) {
            audioBytes += mulaw.length;
            onAudio?.(mulaw, { contentType: message.data?.content_type || "" });
          }
        } catch (error) {
          finish(error);
        }
        return;
      }

      if (message.type === "event" && message.data?.event_type === "final") {
        finish();
        return;
      }

      if (message.type === "error") {
        finish(new Error(message.data?.message || "Sarvam TTS WebSocket error."));
      }
    });

    ws.on("error", (error) => {
      logger?.warn?.(`Sarvam TTS WebSocket error: ${error.message}`);
      finish(error);
    });
    ws.on("close", () => {
      if (!settled) finish();
    });
  });
}
