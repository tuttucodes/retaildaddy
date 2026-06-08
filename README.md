# RetailDaddy Meet Demo Agent

This project implements an AI sales-demo agent that can:

- join a Google Meet using an authenticated Chrome profile
- speak demo narration through Sarvam Text to Speech
- transcribe client questions from live audio chunks through Sarvam Speech to Text
- answer questions with Sarvam chat completions and your product knowledge file
- control a separate browser tab for your SaaS product, including click/fill/wait/zoom/highlight steps
- run a Sarvam-powered AI calling agent with text/audio call turns, voice replies, summaries, and webhook-friendly APIs

The agent identifies itself as an AI assistant by default. Keep that enabled for client calls.

## What Is Automated

The agent can open Meet, join with a persistent Google profile, open your product, attempt automatic presentation, run the scripted demo, zoom/focus features, synthesize speech, transcribe client audio chunks, and answer questions.

Screen sharing and live meeting audio require OS/browser permissions:

- Google Meet may require manual approval, account login, or admitting the bot.
- Chrome can usually auto-select a capture source after permissions are settled, but the Meet UI and OS permission prompts can still require a first-time human click.
- TTS audio must be routed into Meet through a virtual microphone. On macOS, use BlackHole or Loopback and select it as Meet's microphone.
- Capturing client audio from Meet also needs a virtual/loopback audio route. The included `listen-audio` mode transcribes dropped audio files reliably, and you can extend it with an `ffmpeg` segmenting command for live capture.

## Setup

```bash
npm install
npx playwright install chromium
cp .env.example .env
```

Edit `.env`:

- `SARVAM_API_KEY`: your Sarvam key
- `PRODUCT_URL`: your SaaS product URL
- `GOOGLE_MEET_URL`: the meeting URL for live mode
- `DEMO_SCRIPT_PATH`: the JSON demo script
- `PRODUCT_KB_PATH`: your product knowledge markdown
- `AUDIO_CAPTURE_COMMAND`: required for full live Q&A. See [docs/AUDIO_ROUTING.md](/Volumes/T7/retaildaddy/docs/AUDIO_ROUTING.md).
- `BROWSER_CHANNEL=chrome`: recommended on Azure/Linux so Meet runs in installed Google Chrome.
- `MEET_SAVE_DIAGNOSTICS=true`: saves screenshots, button labels, and media-device checks under `.meet-diagnostics/`.

Then edit [demo/demo-script.example.json](/Volumes/T7/retaildaddy/demo/demo-script.example.json) and [demo/product-knowledge.example.md](/Volumes/T7/retaildaddy/demo/product-knowledge.example.md) for your actual product.

Check readiness:

```bash
npm run agent -- doctor launch
```

## Run

- **Voice Call Agent:** `npm run dial -- +91XXXXXXXXXX "Name"`
- **Meet Demo Agent:** `GOOGLE_MEET_URL="<link>" npm run launch`

See [docs/DEPLOY.md](docs/DEPLOY.md) for the full two-box runbook and fallback verification.

## Run A Rehearsal

This runs the demo without joining Meet:

```bash
npm run rehearse
```

Ask a typed question:

```bash
npm run agent -- ask "How does inventory sync work?"
```

Test Sarvam TTS:

```bash
npm run agent -- tts "Hello. I am the RetailDaddy AI demo assistant."
```

Transcribe an audio file:

```bash
npm run agent -- stt ./recordings/question.wav
```

## Run In Google Meet

1. Start Chrome profile setup:

   ```bash
   npm run agent -- auth
   ```

2. Sign in to Google in the opened browser, then close it.

3. Start the live demo from a link:

   ```bash
   npm run agent -- launch "https://meet.google.com/xxx-yyyy-zzz" --listen-audio
   ```

   Or override the product URL for that run:

   ```bash
   npm run agent -- launch "https://meet.google.com/xxx-yyyy-zzz" --product "https://your-app.example.com"
   ```

4. If Meet does not start presentation automatically on the first run, manually click screen share and choose the tab/window named `RetailDaddy Agent Stage`, then keep `MEET_AUTO_PRESENT=true` for later runs.

5. If Meet says no microphone was found, check the latest `.meet-diagnostics/*.json` file. It records whether Chrome could open `getUserMedia({ audio: true })` and which audio input devices Meet could see.

6. If automatic presentation does not confirm, check the latest `.meet-diagnostics/*.png` screenshot and set `DESKTOP_CAPTURE_SOURCE` to the exact capture label shown by Chrome/Meet, commonly `Entire screen`, `Screen 1`, or `RetailDaddy Agent Stage`.

7. After the scripted demo, the terminal stays in Q&A mode. With `--listen-audio`, it also starts `AUDIO_CAPTURE_COMMAND` and watches `recordings/` for stable audio chunks:

   ```bash
   npm run agent -- launch "https://meet.google.com/xxx-yyyy-zzz" --listen-audio
   ```

## Audio Routing For A Real Call

For macOS:

1. Install a virtual audio device such as BlackHole 2ch.
2. Route system output used by `afplay` into that device.
3. In Google Meet, select the virtual device as the microphone.
4. For client audio capture, use a separate monitor/loopback route and drop chunks into `recordings/`, or set up ffmpeg segmentation externally.

The Azure wrapper configures this automatically with separate PulseAudio sinks for the agent microphone and Meet speaker capture:

```bash
scripts/setup-azure-vm.sh
scripts/run-agent-azure.sh auth
scripts/run-agent-azure.sh launch "https://meet.google.com/xxx-yyyy-zzz"
```

## Commands

```bash
npm run agent -- auth
npm run agent -- doctor launch
npm run agent -- launch "https://meet.google.com/xxx-yyyy-zzz" --listen-audio
npm run rehearse
npm run demo
npm run agent -- ask "question"
npm run agent -- stt path/to/audio.wav
npm run agent -- tts "text"
npm run agent -- listen-audio
```

## Run The Calling Agent

This is the Omnidimension-style path in this repo: Sarvam handles STT, LLM, TTS, and post-call
analysis, while this app provides call sessions and webhook-style endpoints. Add Exotel, Twilio,
WhatsApp Business Calling, or another telephony layer in front of these endpoints for real phone
numbers.

```bash
npm run calling-agent
```

Open `http://localhost:4180` to use the browser call simulator. It can start a call, send typed
caller turns, record microphone audio, play Sarvam voice responses, and generate a CRM handoff
summary.

To make the agent call a real phone number with Twilio, set:

```bash
CALL_PUBLIC_BASE_URL=https://your-public-callback-url.example.com
CALL_PROVIDER=twilio
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
# or use API key auth:
TWILIO_API_KEY_SID=...
TWILIO_API_KEY_SECRET=...
TWILIO_FROM_NUMBER=+1...
```

`CALL_PUBLIC_BASE_URL` must be a public HTTPS URL that reaches this server because Twilio has to
POST to `/twilio/voice`, `/twilio/recording`, and `/twilio/status`. A localhost URL will not work
unless you expose it through a tunnel or deploy the server.

Then dial a phone number:

```bash
npm run dial -- +919074417293 "Rahul"
```

If the calling-agent server is already running, this command uses it. If not, it starts the server,
places the call, and keeps running so Twilio can send recording callbacks back to the Sarvam agent.

Core endpoints:

```bash
POST /api/calls                 # create inbound/outbound call session
POST /api/outbound-call         # place a real outbound Twilio call
POST /api/calls/:id/text        # send caller text, receive answer + TTS audio URL
POST /api/calls/:id/audio       # send caller audio blob, receive transcript + answer + audio URL
POST /api/calls/:id/summary     # generate call summary
POST /api/calls/:id/end         # close call session
GET  /api/calls/:id             # inspect public call state
GET  /audio/:file               # play generated TTS audio
POST /twilio/voice              # Twilio webhook: initial prompt + record
POST /twilio/recording          # Twilio webhook: recording -> Sarvam -> next prompt
POST /twilio/status             # Twilio webhook: call status updates
```

## Sarvam API Notes

This scaffold uses current Sarvam REST endpoints:

- STT: `POST https://api.sarvam.ai/speech-to-text` with `api-subscription-key`
- TTS stream: `POST https://api.sarvam.ai/text-to-speech/stream` with `api-subscription-key`
- Chat: `POST https://api.sarvam.ai/v1/chat/completions` with `api-subscription-key`
- Call analytics: `POST https://api.sarvam.ai/call-analytics` with `api-subscription-key`

The Sarvam docs checked on 2026-06-08 show STT model options including `saarika:v2.5` and `saaras:v3`, TTS model options including `bulbul:v2` and `bulbul:v3`, and chat models including `sarvam-30b` and `sarvam-105b`.
