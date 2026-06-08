# Dual Human-Grade AI Agents — Design Spec

Date: 2026-06-09
Status: Approved (pending spec review)
Owner: Rahul Babu K

## 1. Goal

Ship two **independent, production-grade** AI agents that can be launched as a product and handed to clients:

1. **Voice Call Agent** — places an outbound phone call, talks like a real human (no AI disclosure), detects the prospect's interest in RetailDaddy, offers a demo in any Indian language, listens mid-speech like a human (barge-in). Optionally captures the prospect's email and emails them a Google Meet link.
2. **Meet Demo Agent** — given a Google Meet link, joins the call, gives a human intro in the prospect's language, listens continuously (barge-in at all times), and runs the RetailDaddy POS demo by screen-sharing.

The two agents are **fully decoupled**. Either runs standalone. They share persona/voice/Sarvam libraries but have **no runtime dependency** on each other. The call agent only *produces* a Meet link; the Meet agent only *consumes* a link.

### Success criteria

- Call agent dials a number, holds a natural multilingual conversation, never reveals it is AI unless directly asked, and pitches a demo led by interest.
- Meet agent joins any supplied Meet link, intros itself as a human, screen-shares the POS demo, and answers questions while never stopping listening.
- Both agents interrupt their own speech the instant the human starts talking (barge-in).
- **Every external failure has an iterated fallback** (Section 7). No silent failures. No dead-ends in front of a client.
- Deployable end-to-end: Box 1 on a control host, Box 2 on the Windows VM `rdwinmeet`.

### Non-goals (this spec)

- A web dashboard / CRM UI (call summaries are logged; UI is future work).
- Inbound IVR phone trees.
- Auto-launching the Meet agent from the call agent (kept manual/optional; agents stay independent).

## 2. Architecture — two independent boxes

```
╔═══ BOX 1: VOICE CALL AGENT (control host) ═══╗   ╔═══ BOX 2: MEET DEMO AGENT (VM rdwinmeet) ═══╗
║ run: npm run dial -- +91xxxx "Name"          ║   ║ run: GOOGLE_MEET_URL=<link> npm run launch  ║
║                                              ║   ║                                             ║
║ Twilio media stream ◄──► prospect (phone)    ║   ║ Playwright joins Meet (dedicated acct, host)║
║ Asha brain: human, NO AI disclosure,         ║   ║ Human intro in prospect's language          ║
║   Malayalam-first, multilingual              ║   ║ CONTINUOUS listen loop (mic + captions)     ║
║ Barge-in: cuts own TTS when prospect speaks  ║   ║   → barge-in: cuts own TTS when they talk   ║
║ Interest-led demo pitch in any language      ║   ║ Screenshare POS stage → guided walkthrough  ║
║ Optional: capture email → create Meet link   ║   ║ Live Q&A via Sarvam, never stops listening  ║
║   → email it (Google Calendar/Gmail)         ║   ║                                             ║
╚══════════════════════════════════════════════╝   ╚═════════════════════════════════════════════╝
        shared lib: src/persona, src/sarvamClient, src/brain  (no cross-box runtime dependency)
```

- **Immediate vs scheduled demo:** the call agent lets the prospect choose. "Now" → email a link valid immediately. A future slot → calendar event at that time. The Meet agent is pointed at the link (manually or by an operator) and is agnostic to timing.

## 3. Components

### 3.1 Shared library (extract; no behavior change)

- `src/persona/asha.js` — single source of truth for the human persona used by both boxes:
  - Name **Asha**, warm Kerala-based retail-tech consultant, female voice.
  - **No AI disclosure.** Behaves fully human; if *directly* asked "are you a bot/AI?" it deflects warmly and stays in character (per owner decision; see Section 9 legal note).
  - Malayalam-first, switches to the human's language (English, Tamil, Telugu, Hindi, Kannada, etc.), mirrors code-mixing.
  - Built from the existing `buildCallingAgentSystemPrompt` in `callingAgent.js`, generalized so the Meet agent's `brain.js` can reuse it.
- `src/sarvamClient.js`, `src/sarvamStreaming.js` — unchanged, used by both.

### 3.2 Box 1 — Voice Call Agent (mostly exists)

- **Prompt rewrite** (`callingAgent.js` → persona lib): human, no disclosure, **interest-led opener**, e.g. "Hi <name>, saw you were checking out RetailDaddy — I'd love to walk you through a quick demo. Which language is easiest for you?" Mirrors language immediately.
- **Voice:** swap Sarvam speaker from `shubh` (male) to a female speaker for Asha — default `anushka` (verify against the live `bulbul:v3` speaker list at impl time; pick the best Malayalam-capable female voice).
- **Barge-in:** already implemented via Twilio `clear` in `twilioMediaStream.js`. Verify + tune.
- **Optional email link** (gated by `CALL_EMAIL_LINK=true`, default off):
  - `src/booking/emailCapture.js` — normalize a spoken email (`"at"→@`, `"dot"→.`, common-domain repair) and **read it back for confirmation** before use.
  - `src/booking/calendarLink.js` — create a Google Calendar event with a Meet link using the **dedicated agent Google account** via OAuth refresh token (`googleapis`); Google auto-emails the invite to the prospect. Optional nicer confirmation mail via Gmail API.
  - `npm run auth:google` — one-time script to mint the agent account's offline refresh token.

### 3.3 Box 2 — Meet Demo Agent (mostly exists)

- **`src/speech/bargeInController.js` (new):** a small state machine — tracks `isSpeaking`; exposes `beginSpeaking(abortController)`, `endSpeaking()`, `onUserSpeech()`. When fresh user speech crosses the VAD/caption threshold while `isSpeaking`, it aborts the in-flight TTS playback and the half-formed reply, then yields to listening.
- **Wire-in:** wrap the orchestrator speak path (walkthrough steps + Q&A answers) in an `AbortController`; `listenForAudioQuestions` and `listenForMeetCaptions` call `onUserSpeech()` to trigger abort.
- **Human intro on join:** spoken greeting in the prospect's language as soon as it's admitted.
- **Reuse:** `googleMeetAgent.js` (join, self-admit as host, screenshare), `productDemoController.js`, `stageCommands.js`, POS stage in `public/pos/`.

## 4. Barge-in (shared human behavior)

One rule for both boxes: **human speech above threshold while the agent is speaking → abort current TTS, discard the unsent remainder of the reply, switch to listening.**

- Box 1: Twilio `clear` event (exists).
- Box 2: `bargeInController` + `AbortController` around playback (new).
- Tunables reuse the existing env family: `CALL_STREAM_VAD_RMS`, `CALL_STREAM_SILENCE_MS`, `CALL_STREAM_MIN_SPEECH_MS`. Box 2 gets parallel `MEET_VAD_RMS`, `MEET_SILENCE_MS` (defaults mirror call agent).

## 5. Configuration / env (additions)

```bash
# Persona (shared)
PERSONA_NAME=Asha
DISCLOSE_AI=false                 # owner decision: fully human
CALL_AGENT_TTS_SPEAKER=anushka     # female; verify against live bulbul:v3 list

# Box 1 optional email link
CALL_EMAIL_LINK=false             # default off; user-toggle
GOOGLE_AGENT_CLIENT_ID=
GOOGLE_AGENT_CLIENT_SECRET=
GOOGLE_AGENT_REFRESH_TOKEN=       # minted by npm run auth:google
GOOGLE_AGENT_EMAIL=retaildaddy.demo@gmail.com

# Box 2 barge-in
MEET_VAD_RMS=0.008
MEET_SILENCE_MS=650
```

## 6. Deployment (end-to-end, two boxes)

**Box 1 — control host (Mac/Linux):**
1. `.env` with `SARVAM_API_KEY`, Twilio creds, `CALL_PUBLIC_BASE_URL` (stable public HTTPS — authenticated ngrok / small VPS, NOT localtunnel per prior blocker).
2. `npm run calling-agent` (server) or `npm run dial -- +91... "Name"`.

**Box 2 — Windows VM `rdwinmeet`:**
1. One-time: install **Node 20+, git, ffmpeg** (audit shows missing); log the **dedicated Google account** into the Playwright Chrome profile.
2. Configure system audio route (TTS out → virtual mic into Meet; Meet audio → capture device for STT) per `docs/AUDIO_ROUTING.md`. Keep routes separate to avoid the agent hearing itself.
3. `GOOGLE_MEET_URL=<link> npm run launch`.

## 7. Production robustness — fallback matrix

**Principle: no silent failures; every failure degrades to a working alternative and is logged loudly.**

| Failure point | Primary | Iterated fallback | Last resort |
|---|---|---|---|
| Sarvam **STT** (stream) | streaming `pcm_s16le` | REST file STT | ask human to repeat ("sorry, didn't catch that") |
| Sarvam **TTS** | streaming TTS | REST TTS | pre-recorded WAV fallback line |
| Sarvam **chat** | `sarvam-105b`/`30b` | retry w/ smaller model + lower tokens | safe scripted reply ("let me get the team to confirm") |
| Empty/garbled transcript | — | one short clarification, not silence | move on after 2 tries |
| **Twilio** stream drop | reconnect media stream | REST recording mode (`CALL_AGENT_TRANSPORT=record`) | end call gracefully + log for callback |
| **Meet join** fail | retry once | reload page + rejoin | exit non-zero, alert operator, log diagnostics to `.meet-diagnostics` |
| **Screenshare** fail | Playwright present | re-trigger present | continue audio-only demo, narrate screens |
| Meet **mic/audio route** missing | `AUDIO_STREAM_COMMAND` | caption-listen fallback (`MEET_CAPTION_LISTEN`) | text/operator input |
| **Barge-in** miss | VAD threshold | caption-event trigger | finish sentence, then yield |
| **Calendar/Gmail** API fail | create event + auto-invite | Gmail-only plain email with link | agent **says** the link/time aloud + flags manual follow-up |
| Email **capture** wrong | readback confirm | spell-back letter by letter | offer SMS link via Twilio as alternative |
| **Public URL** down | stable ngrok/VPS | health-check retry on boot | refuse to dial + clear error (no half-dead call) |
| Network blip | per-call retry w/ backoff | — | graceful degrade + log |

Cross-cutting:
- Centralized retry/backoff helper `src/util/retry.js` for all external calls.
- Startup **preflight** (`preflight.js`) extended to verify each box's required env + reachability before accepting a call / joining a Meet; fail fast with a clear message.
- All fallbacks emit structured logs via `logger.js`. No `catch {}` swallows.

## 8. Testing (TDD)

- Write tests first (RED → GREEN → refactor), keep the existing 52-test suite green.
- New unit tests: `emailCapture` normalization/readback, `bargeInController` state machine, `calendarLink` payload shape, `retry` backoff, preflight gating.
- Integration: call-agent text path (mock Sarvam), meet-agent intro + barge-in path (mock audio events).
- Manual E2E checklist per box (live call; live Meet join + screenshare + Q&A + barge-in).
- Target ≥80% on new modules.

## 9. Legal / disclosure note

Owner chose **fully human, no AI disclosure**. Outbound AI-voice disclosure is legally required in some jurisdictions (parts of US/EU/India guidelines). This is acceptable for demos to consenting prospects / the owner's own number. **Before broad client rollout, revisit per target region.** The `DISCLOSE_AI` flag makes this a one-line policy change.

## 10. Build sequence

1. Extract `src/persona/asha.js`; rewrite to human/no-disclosure/interest-led; female voice. (tests)
2. `src/util/retry.js` + extend `preflight.js`. (tests)
3. Box 1: wire persona + fallback matrix into call path; verify barge-in. (tests)
4. Box 1 optional: `emailCapture` + `calendarLink` + `auth:google`. (tests, gated)
5. Box 2: `bargeInController` + orchestrator wire-in + human intro. (tests)
6. Box 2: fallback matrix (join/screenshare/audio-route). 
7. Deploy prep: VM provisioning (Node/git/ffmpeg + Google login + audio route).
8. E2E per box; tune thresholds.
```
