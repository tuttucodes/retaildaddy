import crypto from "node:crypto";
import path from "node:path";
import { createAudioFilePath } from "./audioPlayer.js";
import { buildPersonaPrompt } from "./persona/asha.js";
import { createMeetEvent as defaultCreateMeetEvent } from "./booking/calendarLink.js";
import { normalizeSpokenEmail } from "./booking/emailCapture.js";

const TRANSFER_RE = /\b(human|person|agent|manager|transfer|call me|callback|representative)\b/i;
const DEMO_RE = /\b(demo|meeting|schedule|appointment|book|trial|walkthrough|show)\b|ഡെമോ|കാണിക്ക|ശോ/u;
const PRICING_RE = /\b(price|pricing|cost|plan|subscription|quote|charges)\b/i;
const SCHEDULE_RE = /\b(schedule|book|appointment|meeting|call back|callback|tomorrow|today)\b|ഷെഡ്യൂൾ|ബുക്ക്/u;
const GREETING_TOKENS = new Set([
  "hello",
  "helo",
  "hi",
  "hey",
  "hai",
  "ഹലോ",
  "ഹായ്",
  "നമസ്കാരം",
  "വണക്കം",
  "வணக்கம்",
  "హలో",
  "నమస్తే",
  "नमस्ते",
  "नमस्कार"
]);

export function detectSarvamTtsLanguageCode(text, fallback = "en-IN") {
  const value = String(text || "");
  if (/[\u0d00-\u0d7f]/u.test(value)) return "ml-IN";
  if (/[\u0900-\u097f]/u.test(value)) return "hi-IN";
  if (/[\u0b00-\u0b7f]/u.test(value)) return "od-IN";
  if (/[\u0b80-\u0bff]/u.test(value)) return "ta-IN";
  if (/[\u0c00-\u0c7f]/u.test(value)) return "te-IN";
  if (/[\u0c80-\u0cff]/u.test(value)) return "kn-IN";
  if (/[\u0980-\u09ff]/u.test(value)) return "bn-IN";
  if (/[\u0a80-\u0aff]/u.test(value)) return "gu-IN";
  if (/[\u0a00-\u0a7f]/u.test(value)) return "pa-IN";
  if (/[\u0600-\u06ff]/u.test(value)) return "ur-IN";
  return fallback;
}

function firstName(session) {
  return String(session.callerName || "there").trim().split(/\s+/)[0] || "there";
}

function normalizeSpeechText(text) {
  return String(text || "")
    .toLocaleLowerCase("en-IN")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isGreetingOnly(text) {
  const tokens = normalizeSpeechText(text).split(" ").filter(Boolean);
  return Boolean(tokens.length) && tokens.length <= 4 && tokens.every((token) => GREETING_TOKENS.has(token));
}

function hasMalayalam(text) {
  return /[\u0d00-\u0d7f]/u.test(String(text || ""));
}

export function buildCallingAgentSystemPrompt(params) {
  return buildPersonaPrompt({
    agentName: params.agentName,
    personaName: params.personaName || "Asha",
    discloseAi: params.discloseAi ?? false,
    multilingual: params.multilingual ?? true,
    productKnowledge: params.productKnowledge,
    script: params.script,
    goal: params.goal || "qualify the caller, gauge RetailDaddy interest, and move an interested caller toward a live demo."
  });
}

function publicSession(session) {
  return {
    id: session.id,
    direction: session.direction,
    callerName: session.callerName,
    callerPhone: session.callerPhone,
    status: session.status,
    languageCode: session.languageCode,
    transferRequested: session.transferRequested,
    interest: session.interest,
    nextAction: session.nextAction,
    lastAudioUrl: session.lastAudioUrl,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    transcript: session.transcript,
    summary: session.summary
  };
}

export class CallingAgent {
  constructor({ sarvamClient, config, script, productKnowledge, logger, createMeetEvent } = {}) {
    this.sarvamClient = sarvamClient;
    this.config = config;
    this.script = script;
    this.productKnowledge = productKnowledge;
    this.logger = logger;
    this.sessions = new Map();
    this.audioOutDir = config.paths.audioOutDir;
    this.createMeetEvent = createMeetEvent || defaultCreateMeetEvent;
    this.systemPrompt = buildCallingAgentSystemPrompt({
      agentName: config.calling?.agentName || config.agent.name || "RetailDaddy AI Calling Agent",
      personaName: config.calling?.personaName || "Asha",
      discloseAi: config.agent.discloseAi,
      multilingual: config.calling?.multilingual ?? true,
      goal: config.calling?.goal,
      productKnowledge,
      script
    });
  }

  createSession({ callerName = "", callerPhone = "", direction = "inbound", metadata = {} } = {}) {
    const now = new Date().toISOString();
    const session = {
      id: crypto.randomUUID(),
      direction,
      callerName,
      callerPhone,
      metadata,
      status: "active",
      languageCode: "unknown",
      transferRequested: false,
      interest: "",
      nextAction: "",
      summary: "",
      lastAudioUrl: "",
      createdAt: now,
      updatedAt: now,
      transcript: [],
      messages: [{ role: "system", content: this.systemPrompt }]
    };
    this.sessions.set(session.id, session);
    return session;
  }

  getSession(callId) {
    const session = this.sessions.get(callId);
    if (!session) throw new Error(`Call session not found: ${callId}`);
    return session;
  }

  getPublicSession(callId) {
    return publicSession(this.getSession(callId));
  }

  listSessions() {
    return Array.from(this.sessions.values()).map(publicSession);
  }

  async startCall(input = {}) {
    const session = this.createSession(input);
    const name = firstName(session);
    const personaName = this.config.calling?.personaName || "Asha";
    const greeting =
      session.direction === "outbound"
        ? `Hi ${name}, it's ${personaName} from RetailDaddy. I saw you were checking us out — got a minute? I'd love to quickly show you what RetailDaddy can do.`
        : `Hi ${name}, ${personaName} here from RetailDaddy. How can I help you today?`;

    session.messages.push({ role: "assistant", content: greeting });
    session.transcript.push({ role: "agent", text: greeting, at: new Date().toISOString() });
    const speech = await this.synthesize(session, greeting, "call-greeting");
    return { session: publicSession(session), answer: greeting, ...speech };
  }

  async handleAudioFile(callId, audioPath, options = {}) {
    const session = this.getSession(callId);
    const { synthesize = true, ...sttOptions } = options;
    const stt = await this.sarvamClient.transcribeFile(audioPath, {
      model: this.config.sarvam.sttModel,
      mode: this.config.sarvam.sttMode,
      languageCode: this.config.sarvam.sttLanguageCode,
      ...sttOptions
    });
    const transcript = String(stt.transcript || stt.text || "").trim();
    if (!transcript) {
      return {
        session: publicSession(session),
        ignored: true,
        reason: "empty_transcript"
      };
    }
    session.languageCode = stt.language_code || stt.languageCode || session.languageCode;
    return this.handleText(callId, transcript, { source: "audio", synthesize });
  }

  async handleText(callId, text, { source = "text", synthesize = true } = {}) {
    const session = this.getSession(callId);
    const transcript = String(text || "").trim();
    if (!transcript) throw new Error("text is required");

    this.updateCallState(session, transcript);
    await this.maybeBookDemo(session, transcript);
    session.transcript.push({
      role: "caller",
      source,
      text: transcript,
      at: new Date().toISOString()
    });
    session.messages.push({ role: "user", content: transcript });

    const fastAnswer = this.fastReplyFor(session, transcript);
    const answer =
      fastAnswer ||
      (await this.sarvamClient.chat(session.messages, {
        model: this.config.calling?.chatModel || this.config.sarvam.chatModel,
        temperature: this.config.calling?.chatTemperature ?? 0.42,
        maxTokens: this.config.calling?.chatMaxTokens ?? 95
      }));
    const finalAnswer = answer || "I do not have enough context to answer that accurately. I will ask the team to confirm this after the call.";

    session.messages.push({ role: "assistant", content: finalAnswer });
    session.messages = [session.messages[0], ...session.messages.slice(-12)];
    session.transcript.push({
      role: "agent",
      text: finalAnswer,
      at: new Date().toISOString()
    });
    session.updatedAt = new Date().toISOString();

    const speech = synthesize ? await this.synthesize(session, finalAnswer, "call-answer") : {};
    return {
      session: publicSession(session),
      transcript,
      answer: finalAnswer,
      ...speech
    };
  }

  async summarize(callId) {
    const session = this.getSession(callId);
    const transcript = session.transcript
      .map((item) => `${item.role === "caller" ? "Caller" : "Agent"}: ${item.text}`)
      .join("\n");

    const summary = await this.sarvamClient.chat(
      [
        {
          role: "system",
          content: "Summarize a RetailDaddy call for CRM handoff. Be concise and include intent, need, objections, next action, and transfer request."
        },
        { role: "user", content: transcript || "No transcript." }
      ],
      {
        model: this.config.sarvam.chatModel,
        temperature: 0.2,
        maxTokens: 260
      }
    );

    session.summary = summary || "No useful call summary could be generated.";
    session.status = "summarized";
    session.updatedAt = new Date().toISOString();
    return { session: publicSession(session), summary: session.summary };
  }

  async endCall(callId) {
    const session = this.getSession(callId);
    session.status = "ended";
    session.updatedAt = new Date().toISOString();
    return publicSession(session);
  }

  async synthesize(session, text, label) {
    const audioPath = createAudioFilePath(this.audioOutDir, `${label}-${session.id.slice(0, 8)}`, "wav");
    const languageFallback =
      this.config.calling?.multilingual ?? true
        ? "en-IN"
        : this.config.sarvam.ttsLanguageCode || "en-IN";
    const languageCode = detectSarvamTtsLanguageCode(text, languageFallback);
    await this.sarvamClient.textToSpeechStream(text, audioPath, {
      model: this.config.sarvam.ttsModel,
      languageCode,
      speaker: this.config.calling?.ttsSpeaker || this.config.sarvam.ttsSpeaker,
      pace: this.config.calling?.ttsPace ?? this.config.sarvam.ttsPace,
      sampleRate: this.config.calling?.ttsSampleRate || this.config.sarvam.ttsSampleRate
    });
    const audioUrl = `/audio/${encodeURIComponent(path.basename(audioPath))}`;
    session.lastAudioUrl = audioUrl;
    return {
      audioPath,
      audioUrl,
      languageCode
    };
  }

  async maybeBookDemo(session, transcript) {
    if (!this.config.booking?.emailLink) return;
    if (session.demo?.meetUrl) return;
    if (session.nextAction !== "schedule_demo" && session.interest !== "demo") return;

    // Strip common spoken preambles ("my email is", "it is", "email address is", etc.)
    // so that normalizeSpokenEmail receives only the email portion.
    const stripped = transcript.replace(/^.*?\b(?:email\s+(?:address\s+)?is|email\s+id\s+is|address\s+is|it\s+is|is)\s+/i, "");
    const email = normalizeSpokenEmail(stripped) || normalizeSpokenEmail(transcript);
    if (!email) return;

    try {
      const startIso = new Date(Date.now() + 2 * 60_000).toISOString();
      const result = await this.createMeetEvent({
        booking: this.config.booking,
        summary: `RetailDaddy demo with ${firstName(session)}`,
        attendeeEmail: email,
        startIso,
        durationMinutes: 30,
        logger: this.logger
      });
      session.demo = { email, ...result };
      session.nextAction = "demo_booked";
      this.logger.info(`Demo booked for ${email}: ${result.meetUrl}`);
    } catch (error) {
      this.logger.error(`Demo booking failed for ${email}: ${error.message}`);
      session.demo = { email, error: error.message };
      session.nextAction = "demo_booking_failed";
    }
  }

  updateCallState(session, text) {
    if (TRANSFER_RE.test(text)) {
      session.transferRequested = true;
      session.nextAction = "human_follow_up";
    }
    if (DEMO_RE.test(text)) {
      session.interest = "demo";
      session.nextAction = session.nextAction || "schedule_demo";
    }
    if (PRICING_RE.test(text)) {
      session.interest = session.interest || "pricing";
      session.nextAction = session.nextAction || "send_pricing_context";
    }
  }

  fastReplyFor(session, text) {
    const name = firstName(session);
    if (isGreetingOnly(text)) {
      return hasMalayalam(text)
        ? `ഞാൻ ഇവിടെ തന്നെ ഉണ്ട്, ${name}. RetailDaddyയെ കുറിച്ച് എന്താണ് അറിയേണ്ടത്?`
        : `I'm here, ${name}. Tell me what you want to check about RetailDaddy.`;
    }

    if (SCHEDULE_RE.test(text) && !PRICING_RE.test(text)) {
      session.interest = "demo";
      session.nextAction = "schedule_demo";
      return hasMalayalam(text)
        ? "Sure, demo call schedule ചെയ്യാം. നാളെ ഏത് സമയം നിങ്ങൾക്ക് സൗകര്യം?"
        : "Sure, I can line up a proper demo call. What time works best for you tomorrow?";
    }

    return "";
  }
}
