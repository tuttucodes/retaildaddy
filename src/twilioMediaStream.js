import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { detectSarvamTtsLanguageCode } from "./callingAgent.js";
import { SarvamStreamingStt, streamSarvamTextToSpeechMulaw } from "./sarvamStreaming.js";
import {
  chunkBuffer,
  decodeMuLawToPcm16,
  encodePcm16ToMuLaw,
  parsePcm16Wav,
  pcm16Rms,
  writePcm16Wav
} from "./telephonyAudio.js";

const TWILIO_SAMPLE_RATE = 8000;
const TWILIO_MULAW_FRAME_BYTES = 160;

function frameDurationMs(pcm16Buffer) {
  return Math.round((Math.floor(Buffer.byteLength(pcm16Buffer || []) / 2) / TWILIO_SAMPLE_RATE) * 1000);
}

function latestAgentText(session) {
  const items = Array.isArray(session?.transcript) ? session.transcript : [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]?.role === "agent" && items[index]?.text) return String(items[index].text);
  }
  return "";
}

function twilioCallIdFromStartMessage(message, url) {
  const params = message?.start?.customParameters || {};
  return params.callId || params.sessionId || url.searchParams.get("callId") || "";
}

function readTwilioJson(raw) {
  return JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw));
}

function makeTmpWavPath(tmpDir) {
  return path.join(tmpDir, `${crypto.randomUUID()}.twilio-stream.wav`);
}

function wavFileToTwilioMulaw(audioPath) {
  const wav = parsePcm16Wav(fs.readFileSync(audioPath));
  if (wav.sampleRate !== TWILIO_SAMPLE_RATE || wav.channels !== 1) {
    throw new Error(`Expected ${TWILIO_SAMPLE_RATE}Hz mono WAV for Twilio stream, got ${wav.sampleRate}Hz/${wav.channels}ch.`);
  }
  return encodePcm16ToMuLaw(wav.pcm);
}

class TwilioMediaStreamSession {
  constructor({ ws, url, agent, config, logger, tmpDir }) {
    this.ws = ws;
    this.url = url;
    this.agent = agent;
    this.config = config;
    this.logger = logger;
    this.tmpDir = tmpDir;

    this.callId = "";
    this.streamSid = "";
    this.stt = null;
    this.closed = false;
    this.processing = false;
    this.speechActive = false;
    this.speechMs = 0;
    this.silenceMs = 0;
    this.utteranceBuffers = [];
    this.pendingFallbackTimer = null;
    this.playback = null;
    this.markCounter = 0;
  }

  start() {
    this.ws.on("message", (raw) => this.handleMessage(raw).catch((error) => this.fail(error)));
    this.ws.on("close", () => this.cleanup());
    this.ws.on("error", (error) => this.fail(error));
  }

  async handleMessage(raw) {
    const message = readTwilioJson(raw);
    if (message.event === "start") {
      await this.handleStart(message);
      return;
    }
    if (message.event === "media") {
      this.handleMedia(message);
      return;
    }
    if (message.event === "stop") {
      this.cleanup();
    }
  }

  async handleStart(message) {
    this.streamSid = message.streamSid || message.start?.streamSid || "";
    this.callId = twilioCallIdFromStartMessage(message, this.url);
    if (!this.callId) {
      this.logger.warn("Twilio media stream connected without a callId custom parameter.");
      this.close(1008, "missing callId");
      return;
    }

    this.logger.info(`Twilio media stream connected for ${this.callId}.`);
    await this.connectStt().catch((error) => {
      this.logger.warn(`Sarvam streaming STT unavailable for ${this.callId}; using local VAD + REST STT fallback. ${error.message}`);
    });

    const greeting = latestAgentText(this.agent.getSession(this.callId));
    if (greeting) {
      await this.speak(greeting, { label: "greeting" });
    }
  }

  async connectStt() {
    if (!this.config.calling.streamSttEnabled) return;
    this.stt = new SarvamStreamingStt({
      apiKey: this.config.sarvam.apiKey,
      logger: this.logger,
      model: this.config.sarvam.sttModel,
      mode: this.config.sarvam.sttMode,
      languageCode: this.config.sarvam.sttLanguageCode,
      sampleRate: TWILIO_SAMPLE_RATE
    });
    this.stt.on("speech_start", () => {
      if (this.playback) this.interruptPlayback();
    });
    this.stt.on("transcript", (event) => {
      const transcript = String(event.transcript || "").trim();
      if (!transcript) return;
      this.clearPendingFallback();
      this.processTranscript(transcript, "sarvam-stream").catch((error) => this.fail(error));
    });
    this.stt.on("error", (error) => {
      this.logger.warn(`Sarvam STT stream error for ${this.callId || "call"}: ${error.message}`);
      this.stt?.close();
      this.stt = null;
    });
    await this.stt.connect();
  }

  handleMedia(message) {
    if (this.closed || !message.media?.payload) return;
    const muLaw = Buffer.from(message.media.payload, "base64");
    const pcm16 = decodeMuLawToPcm16(muLaw);
    this.stt?.sendPcm16(pcm16);

    const rms = pcm16Rms(pcm16);
    const durationMs = Math.max(1, frameDurationMs(pcm16));
    if (rms >= this.config.calling.streamVadRms) {
      if (this.playback) this.interruptPlayback();
      if (!this.speechActive) {
        this.speechActive = true;
        this.speechMs = 0;
        this.silenceMs = 0;
        this.utteranceBuffers = [];
      }
      this.speechMs += durationMs;
      this.silenceMs = 0;
      this.utteranceBuffers.push(pcm16);
      if (this.speechMs >= this.config.calling.streamMaxSpeechMs) {
        this.finalizeLocalUtterance();
      }
      return;
    }

    if (!this.speechActive) return;
    this.silenceMs += durationMs;
    this.utteranceBuffers.push(pcm16);
    if (
      this.speechMs >= this.config.calling.streamMinSpeechMs &&
      this.silenceMs >= this.config.calling.streamSilenceMs
    ) {
      this.finalizeLocalUtterance();
    }
  }

  finalizeLocalUtterance() {
    if (!this.speechActive) return;
    const speechMs = this.speechMs;
    const pcm16 = Buffer.concat(this.utteranceBuffers);
    this.speechActive = false;
    this.speechMs = 0;
    this.silenceMs = 0;
    this.utteranceBuffers = [];

    if (speechMs < this.config.calling.streamMinSpeechMs || this.processing) return;
    this.stt?.flush();
    this.clearPendingFallback();
    this.pendingFallbackTimer = setTimeout(() => {
      this.processPcmFallback(pcm16).catch((error) => this.fail(error));
    }, this.config.calling.streamFallbackTranscriptMs);
  }

  async processPcmFallback(pcm16) {
    this.clearPendingFallback();
    if (this.processing || this.closed) return;
    this.processing = true;
    try {
      const wavPath = makeTmpWavPath(this.tmpDir);
      writePcm16Wav(wavPath, pcm16, { sampleRate: TWILIO_SAMPLE_RATE, channels: 1 });
      const result = await this.agent.handleAudioFile(this.callId, wavPath, { synthesize: false });
      if (result?.ignored) return;
      await this.speakAnswer(result.answer);
    } finally {
      this.processing = false;
    }
  }

  async processTranscript(transcript, source) {
    if (this.processing || this.closed) return;
    this.processing = true;
    try {
      this.logger.info(`Caller ${this.callId}: ${transcript}`);
      const result = await this.agent.handleText(this.callId, transcript, { source, synthesize: false });
      await this.speakAnswer(result.answer);
    } finally {
      this.processing = false;
    }
  }

  async speakAnswer(answer) {
    const text = String(answer || "").trim();
    if (!text || this.closed) return;
    await this.speak(text, { label: "answer" });
  }

  async speak(text, { label = "agent" } = {}) {
    if (!text || !this.streamSid || this.closed) return;
    const playback = {
      controller: new AbortController(),
      interrupted: false
    };
    this.playback = playback;
    this.processing = true;
    try {
      const languageCode = detectSarvamTtsLanguageCode(text, "en-IN");
      if (this.config.calling.streamTtsEnabled) {
        await streamSarvamTextToSpeechMulaw({
          apiKey: this.config.sarvam.apiKey,
          text,
          languageCode,
          speaker: this.config.calling.ttsSpeaker || this.config.sarvam.ttsSpeaker,
          model: this.config.sarvam.ttsModel,
          pace: this.config.calling.ttsPace ?? this.config.sarvam.ttsPace,
          minBufferSize: this.config.calling.streamTtsMinBufferSize,
          maxChunkLength: this.config.calling.streamTtsMaxChunkLength,
          logger: this.logger,
          signal: playback.controller.signal,
          onAudio: (muLaw) => this.sendMedia(muLaw)
        });
      } else {
        await this.speakViaRestTts(text, label);
      }
    } catch (error) {
      if (playback.interrupted) return;
      this.logger.warn(`Sarvam streaming TTS failed for ${this.callId}; falling back to REST TTS. ${error.message}`);
      await this.speakViaRestTts(text, label);
    } finally {
      if (!playback.interrupted) this.sendMark(`${label}-${++this.markCounter}`);
      if (this.playback === playback) this.playback = null;
      this.processing = false;
    }
  }

  async speakViaRestTts(text, label) {
    const session = this.agent.getSession(this.callId);
    const speech = await this.agent.synthesize(session, text, `twilio-stream-${label}`);
    const muLaw = wavFileToTwilioMulaw(speech.audioPath);
    this.sendMedia(muLaw);
  }

  sendMedia(muLawBuffer) {
    if (this.closed || !this.streamSid || this.ws.readyState !== WebSocket.OPEN) return;
    for (const chunk of chunkBuffer(muLawBuffer, TWILIO_MULAW_FRAME_BYTES)) {
      this.send({
        event: "media",
        streamSid: this.streamSid,
        media: {
          payload: chunk.toString("base64")
        }
      });
    }
  }

  sendMark(name) {
    if (!this.streamSid) return;
    this.send({
      event: "mark",
      streamSid: this.streamSid,
      mark: { name }
    });
  }

  interruptPlayback() {
    if (!this.playback || this.closed) return;
    this.playback.interrupted = true;
    this.playback.controller.abort();
    this.send({
      event: "clear",
      streamSid: this.streamSid
    });
    this.playback = null;
    this.processing = false;
    this.clearPendingFallback();
  }

  clearPendingFallback() {
    if (this.pendingFallbackTimer) {
      clearTimeout(this.pendingFallbackTimer);
      this.pendingFallbackTimer = null;
    }
  }

  send(payload) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  fail(error) {
    this.logger.warn(`Twilio media stream error for ${this.callId || "call"}: ${error.message}`);
  }

  close(code = 1000, reason = "done") {
    this.closed = true;
    this.clearPendingFallback();
    this.stt?.close();
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close(code, reason);
    }
  }

  cleanup() {
    this.closed = true;
    this.clearPendingFallback();
    this.playback?.controller.abort();
    this.stt?.close();
    this.playback = null;
    this.stt = null;
  }
}

export function attachTwilioMediaStreamServer({ server, agent, config, logger, tmpDir }) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    if (url.pathname !== "/twilio/media") {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      const session = new TwilioMediaStreamSession({ ws, url, agent, config, logger, tmpDir });
      session.start();
      wss.emit("connection", ws, request, session);
    });
  });

  return wss;
}
