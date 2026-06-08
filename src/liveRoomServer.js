import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { DemoBrain } from "./brain.js";
import { loadConfig, requireSarvamKey } from "./config.js";
import { loadDemoScript, loadProductKnowledge } from "./demoScript.js";
import { createLogger } from "./logger.js";
import { createAudioFilePath } from "./audioPlayer.js";
import { shouldProcessAudioFile } from "./audioInbox.js";
import { SarvamClient } from "./sarvamClient.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(PROJECT_ROOT, "public", "live-room");
const MAX_AUDIO_BYTES = 12 * 1024 * 1024;
const CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".wav", "audio/wav"],
  [".mp3", "audio/mpeg"],
  [".webm", "audio/webm"]
]);

function detectSarvamTtsLanguageCode(text, fallback = "en-IN") {
  const value = String(text || "");
  if (/[\u0d00-\u0d7f]/u.test(value)) return "ml-IN";
  if (/[\u0900-\u097f]/u.test(value)) return "hi-IN";
  if (/[\u0b80-\u0bff]/u.test(value)) return "ta-IN";
  if (/[\u0c00-\u0c7f]/u.test(value)) return "te-IN";
  if (/[\u0c80-\u0cff]/u.test(value)) return "kn-IN";
  if (/[\u0980-\u09ff]/u.test(value)) return "bn-IN";
  if (/[\u0a80-\u0aff]/u.test(value)) return "gu-IN";
  if (/[\u0a00-\u0a7f]/u.test(value)) return "pa-IN";
  return fallback;
}

function safeJson(value) {
  return JSON.stringify(value);
}

function sendJson(response, status, payload) {
  const body = safeJson(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  response.end(body);
}

function sendText(response, status, text, contentType = "text/plain; charset=utf-8") {
  response.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(text)
  });
  response.end(text);
}

function readBody(request, { limit = MAX_AUDIO_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error(`Request body exceeded ${limit} bytes.`));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

async function readJsonBody(request, { limit = 256 * 1024 } = {}) {
  const body = await readBody(request, { limit });
  if (!body.length) return {};
  return JSON.parse(body.toString("utf8"));
}

function runCommand(command, args, { logger }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      logger.warn(`${command} failed with code ${code}: ${stderr.trim()}`);
      reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

function safeStaticPath(baseDir, urlPath) {
  const normalizedPath = urlPath === "/" ? "/index.html" : urlPath;
  const decoded = decodeURIComponent(normalizedPath);
  const absolutePath = path.resolve(baseDir, `.${decoded}`);
  if (!absolutePath.startsWith(baseDir)) {
    return "";
  }
  return absolutePath;
}

function createLiveRoomServer({
  config = loadConfig(),
  logger = createLogger("live-room"),
  roomName = process.env.LIVE_ROOM_NAME || "RetailDaddy Live Room",
  aiName = process.env.LIVE_AI_NAME || "RetailDaddy AI",
  aiPhone = process.env.LIVE_AI_PHONE || "+91 AI Demo"
} = {}) {
  requireSarvamKey(config);
  config.agent.multilingual = true;
  config.sarvam.sttLanguageCode = "unknown";

  const sarvamClient = new SarvamClient({
    apiKey: config.sarvam.apiKey,
    logger
  });
  const script = loadDemoScript(config.paths.demoScript);
  const productKnowledge = loadProductKnowledge(config.paths.productKnowledge);
  const brain = new DemoBrain({
    sarvamClient,
    config,
    script,
    productKnowledge
  });
  const tmpDir = path.resolve(process.env.LIVE_ROOM_TMP_DIR || path.join(PROJECT_ROOT, ".live-room-tmp"));
  const audioDir = path.resolve(config.paths.audioOutDir);
  const clients = new Map();
  let nextEventId = 1;

  fs.mkdirSync(tmpDir, { recursive: true });
  fs.mkdirSync(audioDir, { recursive: true });

  function pushClientEvent(client, event, payload) {
    const item = {
      id: nextEventId,
      event,
      payload
    };
    nextEventId += 1;
    client.events.push(item);
    if (client.events.length > 200) {
      client.events.splice(0, client.events.length - 200);
    }
    if (client.response) {
      client.response.write(`event: ${event}\ndata: ${safeJson(payload)}\n\n`);
    }
  }

  function broadcast(event, payload) {
    const body = `event: ${event}\ndata: ${safeJson(payload)}\n\n`;
    for (const client of clients.values()) {
      pushClientEvent(client, event, payload);
    }
  }

  function sendTo(clientId, event, payload) {
    const client = clients.get(clientId);
    if (!client) return false;

    pushClientEvent(client, event, payload);
    return true;
  }

  function upsertClient(clientId, { name = "Guest", phone = "", response = null } = {}) {
    const existing = clients.get(clientId);
    if (existing) {
      existing.name = name || existing.name;
      existing.phone = phone || existing.phone;
      existing.response = response || existing.response;
      existing.lastSeenAt = Date.now();
      return existing;
    }

    const client = {
      name,
      phone,
      response,
      events: [],
      joinedAt: Date.now(),
      lastSeenAt: Date.now()
    };
    clients.set(clientId, client);
    return client;
  }

  function pruneInactiveClients(maxIdleMs = 45_000) {
    const now = Date.now();
    for (const [clientId, client] of clients.entries()) {
      if (!client.response && now - client.lastSeenAt > maxIdleMs) {
        clients.delete(clientId);
      }
    }
  }

  function participantList() {
    pruneInactiveClients();
    return [
      {
        id: "ai-agent",
        name: aiName,
        phone: aiPhone,
        isAi: true,
        joinedAt: Date.now()
      },
      ...Array.from(clients.entries()).map(([id, client]) => ({
        id,
        name: client.name,
        phone: client.phone,
        isAi: false,
        joinedAt: client.joinedAt
      }))
    ];
  }

  async function makeAnswer(question) {
    const startedAt = Date.now();
    const answer = await brain.answer(question);
    const speech = await makeSpeech(answer, "live-answer");

    return {
      answer,
      ...speech,
      responseMs: Date.now() - startedAt
    };
  }

  async function makeSpeech(text, label = "live-speech") {
    const audioPath = createAudioFilePath(audioDir, label, "wav");
    const languageCode = detectSarvamTtsLanguageCode(text, "en-IN");
    await sarvamClient.textToSpeechStream(text, audioPath, {
      model: config.sarvam.ttsModel,
      languageCode,
      speaker: config.sarvam.ttsSpeaker,
      pace: config.sarvam.ttsPace
    });

    const mp3Path = audioPath.replace(/\.wav$/i, ".mp3");
    try {
      await runCommand(
        "ffmpeg",
        ["-hide_banner", "-y", "-loglevel", "error", "-i", audioPath, "-codec:a", "libmp3lame", "-q:a", "4", mp3Path],
        { logger }
      );
      return {
        audioUrl: `/audio/${encodeURIComponent(path.basename(mp3Path))}`,
        languageCode
      };
    } catch (error) {
      logger.warn(`Could not transcode TTS audio to MP3; using WAV fallback: ${error.message}`);
    }

    return {
      audioUrl: `/audio/${encodeURIComponent(path.basename(audioPath))}`,
      languageCode
    };
  }

  function agentPresentationPayload(mode = "overview") {
    return {
      mode,
      title: "RetailDaddy Operations Dashboard",
      subtitle: "Live AI-guided product demo",
      focus: mode === "inventory" ? "Inventory health and reorder signals" : "Sales, stock, orders, and exceptions",
      metrics: [
        { label: "Today sales", value: "₹2.84L", trend: "+12%" },
        { label: "Low stock SKUs", value: "18", trend: "Needs action" },
        { label: "Pending orders", value: "42", trend: "7 priority" },
        { label: "Store alerts", value: "6", trend: "Open" }
      ],
      rows: [
        { sku: "RD-1042", item: "Premium Rice 10kg", stock: "12 left", status: "Reorder" },
        { sku: "RD-1188", item: "Groundnut Oil 1L", stock: "86 left", status: "Healthy" },
        { sku: "RD-2250", item: "Detergent Combo", stock: "21 left", status: "Watch" },
        { sku: "RD-3301", item: "Snack Pack", stock: "7 left", status: "Critical" }
      ]
    };
  }

  function welcomeText(name) {
    const firstName = String(name || "there").trim().split(/\s+/)[0] || "there";
    return `Hi ${firstName}, I am RetailDaddy AI Agent. I am live now. You can speak in Malayalam or English, ask doubts, or click AI Demo and I will present the product.`;
  }

  async function speakToRoom(text, { requestId = crypto.randomUUID(), label = "live-speech" } = {}) {
    const startedAt = Date.now();
    const speech = await makeSpeech(text, label);
    const payload = {
      requestId,
      transcript: "",
      answer: text,
      ...speech,
      totalMs: Date.now() - startedAt
    };
    broadcast("agent_answer", payload);
    return payload;
  }

  async function runAgentDemoIntro() {
    broadcast("agent_presenting", agentPresentationPayload("overview"));
    await speakToRoom(
      "I am sharing the RetailDaddy operations dashboard now. First, look at the sales, low stock, pending orders, and alert cards. This is where an owner gets a quick operational view before going into inventory or orders.",
      { label: "demo-intro" }
    );
  }

  async function handleText(request, response) {
    const body = await readJsonBody(request);
    const question = String(body.question || "").trim();
    if (!question) {
      sendJson(response, 400, { error: "question is required" });
      return;
    }

    const requestId = crypto.randomUUID();
    const startedAt = Date.now();
    broadcast("user_transcript", { requestId, transcript: question, source: "text" });
    const result = await makeAnswer(question);
    const payload = {
      requestId,
      transcript: question,
      ...result,
      totalMs: Date.now() - startedAt
    };
    broadcast("agent_answer", payload);
    sendJson(response, 200, payload);
  }

  async function handleAudio(request, response) {
    const requestId = crypto.randomUUID();
    const startedAt = Date.now();
    const inputPath = path.join(tmpDir, `${requestId}.input`);
    const wavPath = path.join(tmpDir, `${requestId}.wav`);
    const audioBuffer = await readBody(request);
    fs.writeFileSync(inputPath, audioBuffer);

    await runCommand(
      "ffmpeg",
      [
        "-hide_banner",
        "-y",
        "-loglevel",
        "error",
        "-i",
        inputPath,
        "-ac",
        "1",
        "-ar",
        "16000",
        wavPath
      ],
      { logger }
    );

    if (
      !shouldProcessAudioFile(wavPath, {
        minBytes: config.audio.minBytes,
        minRms: config.audio.minRms
      })
    ) {
      sendJson(response, 200, {
        requestId,
        ignored: true,
        reason: "silent_or_tiny_audio",
        totalMs: Date.now() - startedAt
      });
      return;
    }

    const transcribedAt = Date.now();
    const stt = await sarvamClient.transcribeFile(wavPath, {
      model: config.sarvam.sttModel,
      mode: config.sarvam.sttMode,
      languageCode: config.sarvam.sttLanguageCode
    });
    const transcript = String(stt.transcript || stt.text || "").trim();
    if (!transcript) {
      sendJson(response, 200, {
        requestId,
        ignored: true,
        reason: "empty_transcript",
        totalMs: Date.now() - startedAt
      });
      return;
    }

    broadcast("user_transcript", { requestId, transcript, source: "microphone" });
    const result = await makeAnswer(transcript);
    const payload = {
      requestId,
      transcript,
      ...result,
      sttMs: Date.now() - transcribedAt,
      totalMs: Date.now() - startedAt
    };
    broadcast("agent_answer", payload);
    sendJson(response, 200, payload);
  }

  async function handleSignal(request, response) {
    const body = await readJsonBody(request);
    const from = String(body.from || "").trim();
    const to = String(body.to || "").trim();
    const type = String(body.type || "").trim();
    if (!from || !type) {
      sendJson(response, 400, { error: "from and type are required" });
      return;
    }

    const payload = {
      from,
      to,
      type,
      data: body.data || null
    };

    if (to) {
      sendTo(to, "signal", payload);
    } else {
      for (const [clientId, client] of clients.entries()) {
        if (clientId !== from) {
          pushClientEvent(client, "signal", payload);
        }
      }
    }

    sendJson(response, 200, { ok: true });
  }

  async function handleDemoStart(_request, response) {
    sendJson(response, 202, { ok: true });
    runAgentDemoIntro().catch((error) => {
      logger.warn(`AI demo intro failed: ${error.message}`);
    });
  }

  async function handleJoin(request, response) {
    const body = await readJsonBody(request);
    const clientId = String(body.clientId || crypto.randomUUID()).trim();
    const name = String(body.name || "Guest").trim().slice(0, 80);
    const phone = String(body.phone || "").trim().slice(0, 40);
    const wasPresent = clients.has(clientId);
    const client = upsertClient(clientId, { name, phone });

    pushClientEvent(client, "room_status", {
      roomName,
      aiName,
      aiPhone,
      clientId,
      participants: participantList()
    });

    if (!wasPresent) {
      broadcast("participant_joined", {
        id: clientId,
        name,
        phone,
        isAi: false,
        joinedAt: client.joinedAt,
        participants: participantList()
      });
      setTimeout(() => {
        broadcast("agent_presenting", agentPresentationPayload("overview"));
        speakToRoom(welcomeText(name), {
          requestId: `welcome-${clientId}`,
          label: "welcome"
        }).catch((error) => {
          logger.warn(`Welcome speech failed: ${error.message}`);
        });
      }, 700);
    }

    sendJson(response, 200, {
      ok: true,
      roomName,
      aiName,
      aiPhone,
      clientId,
      cursor: nextEventId - 1,
      participants: participantList()
    });
  }

  function handlePoll(url, response) {
    const clientId = String(url.searchParams.get("clientId") || "").trim();
    const cursor = Number(url.searchParams.get("cursor") || 0);
    const client = clients.get(clientId);
    if (!client) {
      sendJson(response, 404, { error: "client not joined" });
      return;
    }

    client.lastSeenAt = Date.now();
    const events = client.events.filter((item) => item.id > cursor);
    sendJson(response, 200, {
      cursor: events.length ? events[events.length - 1].id : cursor,
      events
    });
  }

  async function handleLeave(request, response) {
    const body = await readJsonBody(request);
    const clientId = String(body.clientId || "").trim();
    if (clientId) {
      const client = clients.get(clientId);
      if (client?.response) client.response.end();
      clients.delete(clientId);
      broadcast("participant_left", {
        id: clientId,
        participants: participantList()
      });
    }
    sendJson(response, 200, { ok: true });
  }

  function handleEvents(request, response, url) {
    const clientId = String(url.searchParams.get("clientId") || crypto.randomUUID()).trim();
    const name = String(url.searchParams.get("name") || "Guest").trim().slice(0, 80);
    const phone = String(url.searchParams.get("phone") || "").trim().slice(0, 40);

    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive"
    });
    response.flushHeaders?.();
    const client = upsertClient(clientId, {
      response,
      name,
      phone
    });
    response.write(
      `event: room_status\ndata: ${safeJson({
        roomName,
        aiName,
        aiPhone,
        clientId,
      participants: participantList()
      })}\n\n`
    );
    const heartbeat = setInterval(() => {
      response.write(`event: ping\ndata: ${safeJson({ at: Date.now() })}\n\n`);
    }, 15000);
    broadcast("participant_joined", {
      id: clientId,
      name,
      phone,
      isAi: false,
      joinedAt: client.joinedAt,
      participants: participantList()
    });
    request.on("close", () => {
      clearInterval(heartbeat);
      const current = clients.get(clientId);
      if (current) current.response = null;
      broadcast("participant_left", {
        id: clientId,
        participants: participantList()
      });
    });
  }

  function serveAudio(url, response) {
    const fileName = path.basename(decodeURIComponent(url.pathname.replace(/^\/audio\//, "")));
    const audioPath = path.resolve(audioDir, fileName);
    if (!audioPath.startsWith(audioDir) || !fs.existsSync(audioPath)) {
      sendJson(response, 404, { error: "audio not found" });
      return;
    }
    response.writeHead(200, {
      "Content-Type": CONTENT_TYPES.get(path.extname(audioPath).toLowerCase()) || "application/octet-stream"
    });
    fs.createReadStream(audioPath).pipe(response);
  }

  function serveStatic(url, response) {
    const filePath = safeStaticPath(PUBLIC_DIR, url.pathname);
    if (!filePath || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      sendJson(response, 404, { error: "not found" });
      return;
    }
    response.writeHead(200, {
      "Content-Type": CONTENT_TYPES.get(path.extname(filePath).toLowerCase()) || "application/octet-stream"
    });
    fs.createReadStream(filePath).pipe(response);
  }

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, {
          ok: true,
          roomName,
          aiName,
          sttModel: config.sarvam.sttModel,
          ttsModel: config.sarvam.ttsModel
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/events") {
        handleEvents(request, response, url);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/join") {
        await handleJoin(request, response);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/poll") {
        handlePoll(url, response);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/leave") {
        await handleLeave(request, response);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/signal") {
        await handleSignal(request, response);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/demo/start") {
        await handleDemoStart(request, response);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/text") {
        await handleText(request, response);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/audio") {
        await handleAudio(request, response);
        return;
      }
      if (request.method === "GET" && url.pathname.startsWith("/audio/")) {
        serveAudio(url, response);
        return;
      }
      if (request.method === "GET") {
        serveStatic(url, response);
        return;
      }
      sendJson(response, 405, { error: "method not allowed" });
    } catch (error) {
      logger.error(error.stack || error.message);
      sendJson(response, 500, { error: error.message });
    }
  });

  return { server, broadcast };
}

export { createLiveRoomServer, detectSarvamTtsLanguageCode, safeStaticPath };

if (import.meta.url === `file://${process.argv[1]}`) {
  const logger = createLogger("live-room");
  const port = Number(process.env.PORT || process.env.LIVE_ROOM_PORT || 8080);
  const host = process.env.HOST || "0.0.0.0";
  const { server } = createLiveRoomServer({ logger });

  server.listen(port, host, () => {
    logger.info(`RetailDaddy live room listening on http://${host}:${port}`);
    logger.info("Use an HTTPS tunnel for browser mic/camera/screen-share permissions.");
  });
}
