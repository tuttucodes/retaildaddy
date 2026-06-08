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
