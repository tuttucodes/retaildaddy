# Dual Human-Grade AI Agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship two independent, production-grade AI agents — a human-sounding outbound Voice Call Agent and a Google Meet Demo Agent — that share a persona/voice library but run standalone, each with always-on barge-in listening and a full external-failure fallback chain.

**Architecture:** Two decoupled Node processes. Box 1 (call agent) already serves Twilio Media Streams with barge-in; we make it fully human (no AI disclosure), interest-led, female-voiced, and add an optional email-the-Meet-link path. Box 2 (meet agent, the `DemoOrchestrator`) joins a Meet link, screenshares the POS demo, and gains real barge-in (abort in-flight TTS the instant the human speaks) plus a human intro. A shared persona module is the single source of the system prompt; a generic retry helper and extended preflight harden both.

**Tech Stack:** Node 20 ESM, `node --test`, Playwright, Twilio Media Streams, Sarvam STT/TTS/chat, `googleapis` (Calendar/Gmail, OAuth offline refresh token).

---

## File Structure

| File | Responsibility | New/Modify |
|---|---|---|
| `src/persona/asha.js` | Single human-persona system-prompt builder used by both boxes | Create |
| `src/util/retry.js` | Generic async retry w/ backoff for non-Sarvam external calls (Calendar/Gmail/Meet) | Create |
| `src/booking/emailCapture.js` | Normalize + confirm a spoken email address | Create |
| `src/booking/calendarLink.js` | Create a Google Meet event via dedicated agent account, return `{meetUrl, eventId, startTime}` | Create |
| `src/booking/googleAuth.js` | Build an authorized Google OAuth2 client from env refresh token | Create |
| `scripts/authGoogle.js` | One-time CLI to mint the agent account's offline refresh token | Create |
| `src/speech/bargeInController.js` | `isSpeaking` state machine; abort in-flight TTS on user speech | Create |
| `src/audioPlayer.js` | Add optional `signal` to `playAudio` so playback is abortable | Modify |
| `src/callingAgent.js` | Use persona lib; human/no-disclosure/interest-led opener; demo-booking hook | Modify |
| `src/orchestrator.js` | Wire bargeInController into `speak` + listen loops; human intro on join | Modify |
| `src/preflight.js` | Per-box readiness checks (env + reachability), fail fast | Modify |
| `src/config.js` | New env: `discloseAi=false` default for persona, email-link + Google + meet-VAD keys | Modify |
| `.env.example` | Document all new env | Modify |
| `package.json` | Add `googleapis` dep + `auth:google` script | Modify |
| `test/*.test.js` | Unit tests for each new module | Create |

Phases are independently shippable: **Phase 0** (shared foundation) → **Phase 1** (Box 1) → **Phase 2** (Box 2) → **Phase 3** (deploy + E2E).

---

## Phase 0 — Shared foundation

### Task 1: Generic retry helper

**Files:**
- Create: `src/util/retry.js`
- Test: `test/retry.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { withRetry } from "../src/util/retry.js";

describe("withRetry", () => {
  it("returns the first successful result without extra attempts", async () => {
    let calls = 0;
    const result = await withRetry(async () => { calls += 1; return "ok"; }, { retries: 3, baseDelayMs: 0 });
    assert.equal(result, "ok");
    assert.equal(calls, 1);
  });

  it("retries on failure then succeeds", async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls += 1;
      if (calls < 3) throw new Error("flaky");
      return calls;
    }, { retries: 5, baseDelayMs: 0 });
    assert.equal(result, 3);
    assert.equal(calls, 3);
  });

  it("throws the last error after exhausting retries", async () => {
    let calls = 0;
    await assert.rejects(
      () => withRetry(async () => { calls += 1; throw new Error(`fail-${calls}`); }, { retries: 2, baseDelayMs: 0 }),
      /fail-3/
    );
    assert.equal(calls, 3);
  });

  it("calls onRetry with attempt number and error", async () => {
    const seen = [];
    await withRetry(async () => { throw new Error("x"); }, {
      retries: 1, baseDelayMs: 0, onRetry: (attempt, err) => seen.push([attempt, err.message])
    }).catch(() => {});
    assert.deepEqual(seen, [[1, "x"], [2, "x"]]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/retry.test.js`
Expected: FAIL — `Cannot find module '../src/util/retry.js'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/util/retry.js
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retry an async operation with exponential backoff.
 * @param {() => Promise<any>} fn
 * @param {{retries?: number, baseDelayMs?: number, factor?: number, onRetry?: (attempt: number, error: Error) => void}} [options]
 */
export async function withRetry(fn, options = {}) {
  const { retries = 2, baseDelayMs = 200, factor = 2, onRetry } = options;
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (onRetry) onRetry(attempt + 1, lastError);
      if (attempt < retries) await sleep(baseDelayMs * factor ** attempt);
    }
  }
  throw lastError;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/retry.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/util/retry.js test/retry.test.js
git commit -m "feat: generic async retry helper with backoff"
```

---

### Task 2: Shared human persona library

**Files:**
- Create: `src/persona/asha.js`
- Test: `test/persona.test.js`

This becomes the single prompt builder. It supersedes the disclosure/personality text currently inline in `callingAgent.js` (`buildCallingAgentSystemPrompt`) and `brain.js` (`buildSystemPrompt`). Those keep working; we route them through the shared builder in later tasks.

- [ ] **Step 1: Write the failing test**

```javascript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPersonaPrompt } from "../src/persona/asha.js";

const baseScript = { title: "RetailDaddy demo", steps: [{ id: "billing", title: "Billing", keywords: ["bill"] }] };

describe("buildPersonaPrompt", () => {
  it("never discloses AI when discloseAi is false and deflects bot questions", () => {
    const prompt = buildPersonaPrompt({
      agentName: "RetailDaddy", personaName: "Asha", discloseAi: false,
      multilingual: true, productKnowledge: "POS billing", script: baseScript,
      goal: "show a demo"
    });
    assert.match(prompt, /Asha/);
    assert.doesNotMatch(prompt, /I am an AI|AI voice agent|AI demo assistant/i);
    assert.match(prompt, /do not say you are an AI|stay in character/i);
    assert.match(prompt, /POS billing/);
  });

  it("includes upfront disclosure when discloseAi is true", () => {
    const prompt = buildPersonaPrompt({
      agentName: "RetailDaddy", personaName: "Asha", discloseAi: true,
      multilingual: true, productKnowledge: "", script: baseScript
    });
    assert.match(prompt, /disclose|AI voice agent/i);
  });

  it("is multilingual and Malayalam-first", () => {
    const prompt = buildPersonaPrompt({
      agentName: "RetailDaddy", personaName: "Asha", discloseAi: false,
      multilingual: true, productKnowledge: "", script: baseScript
    });
    assert.match(prompt, /Malayalam/);
    assert.match(prompt, /switch.*language|mirror/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/persona.test.js`
Expected: FAIL — `Cannot find module '../src/persona/asha.js'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/persona/asha.js

/**
 * Single source of the human persona system prompt for both the call agent and the meet demo agent.
 * @param {{agentName: string, personaName?: string, discloseAi?: boolean, multilingual?: boolean,
 *          productKnowledge?: string, script?: {title?: string, steps?: Array<{id:string,title:string,keywords?:string[]}>},
 *          goal?: string}} params
 */
export function buildPersonaPrompt({
  agentName,
  personaName = "Asha",
  discloseAi = false,
  multilingual = true,
  productKnowledge = "",
  script = {},
  goal
}) {
  const scriptSummary = {
    title: script?.title || "RetailDaddy demo",
    steps: (script?.steps || []).map((step) => ({ id: step.id, title: step.title, keywords: step.keywords || [] }))
  };

  const disclosure = discloseAi
    ? "At the very start, briefly disclose that you are an AI voice agent, then talk naturally."
    : [
        "You are a real human member of the RetailDaddy team on a live call.",
        "Do not say you are an AI, a bot, a model, or automated.",
        "If asked directly whether you are a bot or AI, stay in character: laugh it off warmly, say you are from the RetailDaddy team here to help, and move the conversation forward."
      ].join(" ");

  const language = multilingual
    ? [
        "You are a multilingual Indian speech-to-speech agent, Malayalam-first.",
        "Open in warm Malayalam/English mix; detect the other person's language each turn and immediately switch to it or mirror their code-mix.",
        "Support Malayalam, English, Tamil, Telugu, Hindi, Kannada, Bengali, Marathi, Gujarati, Punjabi, and Urdu.",
        "For Indian-language phrases use the native script so TTS pronounces them correctly. Keep product names, prices, URLs, and UI labels in English when clearer.",
        "Never claim you cannot speak a supported language."
      ].join(" ")
    : "Reply in natural Indian English.";

  return [
    `You are ${personaName}, working with the RetailDaddy team (${agentName}).`,
    disclosure,
    [
      "Personality:",
      "warm, sharp Kerala-based retail-tech consultant on a real phone or video call.",
      "Confident, lightly energetic, practical, calm.",
      "Use small natural acknowledgements ('Got it', 'Sure', their language equivalents) but do not overdo it.",
      "Never sound like an IVR, chatbot, brochure, or support ticket."
    ].join(" "),
    language,
    "Goal:",
    goal || "build rapport, gauge interest in RetailDaddy, and move an interested person toward a live product demo.",
    [
      "Behave like a real-time human:",
      "respond only to the latest turn, speak in 1-2 natural sentences, keep most replies under 45 words, ask at most one question, never monologue.",
      "If a transcript is partial or unclear, ask one short clarification instead of guessing.",
      "No markdown, bullet lists, emojis, or stage directions.",
      "Do not repeat the other person's words unless confirming a detail.",
      "Do not re-introduce yourself after the first greeting."
    ].join(" "),
    "Actively listen the whole time: remember their needs, answer interruptions directly, switch language whenever they switch.",
    "Use only the supplied product knowledge and demo script. If a fact is missing, say the team will confirm it right after.",
    "",
    "Demo script metadata:",
    JSON.stringify(scriptSummary, null, 2),
    "",
    "Product knowledge:",
    productKnowledge || "No product knowledge was provided."
  ].join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/persona.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/persona/asha.js test/persona.test.js
git commit -m "feat: shared human persona prompt builder (Asha)"
```

---

### Task 3: Default persona to no-disclosure + new config keys

**Files:**
- Modify: `src/config.js:70-78` (agent block) and `src/config.js:79-109` (calling block)
- Modify: `.env.example`
- Test: `test/config.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

describe("config persona + booking + meet keys", () => {
  const saved = {};
  const keys = ["DISCLOSE_AI", "CALL_EMAIL_LINK", "GOOGLE_AGENT_EMAIL", "MEET_VAD_RMS", "MEET_SILENCE_MS", "CALL_AGENT_TTS_SPEAKER"];
  beforeEach(() => { for (const k of keys) saved[k] = process.env[k]; for (const k of keys) delete process.env[k]; });
  afterEach(() => { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  it("defaults DISCLOSE_AI to false (human persona)", () => {
    assert.equal(loadConfig().agent.discloseAi, false);
  });

  it("exposes booking + meet barge-in config with sane defaults", () => {
    const c = loadConfig();
    assert.equal(c.booking.emailLink, false);
    assert.equal(c.booking.googleEmail, "");
    assert.equal(c.meet.vadRms, 0.008);
    assert.equal(c.meet.silenceMs, 650);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/config.test.js`
Expected: FAIL — `c.booking` is undefined / `discloseAi` is true

- [ ] **Step 3: Write minimal implementation**

In `src/config.js`, change the agent disclosure default (line 72):

```javascript
      discloseAi: boolFromEnv("DISCLOSE_AI", false),
```

Add two new top-level blocks to the returned object (after the `calling` block closes, before `paths`):

```javascript
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
```

In `.env.example`, append:

```bash
# Persona (shared) — human, no AI disclosure
DISCLOSE_AI=false
CALL_AGENT_TTS_SPEAKER=anushka

# Box 1 optional email-the-Meet-link
CALL_EMAIL_LINK=false
GOOGLE_AGENT_CLIENT_ID=
GOOGLE_AGENT_CLIENT_SECRET=
GOOGLE_AGENT_REFRESH_TOKEN=
GOOGLE_AGENT_EMAIL=retaildaddy.demo@gmail.com
GOOGLE_AGENT_CALENDAR_ID=primary

# Box 2 barge-in
MEET_VAD_RMS=0.008
MEET_SILENCE_MS=650
MEET_JOIN_RETRIES=1
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/config.test.js`
Expected: PASS (2 tests)

Also run the full suite to confirm the disclosure-default flip did not break existing prompt tests:

Run: `node --test test/*.js`
Expected: PASS (existing tests that assert disclosure pass `discloseAi: true` explicitly, so they are unaffected).

- [ ] **Step 5: Commit**

```bash
git add src/config.js .env.example test/config.test.js
git commit -m "feat: default to human persona; add booking + meet barge-in config"
```

---

## Phase 1 — Box 1: Voice Call Agent

### Task 4: Route call agent through shared persona + human opener + female voice

**Files:**
- Modify: `src/callingAgent.js:62-123` (replace `buildCallingAgentSystemPrompt` body) and `:202-215` (`startCall` greeting)
- Test: `test/callingAgent.test.js` (add cases)

- [ ] **Step 1: Write the failing test** (append to `test/callingAgent.test.js`)

```javascript
import { buildCallingAgentSystemPrompt, CallingAgent } from "../src/callingAgent.js";

describe("calling agent human persona", () => {
  it("does not disclose AI by default and stays in character", () => {
    const prompt = buildCallingAgentSystemPrompt({
      agentName: "RetailDaddy", productKnowledge: "POS", script: { title: "d", steps: [] },
      goal: "demo", personaName: "Asha", discloseAi: false, multilingual: true
    });
    assert.doesNotMatch(prompt, /AI voice agent|I am an AI/i);
    assert.match(prompt, /stay in character|do not say you are an AI/i);
  });

  it("opens outbound calls interest-led without an AI disclosure", async () => {
    const fakeSarvam = {
      chat: async () => "ok",
      textToSpeechStream: async (_t, p) => p,
      transcribeFile: async () => ({ transcript: "" })
    };
    const agent = new CallingAgent({
      sarvamClient: fakeSarvam,
      config: {
        sarvam: { ttsModel: "bulbul:v3", ttsSpeaker: "anushka", ttsSampleRate: 8000, ttsPace: 1.08, ttsLanguageCode: "ml-IN" },
        calling: { personaName: "Asha", multilingual: true, ttsSpeaker: "anushka" },
        agent: { discloseAi: false, name: "RetailDaddy" },
        paths: { audioOutDir: "/tmp" }
      },
      script: { title: "d", steps: [] }, productKnowledge: "", logger: { info() {}, warn() {}, error() {} }
    });
    const { answer } = await agent.startCall({ callerName: "Rahul", direction: "outbound" });
    assert.doesNotMatch(answer, /AI voice agent/i);
    assert.match(answer, /demo|RetailDaddy/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/callingAgent.test.js`
Expected: FAIL — current greeting says "RetailDaddy's AI voice agent"; prompt lacks "stay in character"

- [ ] **Step 3: Write minimal implementation**

In `src/callingAgent.js`, replace the body of `buildCallingAgentSystemPrompt` so it delegates to the shared builder:

```javascript
import { buildPersonaPrompt } from "./persona/asha.js";

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
```

Replace the outbound/inbound greeting in `startCall` (lines ~206-209):

```javascript
    const greeting =
      session.direction === "outbound"
        ? `Hi ${name}, it's ${personaName} from RetailDaddy. I saw you were checking us out — got a minute? I'd love to quickly show you what RetailDaddy can do.`
        : `Hi ${name}, ${personaName} here from RetailDaddy. How can I help you today?`;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/callingAgent.test.js`
Expected: PASS (new + existing cases)

- [ ] **Step 5: Commit**

```bash
git add src/callingAgent.js test/callingAgent.test.js
git commit -m "feat: human, interest-led, no-disclosure call agent persona"
```

---

### Task 5: Spoken-email capture + readback confirmation

**Files:**
- Create: `src/booking/emailCapture.js`
- Test: `test/emailCapture.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeSpokenEmail, buildReadback } from "../src/booking/emailCapture.js";

describe("normalizeSpokenEmail", () => {
  it("converts spoken 'at' and 'dot' to symbols", () => {
    assert.equal(normalizeSpokenEmail("rahul at gmail dot com"), "rahul@gmail.com");
  });
  it("strips spaces and lowercases", () => {
    assert.equal(normalizeSpokenEmail("R A H U L @ Gmail . com"), "rahul@gmail.com");
  });
  it("repairs common domain mishears", () => {
    assert.equal(normalizeSpokenEmail("rahul@gmailcom"), "rahul@gmail.com");
    assert.equal(normalizeSpokenEmail("rahul at g mail dot com"), "rahul@gmail.com");
  });
  it("returns empty string when no plausible email is present", () => {
    assert.equal(normalizeSpokenEmail("I do not want to share"), "");
  });
});

describe("buildReadback", () => {
  it("spells the email back for confirmation", () => {
    assert.match(buildReadback("rahul@gmail.com"), /r a h u l/i);
    assert.match(buildReadback("rahul@gmail.com"), /gmail/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/emailCapture.test.js`
Expected: FAIL — `Cannot find module '../src/booking/emailCapture.js'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/booking/emailCapture.js
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN_FIXES = [
  [/g\s*mail/g, "gmail"],
  [/gmailcom$/i, "gmail.com"],
  [/yahoocom$/i, "yahoo.com"],
  [/outlookcom$/i, "outlook.com"],
  [/hotmailcom$/i, "hotmail.com"]
];

/**
 * Turn a spoken email transcript into a normalized address, or "" if not plausible.
 * @param {string} spoken
 * @returns {string}
 */
export function normalizeSpokenEmail(spoken) {
  if (!spoken) return "";
  let value = String(spoken).toLowerCase();
  value = value.replace(/\s+at\s+/g, "@").replace(/\s+dot\s+/g, ".");
  value = value.replace(/\s+/g, "");
  for (const [pattern, replacement] of DOMAIN_FIXES) value = value.replace(pattern, replacement);
  if (!value.includes("@") && /gmailcom|yahoocom/.test(value)) {
    value = value.replace(/(gmail|yahoo)/, "@$1");
  }
  return EMAIL_RE.test(value) ? value : "";
}

/**
 * Produce a spoken read-back string for confirmation.
 * @param {string} email
 * @returns {string}
 */
export function buildReadback(email) {
  if (!email) return "";
  const [local, domain] = email.split("@");
  const spelledLocal = local.split("").join(" ");
  return `Let me confirm — ${spelledLocal}, at ${domain}. Is that right?`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/emailCapture.test.js`
Expected: PASS (6 assertions across 5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/booking/emailCapture.js test/emailCapture.test.js
git commit -m "feat: spoken-email normalization + readback confirmation"
```

---

### Task 6: Google auth client + calendar Meet-link creation

**Files:**
- Modify: `package.json` (add `googleapis`, `auth:google` script)
- Create: `src/booking/googleAuth.js`
- Create: `src/booking/calendarLink.js`
- Create: `scripts/authGoogle.js`
- Test: `test/calendarLink.test.js`

- [ ] **Step 1: Add the dependency**

Run: `npm install googleapis`
Expected: `googleapis` added to `package.json` dependencies.

Add to `package.json` `scripts`:

```json
    "auth:google": "node scripts/authGoogle.js",
```

- [ ] **Step 2: Write the failing test** (pure-payload test; no network)

```javascript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildMeetEventPayload } from "../src/booking/calendarLink.js";

describe("buildMeetEventPayload", () => {
  it("creates a 30-min event with a Meet conference request and attendee", () => {
    const startIso = "2026-06-10T10:00:00.000Z";
    const payload = buildMeetEventPayload({
      summary: "RetailDaddy demo with Rahul",
      attendeeEmail: "rahul@gmail.com",
      startIso,
      durationMinutes: 30
    });
    assert.equal(payload.summary, "RetailDaddy demo with Rahul");
    assert.equal(payload.start.dateTime, startIso);
    assert.equal(payload.end.dateTime, "2026-06-10T10:30:00.000Z");
    assert.deepEqual(payload.attendees, [{ email: "rahul@gmail.com" }]);
    assert.ok(payload.conferenceData.createRequest.conferenceSolutionKey.type === "hangoutsMeet");
    assert.ok(payload.conferenceData.createRequest.requestId.length > 0);
  });

  it("throws on a missing attendee email", () => {
    assert.throws(() => buildMeetEventPayload({ summary: "x", startIso: "2026-06-10T10:00:00.000Z" }), /attendeeEmail/);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test test/calendarLink.test.js`
Expected: FAIL — `Cannot find module '../src/booking/calendarLink.js'`

- [ ] **Step 4: Write the implementation**

```javascript
// src/booking/googleAuth.js
import { google } from "googleapis";

/**
 * Build an OAuth2 client authorized via the agent account's offline refresh token.
 * @param {{googleClientId: string, googleClientSecret: string, googleRefreshToken: string}} booking
 */
export function createGoogleAuth(booking) {
  const { googleClientId, googleClientSecret, googleRefreshToken } = booking;
  if (!googleClientId || !googleClientSecret || !googleRefreshToken) {
    throw new Error("Missing Google agent credentials. Run npm run auth:google and set GOOGLE_AGENT_* env.");
  }
  const client = new google.auth.OAuth2(googleClientId, googleClientSecret, "urn:ietf:wg:oauth:2.0:oob");
  client.setCredentials({ refresh_token: googleRefreshToken });
  return client;
}
```

```javascript
// src/booking/calendarLink.js
import crypto from "node:crypto";
import { google } from "googleapis";
import { createGoogleAuth } from "./googleAuth.js";
import { withRetry } from "../util/retry.js";

/**
 * Pure builder for a Google Calendar event that requests a Meet link.
 * @param {{summary: string, attendeeEmail?: string, startIso: string, durationMinutes?: number}} input
 */
export function buildMeetEventPayload({ summary, attendeeEmail, startIso, durationMinutes = 30 }) {
  if (!attendeeEmail) throw new Error("attendeeEmail is required");
  const end = new Date(new Date(startIso).getTime() + durationMinutes * 60_000).toISOString();
  return {
    summary,
    start: { dateTime: startIso },
    end: { dateTime: end },
    attendees: [{ email: attendeeEmail }],
    conferenceData: {
      createRequest: {
        requestId: crypto.randomUUID(),
        conferenceSolutionKey: { type: "hangoutsMeet" }
      }
    }
  };
}

/**
 * Create the event (sends the invite email automatically) and return the Meet link.
 * @param {{booking: object, summary: string, attendeeEmail: string, startIso: string, durationMinutes?: number, logger?: object}} args
 * @returns {Promise<{meetUrl: string, eventId: string, startIso: string}>}
 */
export async function createMeetEvent({ booking, summary, attendeeEmail, startIso, durationMinutes = 30, logger }) {
  const auth = createGoogleAuth(booking);
  const calendar = google.calendar({ version: "v3", auth });
  const requestBody = buildMeetEventPayload({ summary, attendeeEmail, startIso, durationMinutes });

  const response = await withRetry(
    () => calendar.events.insert({
      calendarId: booking.calendarId || "primary",
      conferenceDataVersion: 1,
      sendUpdates: "all",
      requestBody
    }),
    { retries: 2, baseDelayMs: 400, onRetry: (n, e) => logger?.warn?.(`Calendar insert retry ${n}: ${e.message}`) }
  );

  const event = response.data;
  const meetUrl =
    event.hangoutLink ||
    event.conferenceData?.entryPoints?.find((p) => p.entryPointType === "video")?.uri ||
    "";
  if (!meetUrl) throw new Error("Calendar event created but no Meet link was returned.");
  return { meetUrl, eventId: event.id, startIso };
}
```

```javascript
// scripts/authGoogle.js
import process from "node:process";
import readline from "node:readline/promises";
import { google } from "googleapis";
import { loadDotEnv } from "../src/config.js";

loadDotEnv();

const clientId = process.env.GOOGLE_AGENT_CLIENT_ID;
const clientSecret = process.env.GOOGLE_AGENT_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error("Set GOOGLE_AGENT_CLIENT_ID and GOOGLE_AGENT_CLIENT_SECRET in .env first.");
  process.exit(1);
}

const oauth2 = new google.auth.OAuth2(clientId, clientSecret, "urn:ietf:wg:oauth:2.0:oob");
const scopes = ["https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/gmail.send"];
const authUrl = oauth2.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: scopes });

console.log("1) Open this URL while logged in as the dedicated agent Google account:\n");
console.log(authUrl, "\n");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const code = (await rl.question("2) Paste the authorization code here: ")).trim();
rl.close();

const { tokens } = await oauth2.getToken(code);
console.log("\nAdd this to .env:\n");
console.log(`GOOGLE_AGENT_REFRESH_TOKEN=${tokens.refresh_token}`);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/calendarLink.test.js`
Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/booking/googleAuth.js src/booking/calendarLink.js scripts/authGoogle.js test/calendarLink.test.js
git commit -m "feat: Google OAuth client + Calendar Meet-link creation"
```

---

### Task 7: Booking action wired into the call session (gated)

**Files:**
- Modify: `src/callingAgent.js` — add `maybeBookDemo(session, transcript)` invoked from `handleText`
- Test: `test/callingAgent.test.js` (add cases)

The brain already sets `session.nextAction = "schedule_demo"` on demo intent (`updateCallState`/`fastReplyFor`). This task captures the email when offered and, if `CALL_EMAIL_LINK` is on, creates the Meet link. Calendar creation is injected so the test stays offline.

- [ ] **Step 1: Write the failing test**

```javascript
describe("calling agent demo booking", () => {
  function makeAgent(overrides = {}) {
    const fakeSarvam = { chat: async () => "Sure.", textToSpeechStream: async (_t, p) => p, transcribeFile: async () => ({ transcript: "" }) };
    return new CallingAgent({
      sarvamClient: fakeSarvam,
      config: {
        sarvam: { ttsModel: "bulbul:v3", ttsSpeaker: "anushka", ttsSampleRate: 8000, ttsPace: 1.08, ttsLanguageCode: "ml-IN" },
        calling: { personaName: "Asha", multilingual: true, ttsSpeaker: "anushka" },
        agent: { discloseAi: false, name: "RetailDaddy" },
        booking: { emailLink: true, googleEmail: "agent@x.com" },
        paths: { audioOutDir: "/tmp" }
      },
      script: { title: "d", steps: [] }, productKnowledge: "", logger: { info() {}, warn() {}, error() {} },
      createMeetEvent: overrides.createMeetEvent
    });
  }

  it("captures a spoken email and books a Meet link when email-link is enabled", async () => {
    let booked = null;
    const agent = makeAgent({
      createMeetEvent: async ({ attendeeEmail }) => { booked = attendeeEmail; return { meetUrl: "https://meet.google.com/abc", eventId: "e1", startIso: "now" }; }
    });
    const session = agent.createSession({ callerName: "Rahul", direction: "outbound" });
    session.nextAction = "schedule_demo";
    await agent.maybeBookDemo(session, "my email is rahul at gmail dot com");
    assert.equal(booked, "rahul@gmail.com");
    assert.equal(session.demo.meetUrl, "https://meet.google.com/abc");
    assert.equal(session.demo.email, "rahul@gmail.com");
  });

  it("does nothing when email-link is disabled", async () => {
    const agent = makeAgent();
    agent.config.booking.emailLink = false;
    const session = agent.createSession({ callerName: "Rahul" });
    session.nextAction = "schedule_demo";
    await agent.maybeBookDemo(session, "rahul at gmail dot com");
    assert.equal(session.demo, undefined);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/callingAgent.test.js`
Expected: FAIL — `agent.maybeBookDemo is not a function`

- [ ] **Step 3: Write minimal implementation**

In `src/callingAgent.js`, import the creator and accept an override in the constructor:

```javascript
import { createMeetEvent as defaultCreateMeetEvent } from "./booking/calendarLink.js";
import { normalizeSpokenEmail } from "./booking/emailCapture.js";
```

In the constructor params add `createMeetEvent` and store it:

```javascript
  constructor({ sarvamClient, config, script, productKnowledge, logger, createMeetEvent } = {}) {
    // ...existing assignments...
    this.createMeetEvent = createMeetEvent || defaultCreateMeetEvent;
  }
```

Add the method:

```javascript
  async maybeBookDemo(session, transcript) {
    if (!this.config.booking?.emailLink) return;
    if (session.demo?.meetUrl) return;
    if (session.nextAction !== "schedule_demo" && session.interest !== "demo") return;

    const email = normalizeSpokenEmail(transcript);
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
```

Call it from `handleText`, right after `this.updateCallState(session, transcript);` (line ~243):

```javascript
    await this.maybeBookDemo(session, transcript);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/callingAgent.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/callingAgent.js test/callingAgent.test.js
git commit -m "feat: gated demo booking + email capture in call session"
```

---

## Phase 2 — Box 2: Meet Demo Agent

### Task 8: Make audio playback abortable

**Files:**
- Modify: `src/audioPlayer.js:1-36` (`runCommand` + `playAudio`)
- Test: `test/audioPlayer.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { playAudio } from "../src/audioPlayer.js";

describe("playAudio abort", () => {
  it("rejects/stops promptly when the signal aborts", async () => {
    const controller = new AbortController();
    // 'sleep 5' stands in for a long playback command.
    const promise = playAudio("ignored", "sleep 5", { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    const start = Date.now();
    await promise.catch(() => {});
    assert.ok(Date.now() - start < 2000, "playback should stop soon after abort");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/audioPlayer.test.js`
Expected: FAIL — abort is ignored; the call waits ~5s (assertion fails)

- [ ] **Step 3: Write minimal implementation**

In `src/audioPlayer.js`, update `runCommand` to accept a signal and kill the child on abort, and thread an options arg through `playAudio`:

```javascript
function runCommand(command, args, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    const onAbort = () => { child.kill("SIGKILL"); };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    child.on("error", (error) => { signal?.removeEventListener?.("abort", onAbort); reject(error); });
    child.on("exit", (code) => {
      signal?.removeEventListener?.("abort", onAbort);
      if (signal?.aborted) resolve();
      else if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

export async function playAudio(filePath, playCommand = "", { signal } = {}) {
  if (playCommand) {
    const [command, ...args] = playCommand.split(/\s+/);
    await runCommand(command, [...args, filePath], { signal });
    return;
  }
  if (os.platform() === "darwin") {
    await runCommand("afplay", [filePath], { signal });
    return;
  }
  await runCommand("ffplay", ["-nodisp", "-autoexit", "-loglevel", "quiet", filePath], { signal });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/audioPlayer.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/audioPlayer.js test/audioPlayer.test.js
git commit -m "feat: abortable audio playback via AbortSignal"
```

---

### Task 9: Barge-in controller

**Files:**
- Create: `src/speech/bargeInController.js`
- Test: `test/bargeInController.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BargeInController } from "../src/speech/bargeInController.js";

describe("BargeInController", () => {
  it("aborts the active speech controller when user speech arrives", () => {
    const bic = new BargeInController();
    const controller = new AbortController();
    bic.beginSpeaking(controller);
    assert.equal(bic.isSpeaking, true);
    const aborted = bic.onUserSpeech();
    assert.equal(aborted, true);
    assert.equal(controller.signal.aborted, true);
    assert.equal(bic.isSpeaking, false);
  });

  it("does nothing on user speech when not speaking", () => {
    const bic = new BargeInController();
    assert.equal(bic.onUserSpeech(), false);
  });

  it("clears state on endSpeaking", () => {
    const bic = new BargeInController();
    const controller = new AbortController();
    bic.beginSpeaking(controller);
    bic.endSpeaking();
    assert.equal(bic.isSpeaking, false);
    assert.equal(bic.onUserSpeech(), false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/bargeInController.test.js`
Expected: FAIL — `Cannot find module '../src/speech/bargeInController.js'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/speech/bargeInController.js

/**
 * Tracks whether the agent is currently speaking and aborts that speech
 * the instant the human starts talking (barge-in), like a real conversation.
 */
export class BargeInController {
  constructor() {
    this._controller = null;
  }

  get isSpeaking() {
    return this._controller !== null;
  }

  /** @param {AbortController} controller controls the in-flight TTS playback */
  beginSpeaking(controller) {
    this._controller = controller;
  }

  endSpeaking() {
    this._controller = null;
  }

  /**
   * Called when fresh user speech is detected. Aborts current speech if any.
   * @returns {boolean} true if a speech was interrupted
   */
  onUserSpeech() {
    if (!this._controller) return false;
    const controller = this._controller;
    this._controller = null;
    controller.abort();
    return true;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/bargeInController.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/speech/bargeInController.js test/bargeInController.test.js
git commit -m "feat: barge-in controller state machine"
```

---

### Task 10: Wire barge-in into the orchestrator speak path + listen loops

**Files:**
- Modify: `src/orchestrator.js` — construct a `BargeInController`; abortable `speak`; trigger barge-in from `handleLiveTranscript`
- Test: `test/orchestrator.bargein.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DemoOrchestrator } from "../src/orchestrator.js";

function makeOrchestrator() {
  const logger = { info() {}, warn() {}, error() {} };
  const config = {
    sarvam: { apiKey: "k", sttModel: "m", sttMode: "transcribe", sttLanguageCode: "ml-IN", ttsModel: "bulbul:v3", ttsSpeaker: "anushka", ttsPace: 1, ttsSampleRate: 24000, ttsLanguageCode: "ml-IN", chatModel: "sarvam-105b" },
    agent: { name: "RetailDaddy", discloseAi: false, multilingual: true, confirmationPattern: "start demo" },
    paths: { demoScript: "demo/demo-script.example.json", productKnowledge: "demo/product-knowledge.example.md", audioOutDir: "/tmp", audioInputDir: "/tmp" },
    audio: {}, browser: {}, meet: { vadRms: 0.008, silenceMs: 650 }
  };
  const orch = new DemoOrchestrator({ config, logger });
  return orch;
}

describe("orchestrator barge-in", () => {
  it("interrupts in-flight speech when a live transcript arrives", async () => {
    const orch = makeOrchestrator();
    let aborted = false;
    // Stub TTS + playback to observe abort.
    orch.sarvamClient.textToSpeechStream = async (_t, p) => p;
    orch.playWithSignal = async (_path, signal) => {
      await new Promise((resolve) => {
        if (signal.aborted) { aborted = true; return resolve(); }
        signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true });
      });
    };
    const speaking = orch.speak("a long sentence the user will interrupt", "test");
    // Simulate the human talking mid-utterance.
    setTimeout(() => orch.bargeIn.onUserSpeech(), 30);
    await speaking;
    assert.equal(aborted, true);
    assert.equal(orch.bargeIn.isSpeaking, false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/orchestrator.bargein.test.js`
Expected: FAIL — `orch.bargeIn` is undefined / `orch.playWithSignal` is not used by `speak`

- [ ] **Step 3: Write minimal implementation**

In `src/orchestrator.js` import and construct the controller. Add at top:

```javascript
import { BargeInController } from "./speech/bargeInController.js";
```

In the constructor (after `this.recentAgentUtterances = [];`):

```javascript
    this.bargeIn = new BargeInController();
```

Add a small playback seam and rewrite `speak` to be abortable:

```javascript
  async playWithSignal(audioPath, signal) {
    if (this.config.audio.browserPlayback && this.demoController?.page) {
      await playAudioInBrowser(this.demoController.page, audioPath);
    } else {
      await playAudio(audioPath, this.config.audio.playCommand, { signal });
    }
  }

  async speak(text, label = "speech") {
    requireSarvamKey(this.config);
    this.logger.info(`Speaking: ${text.slice(0, 90)}${text.length > 90 ? "..." : ""}`);
    this.rememberAgentSpeech(text);
    const audioPath = createAudioFilePath(this.config.paths.audioOutDir, label, "wav");
    const languageCode = this.config.agent.multilingual
      ? detectSarvamTtsLanguageCode(text, "en-IN")
      : this.config.sarvam.ttsLanguageCode;
    await this.sarvamClient.textToSpeechStream(text, audioPath, {
      model: this.config.sarvam.ttsModel,
      languageCode,
      speaker: this.config.sarvam.ttsSpeaker,
      pace: this.config.sarvam.ttsPace
    });
    const controller = new AbortController();
    this.bargeIn.beginSpeaking(controller);
    try {
      await this.playWithSignal(audioPath, controller.signal);
    } finally {
      this.bargeIn.endSpeaking();
    }
    return audioPath;
  }
```

Trigger barge-in at the entry of `handleLiveTranscript`, before the ignore check, so the human's voice cuts speech even if the transcript is later filtered:

```javascript
  async handleLiveTranscript(transcript, filePath, { onTranscript } = {}) {
    if (this.bargeIn.isSpeaking) {
      this.bargeIn.onUserSpeech();
      this.logger.info("Barge-in: user spoke while agent was talking; stopped playback.");
    }
    const reason = this.liveTranscriptIgnoreReason(transcript);
    // ...unchanged...
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/orchestrator.bargein.test.js`
Expected: PASS

Run the full suite: `node --test test/*.js` — Expected: PASS (no regressions).

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator.js test/orchestrator.bargein.test.js
git commit -m "feat: barge-in in meet agent (abort TTS on user speech)"
```

---

### Task 11: Human intro on Meet join + join retry fallback

**Files:**
- Modify: `src/orchestrator.js` — `runConfirmedLiveDemo`/`runVoiceAgent` speak a human intro right after join; wrap join in retry
- Test: `test/orchestrator.intro.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DemoOrchestrator } from "../src/orchestrator.js";

describe("orchestrator human intro + join retry", () => {
  it("retries a failing join up to meet.joinRetries then succeeds", async () => {
    const logger = { info() {}, warn() {}, error() {} };
    const config = {
      sarvam: { apiKey: "k", sttModel: "m", sttMode: "x", sttLanguageCode: "ml-IN", ttsModel: "bulbul:v3", ttsSpeaker: "anushka", ttsPace: 1, ttsSampleRate: 24000, ttsLanguageCode: "ml-IN", chatModel: "c" },
      agent: { name: "RetailDaddy", discloseAi: false, multilingual: true, confirmationPattern: "start demo" },
      paths: { demoScript: "demo/demo-script.example.json", productKnowledge: "demo/product-knowledge.example.md", audioOutDir: "/tmp", audioInputDir: "/tmp" },
      audio: {}, browser: {}, meet: { vadRms: 0.008, silenceMs: 650, joinRetries: 2 }
    };
    const orch = new DemoOrchestrator({ config, logger });
    let attempts = 0;
    orch.meetAgent.launch = async () => {};
    orch.meetAgent.joinMeet = async () => { attempts += 1; if (attempts < 2) throw new Error("join flaked"); };
    await orch.joinMeetWithRetry({ autoPresent: false });
    assert.equal(attempts, 2);
  });

  it("builds a human intro line in the persona voice", () => {
    const logger = { info() {}, warn() {}, error() {} };
    const config = {
      sarvam: { apiKey: "k", sttModel: "m", sttMode: "x", sttLanguageCode: "ml-IN", ttsModel: "bulbul:v3", ttsSpeaker: "anushka", ttsPace: 1, ttsSampleRate: 24000, ttsLanguageCode: "ml-IN", chatModel: "c" },
      agent: { name: "RetailDaddy", discloseAi: false, multilingual: true, confirmationPattern: "start demo" },
      paths: { demoScript: "demo/demo-script.example.json", productKnowledge: "demo/product-knowledge.example.md", audioOutDir: "/tmp", audioInputDir: "/tmp" },
      audio: {}, browser: {}, meet: { vadRms: 0.008, silenceMs: 650, joinRetries: 1 }
    };
    const orch = new DemoOrchestrator({ config, logger });
    const intro = orch.buildJoinIntro();
    assert.match(intro, /RetailDaddy/);
    assert.doesNotMatch(intro, /AI/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/orchestrator.intro.test.js`
Expected: FAIL — `orch.joinMeetWithRetry is not a function`

- [ ] **Step 3: Write minimal implementation**

In `src/orchestrator.js` import the retry helper:

```javascript
import { withRetry } from "./util/retry.js";
```

Add methods:

```javascript
  buildJoinIntro() {
    return "Hi everyone, thanks for hopping on. I'm from the RetailDaddy team — give me one second and I'll share my screen and walk you through it.";
  }

  async joinMeetWithRetry({ autoPresent } = {}) {
    const retries = this.config.meet?.joinRetries ?? 1;
    await withRetry(
      () => this.meetAgent.joinMeet({ autoPresent }),
      { retries, baseDelayMs: 1500, onRetry: (n, e) => this.logger.warn(`Meet join retry ${n}: ${e.message}`) }
    );
  }
```

In `prepareDemoSession`, replace the `await this.meetAgent.joinMeet({ autoPresent });` line with:

```javascript
      await this.joinMeetWithRetry({ autoPresent });
```

In `runConfirmedLiveDemo`, immediately after `await this.prepareDemoSession({ withMeet: true, autoPresent: false });`, speak the intro:

```javascript
    await this.speak(this.buildJoinIntro(), "join-intro");
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/orchestrator.intro.test.js`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator.js test/orchestrator.intro.test.js
git commit -m "feat: human intro on Meet join + join retry fallback"
```

---

### Task 12: Screenshare fallback (audio-only demo) + preflight per box

**Files:**
- Modify: `src/orchestrator.js` — `runPreparedScriptedDemo` tolerates a failed present and narrates instead
- Modify: `src/preflight.js` — `checkCallAgent(config)` and `checkMeetAgent(config)` readiness
- Test: `test/preflight.test.js` (add cases)

- [ ] **Step 1: Write the failing test** (append to `test/preflight.test.js`)

```javascript
import { checkCallAgent, checkMeetAgent } from "../src/preflight.js";

describe("preflight per-box readiness", () => {
  it("flags missing call-agent env", () => {
    const result = checkCallAgent({
      sarvam: { apiKey: "" }, calling: { publicBaseUrl: "" },
      booking: { emailLink: false }
    });
    assert.equal(result.ok, false);
    assert.ok(result.missing.includes("SARVAM_API_KEY"));
    assert.ok(result.missing.includes("CALL_PUBLIC_BASE_URL"));
  });

  it("requires Google creds only when email-link is on", () => {
    const off = checkCallAgent({ sarvam: { apiKey: "k" }, calling: { publicBaseUrl: "https://x" }, booking: { emailLink: false } });
    assert.equal(off.ok, true);
    const on = checkCallAgent({ sarvam: { apiKey: "k" }, calling: { publicBaseUrl: "https://x" }, booking: { emailLink: true, googleRefreshToken: "" } });
    assert.equal(on.ok, false);
    assert.ok(on.missing.includes("GOOGLE_AGENT_REFRESH_TOKEN"));
  });

  it("flags missing meet-agent env", () => {
    const result = checkMeetAgent({ sarvam: { apiKey: "k" }, browser: { meetUrl: "" } });
    assert.equal(result.ok, false);
    assert.ok(result.missing.includes("GOOGLE_MEET_URL"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/preflight.test.js`
Expected: FAIL — `checkCallAgent`/`checkMeetAgent` are not exported

- [ ] **Step 3: Write minimal implementation**

Append to `src/preflight.js`:

```javascript
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
```

For the screenshare fallback, in `runPreparedScriptedDemo` wrap the present in a guard. Replace the opening lines of that method:

```javascript
    const productPage = this.demoController.page;
    await productPage.bringToFront();
    let canPresent = true;
    try {
      if (this.config.browser.autoPresent) await this.meetAgent.tryStartPresenting();
    } catch (error) {
      canPresent = false;
      this.logger.error(`Screen share failed; continuing audio-only and narrating screens: ${error.message}`);
    }
    if (!canPresent) {
      await this.speak("I'm having a small screen-share hiccup, so I'll walk you through it by voice and fix the share in a moment.", "share-fallback");
    }
    await this.speak(this.script.opening, "opening");
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/preflight.test.js`
Expected: PASS

Run full suite: `node --test test/*.js` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator.js src/preflight.js test/preflight.test.js
git commit -m "feat: screenshare fallback + per-box preflight readiness checks"
```

---

## Phase 3 — Deploy + end-to-end

### Task 13: Deployment runbook + VM provisioning

**Files:**
- Create: `docs/DEPLOY.md`
- Modify: `README.md` (link the runbook + both run commands)

- [ ] **Step 1: Write `docs/DEPLOY.md`**

````markdown
# Deployment Runbook — Two Independent Agents

## Box 1 — Voice Call Agent (control host: Mac or small Linux VPS)

1. `cp .env.example .env`, fill: `SARVAM_API_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `CALL_PUBLIC_BASE_URL`.
   - `CALL_PUBLIC_BASE_URL` must be a stable public HTTPS host (authenticated ngrok or a VPS). Do NOT use localtunnel (prior reliability blocker).
2. `DISCLOSE_AI=false`, `CALL_AGENT_TTS_SPEAKER=anushka`.
3. (Optional email link) set `CALL_EMAIL_LINK=true`, run `npm run auth:google` as the dedicated agent Google account, paste `GOOGLE_AGENT_REFRESH_TOKEN` into `.env`, set `GOOGLE_AGENT_CLIENT_ID/SECRET/EMAIL`.
4. Verify: `npm run calling-agent` then `curl -sS "$CALL_PUBLIC_BASE_URL/health"`.
5. Place a call: `npm run dial -- +91XXXXXXXXXX "Caller Name"`.

## Box 2 — Meet Demo Agent (Windows VM `rdwinmeet`)

1. One-time install: Node 20+, git, ffmpeg (audit showed these missing).
2. Log the **dedicated agent Google account** into the Playwright Chrome profile (`CHROME_PROFILE_DIR`).
3. Configure audio routing per `docs/AUDIO_ROUTING.md`: TTS out → virtual mic into Meet; Meet audio → capture device for STT (`AUDIO_STREAM_COMMAND`). Keep the two routes separate so the agent never hears itself.
4. `.env`: `SARVAM_API_KEY`, `DISCLOSE_AI=false`, `MEET_AUTO_PRESENT=true`, `AUDIO_STREAM_COMMAND=...`, `MEET_CAPTION_LISTEN=true` (fallback).
5. Run a demo: `GOOGLE_MEET_URL="https://meet.google.com/xxx" npm run launch`.

## Fallback verification (per the spec matrix)
- Kill the Sarvam stream mid-call → REST STT/TTS path engages, conversation continues.
- Wrong email read-back → agent spells it back, offers to retry, optionally SMS.
- Force a Meet join failure once → retry succeeds; persistent failure exits non-zero with diagnostics under `.meet-diagnostics`.
- Block screen share → demo continues audio-only with narration.
- Calendar API down → agent states the time verbally and flags manual follow-up.
````

- [ ] **Step 2: Link from `README.md`**

Add under a "Run" or "Deploy" heading:

```markdown
## Run

- **Voice Call Agent:** `npm run dial -- +91XXXXXXXXXX "Name"`
- **Meet Demo Agent:** `GOOGLE_MEET_URL="<link>" npm run launch`

See [docs/DEPLOY.md](docs/DEPLOY.md) for the full two-box runbook and fallback verification.
```

- [ ] **Step 3: Commit**

```bash
git add docs/DEPLOY.md README.md
git commit -m "docs: two-box deployment runbook + run commands"
```

---

### Task 14: Full suite green + manual E2E checklist

**Files:**
- Create: `docs/E2E-CHECKLIST.md`

- [ ] **Step 1: Run the whole unit suite**

Run: `node --test test/*.js`
Expected: PASS — all prior 52 tests plus the new modules (retry, persona, config, emailCapture, calendarLink, audioPlayer, bargeInController, orchestrator barge-in/intro, preflight).

- [ ] **Step 2: Write `docs/E2E-CHECKLIST.md`**

```markdown
# Manual E2E Checklist

## Box 1 — Voice Call Agent
- [ ] Outbound call connects; Asha opens interest-led, in Malayalam/English, never says "AI".
- [ ] Speak over her mid-sentence → she stops immediately (barge-in).
- [ ] Switch language mid-call → she switches.
- [ ] Ask "are you a bot?" → stays in character warmly.
- [ ] (If CALL_EMAIL_LINK) give email spoken → she reads it back → confirm → invite email arrives with a Meet link.
- [ ] Force Sarvam stream failure → REST fallback keeps the call alive.

## Box 2 — Meet Demo Agent
- [ ] `npm run launch` with a real GOOGLE_MEET_URL → joins and self-admits.
- [ ] Human intro plays on join (no "AI").
- [ ] Screen share starts; POS walkthrough runs with voiced narration.
- [ ] Talk during a step → she stops talking instantly and answers (barge-in), then resumes listening.
- [ ] Block screen share once → demo continues audio-only with narration.
- [ ] Persistent join failure → exits non-zero, diagnostics saved.
```

- [ ] **Step 3: Commit**

```bash
git add docs/E2E-CHECKLIST.md
git commit -m "docs: manual end-to-end verification checklist"
```

---

## Self-review notes

- **Spec coverage:** persona/no-disclosure (T2-T4), female voice (T3/T4), barge-in both boxes (Box 1 pre-existing; Box 2 T8-T10), email toggle + capture + link (T5-T7), calendar/Gmail (T6), fallback matrix (retry T1; STT/TTS already in `sarvamClient.requestWithRetries`; join retry T11; screenshare fallback T12; preflight T12; deploy/fallback verify T13-T14), two-box deploy (T13), TDD throughout.
- **Pre-existing fallbacks reused, not rebuilt:** Sarvam STT/TTS/chat retries (`sarvamClient.requestWithRetries`), Twilio barge-in (`twilioMediaStream.interruptPlayback`/`clear`), REST recording transport, caption-listen fallback — referenced in the runbook rather than re-implemented (DRY).
- **Type consistency:** `withRetry({retries, baseDelayMs, factor, onRetry})`, `createMeetEvent({booking, summary, attendeeEmail, startIso, durationMinutes, logger}) → {meetUrl, eventId, startIso}`, `BargeInController.{isSpeaking, beginSpeaking, endSpeaking, onUserSpeech}`, `playAudio(filePath, playCommand, {signal})`, `checkCallAgent/checkMeetAgent(config) → {ok, missing}` — used consistently across tasks.
- **Open follow-ups (future plans, intentionally out of scope):** scheduled-for-later auto-trigger of Box 2 from a booked slot; SMS link fallback wiring into the live Twilio session; CRM/dashboard surface.
```
