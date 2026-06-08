# Audio Routing

This project handles speech in two separate directions:

- Agent voice out: Sarvam TTS writes a WAV file, then `AUDIO_PLAY_COMMAND` or the platform default player plays it.
- Client questions in: an optional recorder command writes short audio chunks into `AUDIO_INPUT_DIR`, and the existing audio inbox sends new files to Sarvam STT.

`src/audioCapture.js` is the dependency-free helper for the second direction. It starts `AUDIO_CAPTURE_COMMAND` without a shell, creates `AUDIO_INPUT_DIR`, exposes `AUDIO_INPUT_DIR` to the child process environment, expands `$AUDIO_INPUT_DIR` and `${AUDIO_INPUT_DIR}` inside command arguments, and logs start, stdout/stderr, exit, and stop events.

Complex pipelines should live in a small script, then `AUDIO_CAPTURE_COMMAND` should point at that script. Direct commands are safer and easier to stop cleanly.

## Agent Integration

The agent supports file-based questions through:

```bash
npm run agent -- listen-audio
```

The Meet launch flow now starts `AUDIO_CAPTURE_COMMAND` automatically when you pass `--listen-audio`, set `AUDIO_AUTO_LISTEN=true`, or provide `AUDIO_CAPTURE_COMMAND` in live mode. Audio files are processed only after the file size stabilizes, which avoids sending partially written ffmpeg segments to Sarvam STT.

## Command Contract

The recorder must write complete audio files into `AUDIO_INPUT_DIR`. WAV mono at 16 kHz is a safe default for STT:

```bash
AUDIO_INPUT_DIR=recordings
AUDIO_CAPTURE_COMMAND='ffmpeg -hide_banner -nostdin -loglevel warning -f pulse -i rd_meet_out.monitor -ac 1 -ar 16000 -f segment -segment_time 8 -strftime 1 "${AUDIO_INPUT_DIR}/question-%Y%m%d-%H%M%S.wav"'
```

Use segment lengths of 6 to 10 seconds for live Q&A. Shorter chunks feel more responsive but may split questions. Longer chunks reduce partial transcripts but add delay.

## macOS With BlackHole

Use this when you want a free, simple loopback device.

1. Install BlackHole 2ch.
2. Open Audio MIDI Setup and create any monitoring setup you need, such as a Multi-Output Device for speakers plus BlackHole.
3. In Google Meet settings, choose the virtual input that receives the agent TTS audio.
4. Route Meet/client audio to the device you want to record. Avoid routing the agent TTS back into the same capture device or Sarvam STT will hear the agent answering itself.
5. List ffmpeg avfoundation devices:

```bash
ffmpeg -f avfoundation -list_devices true -i ""
```

Example capture command for a BlackHole audio device:

```bash
AUDIO_INPUT_DIR=recordings
AUDIO_CAPTURE_COMMAND='ffmpeg -hide_banner -nostdin -loglevel warning -f avfoundation -i ":BlackHole 2ch" -ac 1 -ar 16000 -f segment -segment_time 8 -strftime 1 "${AUDIO_INPUT_DIR}/question-%Y%m%d-%H%M%S.wav"'
```

For TTS into Meet, either set the system output used by `afplay` to BlackHole before launching the agent, or use Loopback for per-app routing.

## macOS With Loopback

Loopback is easier for real calls because it can separate sources by app.

Recommended devices:

- `RetailDaddy Agent Mic`: receives audio from the TTS player. Select this as the Google Meet microphone.
- `RetailDaddy Meet Capture`: receives Google Meet output/client audio. Record this device with ffmpeg.

Example:

```bash
AUDIO_INPUT_DIR=recordings
AUDIO_CAPTURE_COMMAND='ffmpeg -hide_banner -nostdin -loglevel warning -f avfoundation -i ":RetailDaddy Meet Capture" -ac 1 -ar 16000 -f segment -segment_time 8 -strftime 1 "${AUDIO_INPUT_DIR}/question-%Y%m%d-%H%M%S.wav"'
```

Keep the agent microphone route and the Meet capture route separate. That is the main difference between a usable demo agent and an audio feedback loop.

## Azure Linux With PulseAudio And ffmpeg

On an Azure VM, use PulseAudio null sinks as virtual devices. This works best on a desktop-enabled VM or an Xvfb session where Chromium can access PulseAudio.

Install basics:

```bash
sudo apt-get update
sudo apt-get install -y pulseaudio pulseaudio-utils ffmpeg
pulseaudio --start
```

Create two virtual sinks:

```bash
pactl load-module module-null-sink sink_name=rd_tts sink_properties=device.description=RetailDaddy_TTS
pactl load-module module-null-sink sink_name=rd_meet_out sink_properties=device.description=RetailDaddy_Meet_Output
```

Use the monitor of `rd_tts` as the Google Meet microphone. Route Chromium/Meet speaker output to `rd_meet_out`, then record the monitor of that sink:

```bash
AUDIO_INPUT_DIR=recordings
AUDIO_CAPTURE_COMMAND='ffmpeg -hide_banner -nostdin -loglevel warning -f pulse -i rd_meet_out.monitor -ac 1 -ar 16000 -f segment -segment_time 8 -strftime 1 "${AUDIO_INPUT_DIR}/question-%Y%m%d-%H%M%S.wav"'
```

To send Sarvam TTS playback into the Meet microphone sink while keeping browser output on the capture sink:

```bash
pactl set-default-sink rd_meet_out
AUDIO_PLAY_COMMAND='env PULSE_SINK=rd_tts ffplay -nodisp -autoexit -loglevel quiet'
```

Then choose `Monitor of RetailDaddy_TTS` as the Meet microphone. If Meet does not expose it, open Chrome's site settings and grant microphone access, then rejoin the meeting.

## Operational Checks

Before a client call:

1. Run the capture command alone and confirm new WAV files appear in `AUDIO_INPUT_DIR`.
2. Run `npm run agent -- stt path/to/chunk.wav` on one captured file.
3. Run `npm run agent -- tts "Audio route check."` and confirm Meet receives the audio.
4. Join a test Meet from another device and verify the capture route records only the other participant, not the agent's own TTS.

If STT repeats the agent's answers, your TTS output is leaking into the capture route. Split the virtual devices and test again.
