# RetailDaddy Meet Demo Agent

This project implements an AI sales-demo agent that can:

- join a Google Meet using an authenticated Chrome profile
- speak demo narration through Sarvam Text to Speech
- transcribe client questions from live audio chunks through Sarvam Speech to Text
- answer questions with Sarvam chat completions and your product knowledge file
- control a separate browser tab for your SaaS product, including click/fill/wait/zoom/highlight steps

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

Then edit [demo/demo-script.example.json](/Volumes/T7/retaildaddy/demo/demo-script.example.json) and [demo/product-knowledge.example.md](/Volumes/T7/retaildaddy/demo/product-knowledge.example.md) for your actual product.

Check readiness:

```bash
npm run agent -- doctor launch
```

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

5. After the scripted demo, the terminal stays in Q&A mode. With `--listen-audio`, it also starts `AUDIO_CAPTURE_COMMAND` and watches `recordings/` for stable audio chunks:

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

## Sarvam API Notes

This scaffold uses current Sarvam REST endpoints:

- STT: `POST https://api.sarvam.ai/speech-to-text` with `api-subscription-key`
- TTS stream: `POST https://api.sarvam.ai/text-to-speech/stream` with `api-subscription-key`
- Chat: `POST https://api.sarvam.ai/v1/chat/completions` with `api-subscription-key`

The Sarvam docs checked on 2026-06-08 show STT model options including `saarika:v2.5` and `saaras:v3`, TTS model options including `bulbul:v2` and `bulbul:v3`, and chat models including `sarvam-30b` and `sarvam-105b`.
