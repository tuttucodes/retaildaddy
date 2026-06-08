#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_PREFIX="[retaildaddy-azure-run]"
COMMAND="${1:-demo}"
ENV_FILE="${ENV_FILE:-$PROJECT_DIR/.env}"
DISPLAY="${DISPLAY:-:99}"
XVFB_SCREEN="${XVFB_SCREEN:-0}"
XVFB_RESOLUTION="${XVFB_RESOLUTION:-1440x960x24}"
XVFB_LOG="${XVFB_LOG:-/tmp/retaildaddy-xvfb.log}"
PULSE_LOG="${PULSE_LOG:-/tmp/retaildaddy-pulseaudio.log}"
PULSE_MIC_SINK_NAME="${PULSE_MIC_SINK_NAME:-retaildaddy_agent_mic_sink}"
PULSE_MEET_SINK_NAME="${PULSE_MEET_SINK_NAME:-retaildaddy_meet_speaker_sink}"

log() {
  printf '%s %s\n' "$LOG_PREFIX" "$*"
}

warn() {
  printf '%s WARN: %s\n' "$LOG_PREFIX" "$*" >&2
}

die() {
  printf '%s ERROR: %s\n' "$LOG_PREFIX" "$*" >&2
  exit 1
}

usage() {
  cat <<EOF
Usage:
  scripts/run-agent-azure.sh [demo|launch|auth|rehearse|listen-audio|ask|stt|tts] [agent args...]

Examples:
  scripts/run-agent-azure.sh auth
  GOOGLE_MEET_URL="https://meet.google.com/xxx-yyyy-zzz" PRODUCT_URL="https://app.example.com" scripts/run-agent-azure.sh demo
  scripts/run-agent-azure.sh launch "https://meet.google.com/xxx-yyyy-zzz"
  scripts/run-agent-azure.sh ask "How does inventory sync work?"

Environment:
  ENV_FILE                 Defaults to $PROJECT_DIR/.env
  SARVAM_API_KEY           Required for demo, rehearse, ask, stt, tts, and listen-audio
  PRODUCT_URL              Required for live product demo
  GOOGLE_MEET_URL          Required for demo
  DISPLAY                  Defaults to :99
  XVFB_RESOLUTION          Defaults to 1440x960x24
  MEET_AUTO_PRESENT        Defaults to true in this Azure wrapper
  DESKTOP_CAPTURE_SOURCE   Defaults to "Entire screen" in this Azure wrapper
  PULSE_MIC_SINK_NAME      Defaults to retaildaddy_agent_mic_sink
  PULSE_MEET_SINK_NAME     Defaults to retaildaddy_meet_speaker_sink
EOF
}

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

load_env_file() {
  local file="$1"
  if [[ ! -f "$file" ]]; then
    log "No env file found at $file. Using exported environment only."
    return
  fi

  log "Loading environment defaults from $file."
  local line key value
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="$(trim "$line")"
    [[ -z "$line" || "${line:0:1}" == "#" || "$line" != *"="* ]] && continue

    key="$(trim "${line%%=*}")"
    value="$(trim "${line#*=}")"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue

    if [[ ( "${value:0:1}" == '"' && "${value: -1}" == '"' ) || ( "${value:0:1}" == "'" && "${value: -1}" == "'" ) ]]; then
      value="${value:1:${#value}-2}"
    fi

    if [[ -z "${!key+x}" ]]; then
      export "$key=$value"
    fi
  done < "$file"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required. Run scripts/setup-azure-vm.sh first."
}

wait_for_display() {
  local attempts=20
  for ((i = 1; i <= attempts; i++)); do
    if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
  done
  return 1
}

start_xvfb() {
  require_command Xvfb
  require_command xdpyinfo

  export DISPLAY
  if wait_for_display; then
    log "Using existing X display $DISPLAY."
    return
  fi

  log "Starting Xvfb on $DISPLAY with screen $XVFB_SCREEN at $XVFB_RESOLUTION."
  Xvfb "$DISPLAY" -screen "$XVFB_SCREEN" "$XVFB_RESOLUTION" -ac +extension RANDR >"$XVFB_LOG" 2>&1 &
  export RETAILDADDY_XVFB_PID="$!"

  if ! wait_for_display; then
    warn "Xvfb log:"
    tail -n 40 "$XVFB_LOG" >&2 || true
    die "Xvfb did not become ready on $DISPLAY."
  fi

  log "Xvfb is ready. Log: $XVFB_LOG"
}

start_pulseaudio() {
  require_command pulseaudio
  require_command pactl

  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/retaildaddy-runtime-${UID}}"
  mkdir -p "$XDG_RUNTIME_DIR"
  chmod 700 "$XDG_RUNTIME_DIR"

  if pulseaudio --check >/dev/null 2>&1; then
    log "PulseAudio is already running."
  else
    log "Starting PulseAudio with idle timeout disabled."
    pulseaudio --daemonize=yes --exit-idle-time=-1 --log-target="file:$PULSE_LOG"
  fi

  local attempts=20
  for ((i = 1; i <= attempts; i++)); do
    if pactl info >/dev/null 2>&1; then
      break
    fi
    sleep 0.25
  done

  if ! pactl info >/dev/null 2>&1; then
    warn "PulseAudio log:"
    tail -n 60 "$PULSE_LOG" >&2 || true
    die "PulseAudio did not become ready."
  fi

  if pactl list short sinks | awk '{print $2}' | grep -Fxq "$PULSE_MIC_SINK_NAME"; then
    log "PulseAudio virtual mic sink '$PULSE_MIC_SINK_NAME' already exists."
  else
    log "Creating PulseAudio virtual mic sink '$PULSE_MIC_SINK_NAME'."
    pactl load-module module-null-sink \
      "sink_name=$PULSE_MIC_SINK_NAME" \
      "sink_properties=device.description=RetailDaddy_Agent_Mic" >/dev/null
  fi

  if pactl list short sinks | awk '{print $2}' | grep -Fxq "$PULSE_MEET_SINK_NAME"; then
    log "PulseAudio Meet speaker sink '$PULSE_MEET_SINK_NAME' already exists."
  else
    log "Creating PulseAudio Meet speaker sink '$PULSE_MEET_SINK_NAME'."
    pactl load-module module-null-sink \
      "sink_name=$PULSE_MEET_SINK_NAME" \
      "sink_properties=device.description=RetailDaddy_Meet_Speaker" >/dev/null
  fi

  pactl set-default-sink "$PULSE_MEET_SINK_NAME"
  pactl set-default-source "$PULSE_MIC_SINK_NAME.monitor"
  export PULSE_SOURCE="${PULSE_SOURCE:-$PULSE_MEET_SINK_NAME.monitor}"
  export AUDIO_PLAY_COMMAND="${AUDIO_PLAY_COMMAND:-env PULSE_SINK=$PULSE_MIC_SINK_NAME ffplay -nodisp -autoexit -loglevel quiet}"
  export AUDIO_AUTO_LISTEN="${AUDIO_AUTO_LISTEN:-true}"
  export AUDIO_CAPTURE_COMMAND="${AUDIO_CAPTURE_COMMAND:-ffmpeg -hide_banner -nostdin -f pulse -i $PULSE_MEET_SINK_NAME.monitor -ac 1 -ar 16000 -f segment -segment_time 8 -reset_timestamps 1 \$AUDIO_INPUT_DIR/question-%04d.wav}"
  log "Chrome speaker sink: '$PULSE_MEET_SINK_NAME'."
  log "Chrome microphone source: '$PULSE_MIC_SINK_NAME.monitor'."
  log "TTS playback command sends audio into '$PULSE_MIC_SINK_NAME'."
  log "STT capture command records from '$PULSE_MEET_SINK_NAME.monitor'."
}

validate_environment() {
  case "$COMMAND" in
    help|-h|--help)
      usage
      exit 0
      ;;
    demo)
      [[ -n "${SARVAM_API_KEY:-}" ]] || die "SARVAM_API_KEY is required. Export it or set it in $ENV_FILE."
      [[ -n "${PRODUCT_URL:-}" ]] || die "PRODUCT_URL is required. Export it or set it in $ENV_FILE."
      [[ -n "${GOOGLE_MEET_URL:-}" ]] || die "GOOGLE_MEET_URL is required. Export it or set it in $ENV_FILE."
      ;;
    launch)
      [[ -n "${SARVAM_API_KEY:-}" ]] || die "SARVAM_API_KEY is required. Export it or set it in $ENV_FILE."
      [[ -n "${PRODUCT_URL:-}" ]] || die "PRODUCT_URL is required. Export it or set it in $ENV_FILE."
      ;;
    rehearse|ask|stt|tts|listen-audio)
      [[ -n "${SARVAM_API_KEY:-}" ]] || die "SARVAM_API_KEY is required. Export it or set it in $ENV_FILE."
      ;;
    auth)
      ;;
    *)
      die "Unknown command '$COMMAND'. Run scripts/run-agent-azure.sh --help."
      ;;
  esac
}

run_agent() {
  cd "$PROJECT_DIR"
  require_command npm

  export HEADLESS="${HEADLESS:-false}"
  export DESKTOP_CAPTURE_SOURCE="${DESKTOP_CAPTURE_SOURCE:-Entire screen}"
  export AGENT_STAGE_TITLE="${AGENT_STAGE_TITLE:-RetailDaddy Agent Stage}"
  export MEET_AUTO_PRESENT="${MEET_AUTO_PRESENT:-true}"

  mkdir -p "${AUDIO_OUT_DIR:-$PROJECT_DIR/audio-out}" "${AUDIO_INPUT_DIR:-$PROJECT_DIR/recordings}"

  log "Running agent command '$COMMAND' on DISPLAY=$DISPLAY."
  case "$COMMAND" in
    demo)
      npm run agent -- launch "$GOOGLE_MEET_URL" --listen-audio
      ;;
    launch)
      shift || true
      if [[ "$#" -eq 0 ]]; then
        [[ -n "${GOOGLE_MEET_URL:-}" ]] || die "Pass a Meet link or set GOOGLE_MEET_URL before running launch."
        set -- "$GOOGLE_MEET_URL"
      fi
      npm run agent -- launch "$@" --listen-audio
      ;;
    rehearse)
      npm run rehearse
      ;;
    auth|ask|stt|tts|listen-audio)
      shift || true
      npm run agent -- "$COMMAND" "$@"
      ;;
  esac
}

main() {
  if [[ "$COMMAND" == "help" || "$COMMAND" == "-h" || "$COMMAND" == "--help" ]]; then
    usage
    exit 0
  fi

  load_env_file "$ENV_FILE"
  validate_environment
  start_xvfb
  start_pulseaudio
  run_agent "$@"
}

main "$@"
