# Azure VM Runbook

This runbook is for running the existing Node/Playwright Google Meet demo agent on an Ubuntu Azure VM. It keeps secrets outside scripts and uses Xvfb plus PulseAudio so Chromium has a virtual display and microphone/audio route.

## VM Baseline

Use Ubuntu 22.04 LTS or 24.04 LTS on an x64 Azure VM. Start with at least 2 vCPU and 4 GB RAM for Chrome/Chromium. A larger VM helps if your SaaS product is heavy.

Open only the management ports you need, preferably SSH restricted to your IP. The Meet URL, Sarvam key, and product credentials should live in environment variables or a local `.env` file, not in Git.

## Install

On the VM:

```bash
sudo apt-get update
sudo apt-get install -y git ca-certificates curl
git clone https://github.com/tuttucodes/retaildaddy.git
cd retaildaddy
chmod +x scripts/setup-azure-vm.sh scripts/run-agent-azure.sh
scripts/setup-azure-vm.sh
```

The setup script is idempotent. It installs Node.js 20 when needed, project dependencies, Playwright Chromium, browser dependencies, Google Chrome where supported, Xvfb, PulseAudio utilities, fonts, and ffmpeg.

## Environment

Create `.env` on the VM or export the variables before running the wrapper:

```bash
SARVAM_API_KEY=your_sarvam_key
PRODUCT_URL=https://your-saas.example.com
GOOGLE_MEET_URL=https://meet.google.com/xxx-yyyy-zzz

# Optional but useful on Azure:
MEET_DISPLAY_NAME=RetailDaddy AI Demo Agent
MEET_AUTO_PRESENT=true
DESKTOP_CAPTURE_SOURCE=Entire screen
HEADLESS=false
```

Do not hardcode `SARVAM_API_KEY` in scripts. If you store `.env` on the VM, keep it out of Git and restrict file permissions:

```bash
chmod 600 .env
```

## First Google Login

Authenticate the Google account once in the persistent Playwright profile:

```bash
scripts/run-agent-azure.sh auth
```

If you are connected over SSH without a visible desktop, use a remote desktop session, X11 forwarding, or a temporary browser/VNC workflow to complete the Google sign-in on the VM display. After login, stop the process with `Ctrl+C`; the profile is stored in `playwright-profile` by default.

## Run A Demo

Set the Meet URL and product URL in `.env`, then run:

```bash
scripts/run-agent-azure.sh demo
```

The wrapper starts or reuses:

- `Xvfb` on `DISPLAY=:99`
- PulseAudio with a virtual mic sink named `retaildaddy_agent_mic_sink`
- PulseAudio with a Meet speaker/capture sink named `retaildaddy_meet_speaker_sink`
- `ffplay` for Sarvam TTS playback into the virtual mic sink
- `ffmpeg` segment capture from the Meet speaker sink into `recordings/`

Chrome uses `retaildaddy_agent_mic_sink.monitor` as the default microphone source, while Meet speaker output goes to `retaildaddy_meet_speaker_sink`. The capture command records `retaildaddy_meet_speaker_sink.monitor`, so Sarvam STT hears the client side instead of the agent's own TTS.

## Screen Sharing

For the full automatic path:

```bash
scripts/run-agent-azure.sh launch "https://meet.google.com/xxx-yyyy-zzz"
```

For a first-time permission check, you can still manually present:

```bash
scripts/run-agent-azure.sh launch "https://meet.google.com/xxx-yyyy-zzz" --manual-present
```

Chrome capture-source labels vary by distro, Chrome version, and Meet UI. If auto-present does not select a source, try `DESKTOP_CAPTURE_SOURCE="Screen 1"` or `DESKTOP_CAPTURE_SOURCE="Entire screen"`.

## Useful Commands

Run without Meet:

```bash
scripts/run-agent-azure.sh rehearse
```

Ask a typed question:

```bash
scripts/run-agent-azure.sh ask "How does RetailDaddy handle inventory sync?"
```

Test Sarvam TTS through the VM audio route:

```bash
scripts/run-agent-azure.sh tts "Hello, I am the RetailDaddy demo assistant."
```

Transcribe a file:

```bash
scripts/run-agent-azure.sh stt recordings/question.wav
```

Watch for dropped audio files:

```bash
scripts/run-agent-azure.sh listen-audio
```

Run preflight:

```bash
npm run agent -- doctor launch
```

## Troubleshooting

Check the virtual display:

```bash
DISPLAY=:99 xdpyinfo | head
```

Check audio:

```bash
pactl info
pactl list short sinks
pactl list short sources
```

Logs:

```bash
tail -n 100 /tmp/retaildaddy-xvfb.log
tail -n 100 /tmp/retaildaddy-pulseaudio.log
```

If Chrome shows a blank screen or Meet cannot use devices, confirm the VM has enough memory, run `scripts/setup-azure-vm.sh` again, and test `scripts/run-agent-azure.sh auth` before a live call.
