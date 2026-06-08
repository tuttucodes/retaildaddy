# Custom WebRTC Demo Room Plan

This plan is for replacing the fragile Google Meet automation path with a first-party WebRTC room where the AI agent can listen, speak, and drive the product demo without depending on Google Meet UI state, VM display ratio, browser mic routing, or screen-share popups.

## Recommendation

Build a custom LiveKit room with a Pipecat voice agent using Sarvam STT, Sarvam LLM, and Sarvam TTS.

Use LiveKit for the meeting room, participant media, screen/video tracks, data messages, room tokens, and production-grade WebRTC. Use Pipecat for the real-time voice pipeline because Sarvam and Pipecat both document native Sarvam STT, TTS, and LLM services.

For the demo visual itself, prefer a synced product stage over OS-level screen sharing:

- The room page shows the product in a controlled stage area.
- The agent sends stage commands such as navigate, zoom, highlight, and focus over LiveKit data messages or the room backend websocket.
- Every participant sees the same demo state inside the room.
- No browser or OS screen-share picker is needed.

If the business requirement strictly says "publish a screen share track", LiveKit can publish screen tracks, but browsers still require a user prompt for real screen capture. The reliable automation path is therefore a shared stage, not a fake Google Meet screen share.

## Why This Is Easier Than Google Meet

Google Meet automation has external blockers:

- Google can block guest joins or require account login.
- The host may need to admit the bot.
- Meet buttons and layouts change.
- First-time screen-share permissions need human clicks.
- Chrome on Azure needs a visible display, the right resolution, and a virtual microphone.
- Audio output, client audio capture, and bot STT must be routed through PulseAudio without feedback.

The custom room removes most of that:

- The join URL is our app link, not a Google Meet link.
- The client grants mic permission in their own browser.
- The agent receives audio directly from the WebRTC room.
- The agent publishes audio directly as a room participant.
- The product stage is rendered by our app, so it is not clipped by a VM resolution.
- Confirmation can be enforced by app state instead of hoping Meet captured the right audio.

## Effort Comparison

| Path | Time to MVP | Reliability | Main Risks |
| --- | ---: | --- | --- |
| Continue Google Meet bot | 1-2 days for a demo VM, ongoing fixes | Medium-low | Google auth, host admission, screen picker, virtual mic, UI drift |
| Custom LiveKit room + Sarvam/Pipecat | 3-5 days for MVP | High | Building room UI, token service, agent worker, deployment |
| Custom self-hosted WebRTC without LiveKit | 1-2 weeks | Medium | SFU/TURN/signaling complexity, observability, browser edge cases |

Use Google Meet only as a temporary fallback. The production path should be the custom room.

## Target User Flow

1. Operator opens `/rooms/new` and gets a client link.
2. Client joins the link from laptop or phone.
3. Room asks for mic permission and shows the product stage.
4. Agent joins silently and continuously listens.
5. Agent waits for explicit confirmation:
   - Voice: "start intro", "start demo", "thudangam", "demo thudangikko".
   - UI: operator clicks `Start intro` or `Start demo`.
6. Agent gives a short Malayalam intro, then asks whether to begin the walkthrough.
7. After a second explicit confirmation, the agent starts the demo.
8. During the demo:
   - Agent speaks Malayalam using Sarvam TTS.
   - Product stage navigates, zooms, and highlights feature areas.
   - Client can interrupt naturally.
   - On interruption, agent pauses stage actions, answers, then resumes only after confirmation.
9. Transcript, stage events, questions, and latency metrics are stored for review.

## Architecture

```text
Client browser
  - LiveKit room UI
  - microphone track
  - product stage iframe/app shell
  - receives agent audio
  - receives stage commands

Room API
  - creates LiveKit room tokens
  - validates client/operator links
  - stores session state
  - exposes product config and demo script metadata

LiveKit Cloud or self-hosted LiveKit
  - WebRTC SFU
  - audio/video/data tracks
  - participant state

Pipecat agent worker
  - joins room as "RetailDaddy AI Demo Agent"
  - consumes client mic tracks
  - Sarvam STT: Malayalam/code-mixed speech to text
  - Sarvam LLM: demo brain and Q&A
  - Sarvam TTS: streaming Malayalam voice
  - emits stage commands and speech

Product stage controller
  - reuses demo JSON concepts: steps, say, action, highlight, zoom, keywords
  - sends navigate/highlight/zoom/focus events to the room UI
```

## Stack

Recommended MVP stack:

- Frontend: React or Next.js room UI.
- Room backend: Node 20 Express/Fastify token API, matching the current repo's Node baseline.
- Voice worker: Python Pipecat worker because Sarvam's documented Pipecat integration is Python.
- WebRTC: LiveKit Cloud first. Self-host LiveKit on Azure only after MVP.
- Product stage: iframe if product allows it, otherwise same-origin proxy route or a dedicated demo shell.
- State transport: LiveKit data messages for low-latency commands, with backend persistence for audit logs.

## Required Environment Variables

Current variables to keep:

```bash
SARVAM_API_KEY=
SARVAM_STT_MODEL=saaras:v3
SARVAM_STT_LANGUAGE_CODE=ml-IN
SARVAM_TTS_MODEL=bulbul:v3
SARVAM_TTS_LANGUAGE_CODE=ml-IN
SARVAM_TTS_SPEAKER=shubh
SARVAM_CHAT_MODEL=sarvam-105b
DEMO_SCRIPT_PATH=demo/demo-script.example.json
PRODUCT_KB_PATH=demo/product-knowledge.example.md
DISCLOSE_AI=true
```

New variables for the custom room:

```bash
LIVEKIT_URL=wss://your-livekit-host
LIVEKIT_API_KEY=
LIVEKIT_API_SECRET=
LIVEKIT_ROOM_PREFIX=retaildaddy-demo
ROOM_PUBLIC_BASE_URL=https://demo.retaildaddy.example
ROOM_TOKEN_TTL_SECONDS=7200
AGENT_NAME=RetailDaddy AI Demo Agent
AGENT_LANGUAGE=ml-IN
AGENT_WAIT_FOR_CONFIRMATION=true
DEMO_CONFIRMATION_PATTERN=start demo|start intro|go ahead|yes start|ok start|തുടങ്ങാം|ആരംഭിക്കൂ
PRODUCT_STAGE_URL=https://your-saas.example.com/demo
PRODUCT_STAGE_EMBED_ALLOWED=true
SESSION_STORE_URL=
```

Optional production variables:

```bash
LIVEKIT_REGION=india
TURN_DOMAIN=
RECORDING_ENABLED=false
TRANSCRIPT_STORE=postgres
AZURE_STORAGE_CONNECTION_STRING=
CUSTOM_ROOM_ALLOWED_ORIGINS=https://demo.retaildaddy.example
```

## Agent Behavior

The agent should use a strict state machine:

```text
IDLE_LISTENING
  waits silently for confirmation or operator command

INTRO_CONFIRMED
  speaks a short intro in Malayalam
  asks whether to start the product walkthrough

DEMO_READY
  waits for second confirmation

DEMO_RUNNING
  runs steps
  listens for interruptions

ANSWERING_QUESTION
  pauses stage
  answers using product knowledge
  optionally jumps to related step

RESUME_PENDING
  asks "shall I continue?"
  resumes only after confirmation

DONE
  closing statement and Q&A mode
```

This directly fixes the requirement: the agent always listens, but it does not start presenting or talking until it receives confirmation.

## Screen Share And Product Demo

Preferred "shared stage" implementation:

- The client room has a main `Stage` area.
- The stage renders the SaaS demo URL or a purpose-built demo shell.
- Agent commands are structured:

```json
{
  "type": "stage.command",
  "command": "focus_step",
  "stepId": "inventory",
  "route": "/inventory",
  "zoom": 1.15,
  "highlight": "[data-demo='inventory-table']"
}
```

- The browser executes the command locally:
  - navigate iframe/app route
  - apply CSS zoom
  - scroll target into view
  - draw highlight overlay
  - show captions/transcript if enabled

This is more reliable than screen share because the product view is part of the meeting page.

Fallback true screen share:

- Use LiveKit screen sharing from a browser when a human presenter clicks share.
- LiveKit's JavaScript SDK can publish screen share as a video track.
- Browser tab audio is possible only when the browser and selected source support it.
- This still requires a browser prompt, so it is not the best unattended bot path.

## Listening And Turn Taking

Use Pipecat WebRTC transport connected to LiveKit:

- `transport.input()` receives participant audio.
- Sarvam STT transcribes Malayalam/code-mixed speech.
- VAD and turn detection decide when the user stopped speaking.
- Interruption events pause Sarvam TTS and stop stage movement.
- The LLM receives transcript plus current stage state.
- Sarvam TTS streams the reply back through `transport.output()`.

For more natural voice:

- Use Sarvam TTS WebSocket service, not file-based TTS.
- Stream LLM text in short sentence chunks.
- Keep demo utterances short.
- Use a Malayalam prompt but allow English product names and UI labels.
- Log STT latency, LLM first-token latency, TTS first-audio latency, and interruption handling.

## Implementation Phases

### Phase 1: Proof Of Concept

Create:

- `custom-room/server`: token API and room creation.
- `custom-room/web`: room UI with LiveKit connect, mic button, stage, captions, and operator buttons.
- `custom-room/agent`: Pipecat worker using Sarvam STT, LLM, and TTS.

MVP acceptance:

- Client opens room URL and speaks Malayalam.
- Agent hears and transcribes.
- Agent stays silent until confirmation.
- Agent gives Malayalam intro after confirmation.
- Agent publishes audible speech in room.
- Agent can send one stage command to zoom/highlight a demo section.

### Phase 2: Full Demo Control

Add:

- Demo script loader compatible with existing `demo/*.json`.
- Product knowledge loader compatible with existing markdown.
- Step router based on keywords.
- Stage command schema and validation.
- Pause/resume on interruption.
- Operator controls: start, pause, resume, stop, force step, mute agent.

MVP acceptance:

- The existing Malayalam script can run through all steps.
- User question pauses the demo.
- Agent answers and asks whether to continue.
- Stage stays in sync for laptop and phone clients.

### Phase 3: Azure Deployment

Deploy:

- Web app and token API on Azure App Service, Azure Container Apps, or a small Ubuntu VM with Caddy/Nginx.
- Pipecat agent worker on the existing Azure VM or Azure Container Apps.
- LiveKit Cloud initially, using `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET`.
- Optional Postgres for sessions/transcripts.

Azure commands outline:

```bash
az group create -n retaildaddy-agent-rg -l centralindia
az containerapp env create -g retaildaddy-agent-rg -n retaildaddy-env -l centralindia
az containerapp create -g retaildaddy-agent-rg -n retaildaddy-room-api --environment retaildaddy-env --image <room-api-image>
az containerapp create -g retaildaddy-agent-rg -n retaildaddy-agent-worker --environment retaildaddy-env --image <agent-image>
```

For the existing VM path:

```bash
git pull
python -m venv .venv
. .venv/bin/activate
pip install "pipecat-ai[sarvam]"
npm install
```

Use systemd services:

- `retaildaddy-room-api.service`
- `retaildaddy-agent-worker.service`

Keep secrets in `/etc/retaildaddy-room.env` with `chmod 600`.

### Phase 4: Production Hardening

Add:

- Invite links with expiry.
- Operator-only controls.
- Explicit AI disclosure at session start.
- Session transcript export.
- Recording only with user consent.
- Rate limits and per-room Sarvam usage tracking.
- Health checks for Sarvam, LiveKit, and agent worker.
- E2E tests for room join, mic publish, agent audio, stage command delivery, and resume confirmation.

## Self-Hosted LiveKit On Azure

Use LiveKit Cloud for MVP. Self-hosting adds networking work:

- Public DNS and TLS.
- LiveKit server.
- Redis.
- TURN service.
- UDP/TCP firewall rules.
- Egress service if recording is needed.

Self-host only if cost, data residency, or control requirements justify it.

## Open Questions

- Can the SaaS product be embedded in an iframe? If not, build a demo shell or allowlist the room domain in `frame-ancestors`.
- Should clients join from public internet or only authenticated invite links?
- Do we need recording, and has consent language been approved?
- Should the agent be allowed to answer pricing/contracts, or should those route to a human?
- Which Malayalam voice sounds best for RetailDaddy after live testing?

## Source Docs Checked

- Sarvam Pipecat voice agent guide: https://docs.sarvam.ai/api-reference-docs/integration/integration-guides/build-voice-agent-with-pipecat
- Sarvam TTS REST stream: https://docs.sarvam.ai/api-reference-docs/text-to-speech/convert-stream
- Sarvam TTS WebSocket: https://docs.sarvam.ai/api-reference-docs/text-to-speech/stream
- Pipecat Sarvam STT: https://docs.pipecat.ai/api-reference/server/services/stt/sarvam
- Pipecat Sarvam TTS: https://docs.pipecat.ai/api-reference/server/services/tts/sarvam
- Pipecat Sarvam LLM: https://docs.pipecat.ai/api-reference/server/services/llm/sarvam
- Pipecat transports: https://docs.pipecat.ai/pipecat/learn/transports
- Pipecat LiveKit runner utilities: https://docs.pipecat.ai/api-reference/server/utilities/runner/transport-utils
- LiveKit voice AI quickstart: https://docs.livekit.io/agents/start/voice-ai/
- LiveKit screen sharing: https://docs.livekit.io/transport/media/screenshare/
