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
