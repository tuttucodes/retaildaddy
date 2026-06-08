import fs from "node:fs";
import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CallingAgent } from "./callingAgent.js";
import { loadConfig, requireSarvamKey } from "./config.js";
import { loadDemoScript, loadProductKnowledge } from "./demoScript.js";
import { createLogger } from "./logger.js";
import { SarvamClient } from "./sarvamClient.js";
import { shouldProcessAudioFile } from "./audioInbox.js";
import { attachTwilioMediaStreamServer } from "./twilioMediaStream.js";
import {
  absolutePublicUrl,
  connectStreamTwiml,
  createTwilioOutboundCall,
  fetchTwilioRecording,
  playAndDialTwiml,
  playAndHangupTwiml,
  playAndRecordTwiml,
  publicWebSocketUrl,
  recordOnlyTwiml
} from "./twilioTelephony.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(PROJECT_ROOT, "public", "calling-agent");
const MAX_AUDIO_BYTES = 12 * 1024 * 1024;

const CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".wav", "audio/wav"],
  [".mp3", "audio/mpeg"],
  [".webm", "audio/webm"]
]);

function isInside(baseDir, filePath) {
  const relative = path.relative(baseDir, filePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  response.end(body);
}

function sendXml(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "text/xml; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  response.end(body);
}

function elapsedMs(startedAt) {
  return Date.now() - startedAt;
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

async function readJsonBody(request) {
  const body = await readBody(request, { limit: 256 * 1024 });
  if (!body.length) return {};
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw Object.assign(new Error("Invalid JSON body"), { status: 400 });
  }
}

async function readFormBody(request) {
  const body = await readBody(request, { limit: 256 * 1024 });
  return Object.fromEntries(new URLSearchParams(body.toString("utf8")));
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

function audioExtension(contentType = "") {
  const value = contentType.toLowerCase();
  if (value.includes("wav")) return ".wav";
  if (value.includes("mpeg") || value.includes("mp3")) return ".mp3";
  if (value.includes("webm")) return ".webm";
  if (value.includes("ogg")) return ".ogg";
  return ".input";
}

async function normalizeAudio(inputPath, wavPath, { logger }) {
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
  return wavPath;
}

function safeStaticPath(baseDir, urlPath) {
  const normalizedPath = urlPath === "/" ? "/index.html" : urlPath;
  const decoded = decodeURIComponent(normalizedPath);
  const absolutePath = path.resolve(baseDir, `.${decoded}`);
  if (!isInside(baseDir, absolutePath)) return "";
  return absolutePath;
}

export function createCallingAgentServer({
  config = loadConfig(),
  logger = createLogger("calling-agent")
} = {}) {
  requireSarvamKey(config);

  const script = loadDemoScript(config.paths.demoScript);
  const productKnowledge = loadProductKnowledge(config.paths.productKnowledge);
  const sarvamClient = new SarvamClient({
    apiKey: config.sarvam.apiKey,
    logger
  });
  const agent = new CallingAgent({
    sarvamClient,
    config,
    script,
    productKnowledge,
    logger
  });
  const tmpDir = path.resolve(process.env.CALL_AGENT_TMP_DIR || path.join(PROJECT_ROOT, ".call-agent-tmp"));
  const audioDir = path.resolve(config.paths.audioOutDir);

  fs.mkdirSync(tmpDir, { recursive: true });
  fs.mkdirSync(audioDir, { recursive: true });

  const twilioConfig = {
    accountSid: process.env.TWILIO_ACCOUNT_SID || "",
    authToken: process.env.TWILIO_AUTH_TOKEN || "",
    apiKeySid: process.env.TWILIO_API_KEY_SID || "",
    apiKeySecret: process.env.TWILIO_API_KEY_SECRET || "",
    from: process.env.TWILIO_FROM_NUMBER || ""
  };

  function twilioActionUrl(callId) {
    return absolutePublicUrl(config.calling.publicBaseUrl, `/twilio/recording?callId=${encodeURIComponent(callId)}`);
  }

  function twilioVoiceUrl(callId) {
    return absolutePublicUrl(config.calling.publicBaseUrl, `/twilio/voice?callId=${encodeURIComponent(callId)}`);
  }

  function twilioStatusUrl(callId) {
    return absolutePublicUrl(config.calling.publicBaseUrl, `/twilio/status?callId=${encodeURIComponent(callId)}`);
  }

  function twilioMediaStreamUrl() {
    return publicWebSocketUrl(config.calling.publicBaseUrl, "/twilio/media");
  }

  function sendTwilioStream(response, session) {
    sendXml(
      response,
      200,
      connectStreamTwiml({
        streamUrl: twilioMediaStreamUrl(),
        statusCallbackUrl: twilioStatusUrl(session.id),
        parameters: {
          callId: session.id,
          transport: "stream"
        }
      })
    );
  }

  function sendTwilioNextTurn(response, session) {
    const audioUrl = absolutePublicUrl(config.calling.publicBaseUrl, session.lastAudioUrl || "/audio/missing.wav");
    if (session.transferRequested && config.calling.transferPhone) {
      sendXml(response, 200, playAndDialTwiml({ audioUrl, transferPhone: config.calling.transferPhone }));
      return;
    }
    if (session.status === "ended") {
      sendXml(response, 200, playAndHangupTwiml({ audioUrl }));
      return;
    }
    sendXml(
      response,
      200,
      playAndRecordTwiml({
        audioUrl,
        actionUrl: twilioActionUrl(session.id),
        maxLength: config.calling.recordMaxLength,
        timeout: config.calling.recordTimeout
      })
    );
  }

  function sendTwilioListenOnly(response, session) {
    sendXml(
      response,
      200,
      recordOnlyTwiml({
        actionUrl: twilioActionUrl(session.id),
        maxLength: config.calling.recordMaxLength,
        timeout: config.calling.recordTimeout
      })
    );
  }

  function serveAudio(url, response) {
    const fileName = path.basename(decodeURIComponent(url.pathname.replace(/^\/audio\//, "")));
    const audioPath = path.resolve(audioDir, fileName);
    if (!isInside(audioDir, audioPath) || !fs.existsSync(audioPath)) {
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
      "Content-Type": CONTENT_TYPES.get(path.extname(filePath).toLowerCase()) || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    fs.createReadStream(filePath).pipe(response);
  }

  async function handleAudioTurn(request, response, callId) {
    const requestId = crypto.randomUUID();
    const inputPath = path.join(tmpDir, `${requestId}${audioExtension(request.headers["content-type"] || "")}`);
    const wavPath = path.join(tmpDir, `${requestId}.wav`);
    fs.writeFileSync(inputPath, await readBody(request));
    await normalizeAudio(inputPath, wavPath, { logger });

    if (
      !shouldProcessAudioFile(wavPath, {
        minBytes: config.audio.minBytes,
        minRms: config.audio.minRms
      })
    ) {
      sendJson(response, 200, { ignored: true, reason: "silent_or_tiny_audio" });
      return;
    }

    const result = await agent.handleAudioFile(callId, wavPath);
    sendJson(response, 200, result);
  }

  async function handleTwilioRecording(request, response, callId) {
    const turnStartedAt = Date.now();
    const form = await readFormBody(request);
    const recordingUrl = form.RecordingUrl || form.recordingUrl || "";
    const session = agent.getSession(callId);
    logger.info(
      `Twilio recording callback for ${callId}: duration=${form.RecordingDuration || "?"}s status=${form.RecordingStatus || "?"}.`
    );

    if (!recordingUrl) {
      sendTwilioListenOnly(response, session);
      return;
    }

    const requestId = crypto.randomUUID();
    const inputPath = path.join(tmpDir, `${requestId}.twilio.wav`);
    const fetchStartedAt = Date.now();
    fs.writeFileSync(
      inputPath,
      await fetchTwilioRecording({
        recordingUrl,
        accountSid: twilioConfig.accountSid,
        authToken: twilioConfig.authToken
      })
    );
    logger.info(`Fetched Twilio recording for ${callId} in ${elapsedMs(fetchStartedAt)}ms.`);

    if (
      !shouldProcessAudioFile(inputPath, {
        minBytes: config.audio.minBytes,
        minRms: config.audio.minRms
      })
    ) {
      sendTwilioListenOnly(response, session);
      logger.info(`Skipped silent/tiny Twilio recording for ${callId} after ${elapsedMs(turnStartedAt)}ms.`);
      return;
    }

    const agentStartedAt = Date.now();
    const result = await agent.handleAudioFile(callId, inputPath);
    logger.info(`Generated agent turn for ${callId} in ${elapsedMs(agentStartedAt)}ms.`);
    sendTwilioNextTurn(response, agent.getSession(result.session.id));
    logger.info(`Completed Twilio turn for ${callId} in ${elapsedMs(turnStartedAt)}ms.`);
  }

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, {
          ok: true,
          agentName: config.calling.agentName,
          sttModel: config.sarvam.sttModel,
          ttsModel: config.sarvam.ttsModel,
          chatModel: config.sarvam.chatModel,
          callChatModel: config.calling.chatModel,
          callTransport: config.calling.transport,
          callRecordTimeout: config.calling.recordTimeout,
          callRecordMaxLength: config.calling.recordMaxLength,
          callStreamSttEnabled: config.calling.streamSttEnabled,
          callStreamTtsEnabled: config.calling.streamTtsEnabled,
          callTtsSampleRate: config.calling.ttsSampleRate,
          callPersonaName: config.calling.personaName
        });
        return;
      }

      if (request.method === "GET" && url.pathname.startsWith("/audio/")) {
        serveAudio(url, response);
        return;
      }

      if (request.method === "POST" && url.pathname === "/twilio/voice") {
        const callId = url.searchParams.get("callId") || "";
        let session;
        try {
          if (!callId) throw new Error("no callId");
          session = agent.getSession(callId);
        } catch {
          // Inbound call: Twilio posts with no callId query param.
          // Parse the form body and create a fresh inbound session.
          const form = await readFormBody(request);
          const started = await agent.startCall({
            callerPhone: String(form.From || "").trim(),
            callerName: "",
            direction: "inbound",
            metadata: { twilioCallSid: form.CallSid || "" }
          });
          session = agent.getSession(started.session.id);
          logger.info(`Inbound Twilio call: callSid=${form.CallSid || "?"} from=${form.From || "?"} sessionId=${session.id}`);
        }
        if (config.calling.transport === "stream") sendTwilioStream(response, session);
        else sendTwilioNextTurn(response, session);
        return;
      }

      if (request.method === "POST" && url.pathname === "/twilio/recording") {
        const callId = url.searchParams.get("callId") || "";
        await handleTwilioRecording(request, response, callId);
        return;
      }

      if (request.method === "POST" && url.pathname === "/twilio/status") {
        const callId = url.searchParams.get("callId") || "";
        const form = await readFormBody(request);
        if (callId && form.CallStatus === "completed") {
          await agent.endCall(callId).catch(() => {});
        }
        sendXml(response, 200, "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response/>");
        return;
      }

      if (request.method === "GET" && !url.pathname.startsWith("/api/")) {
        serveStatic(url, response);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/calls") {
        sendJson(response, 200, { calls: agent.listSessions() });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/calls") {
        const body = await readJsonBody(request);
        const result = await agent.startCall({
          callerName: String(body.callerName || "").trim(),
          callerPhone: String(body.callerPhone || "").trim(),
          direction: String(body.direction || "inbound").trim() || "inbound",
          metadata: body.metadata || {}
        });
        sendJson(response, 201, result);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/outbound-call") {
        const body = await readJsonBody(request);
        const to = String(body.to || body.callerPhone || "").trim();
        if (!to) {
          sendJson(response, 400, { error: "to is required in E.164 format, for example +919999999999" });
          return;
        }
        if (config.calling.provider !== "twilio") {
          sendJson(response, 400, { error: `Unsupported CALL_PROVIDER "${config.calling.provider}". Use twilio.` });
          return;
        }
        if (!config.calling.publicBaseUrl) {
          sendJson(response, 400, { error: "CALL_PUBLIC_BASE_URL is required so Twilio can reach /twilio callbacks." });
          return;
        }

        const started = await agent.startCall({
          callerName: String(body.callerName || "").trim(),
          callerPhone: to,
          direction: "outbound",
          metadata: body.metadata || {}
        });
        const call = await createTwilioOutboundCall({
          ...twilioConfig,
          to,
          webhookUrl: twilioVoiceUrl(started.session.id),
          statusCallbackUrl: twilioStatusUrl(started.session.id)
        });
        const session = agent.getSession(started.session.id);
        session.metadata.twilioCallSid = call.sid;
        session.updatedAt = new Date().toISOString();
        sendJson(response, 201, {
          ...started,
          session: agent.getPublicSession(started.session.id),
          provider: "twilio",
          callSid: call.sid,
          status: call.status || "queued"
        });
        return;
      }

      const callMatch = url.pathname.match(/^\/api\/calls\/([^/]+)(?:\/([^/]+))?$/);
      if (callMatch) {
        const callId = decodeURIComponent(callMatch[1]);
        const action = callMatch[2] || "";

        if (request.method === "GET" && !action) {
          sendJson(response, 200, { session: agent.getPublicSession(callId) });
          return;
        }

        if (request.method === "POST" && action === "text") {
          const body = await readJsonBody(request);
          const result = await agent.handleText(callId, String(body.text || ""));
          sendJson(response, 200, result);
          return;
        }

        if (request.method === "POST" && action === "audio") {
          await handleAudioTurn(request, response, callId);
          return;
        }

        if (request.method === "POST" && action === "summary") {
          const result = await agent.summarize(callId);
          sendJson(response, 200, result);
          return;
        }

        if (request.method === "POST" && action === "end") {
          sendJson(response, 200, { session: await agent.endCall(callId) });
          return;
        }
      }

      sendJson(response, 404, { error: "not found" });
    } catch (error) {
      logger.error(error.stack || error.message);
      sendJson(response, error.status || 500, { error: error.message });
    }
  });

  server.agent = agent;
  if (config.calling.transport === "stream") {
    server.twilioMediaStreams = attachTwilioMediaStreamServer({ server, agent, config, logger, tmpDir });
  }
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const logger = createLogger("calling-agent");
  createCallingAgentServer({ config, logger }).listen(config.calling.port, config.calling.host, () => {
    logger.info(`RetailDaddy calling agent on http://${config.calling.host}:${config.calling.port}`);
  });
}
