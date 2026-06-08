const state = {
  clientId: crypto.randomUUID(),
  name: "",
  phone: "",
  localStream: null,
  cameraTrack: null,
  screenTrack: null,
  eventSource: null,
  peers: new Map(),
  participants: new Map(),
  answerIds: new Set(),
  micEnabled: true,
  camEnabled: true,
  aiSpeaking: false,
  recording: false,
  recorder: null,
  chunks: [],
  analyser: null,
  vadTimer: null,
  speechStartedAt: 0,
  lastVoiceAt: 0
};

const els = {
  joinDialog: document.getElementById("joinDialog"),
  joinForm: document.getElementById("joinForm"),
  joinName: document.getElementById("joinName"),
  joinPhone: document.getElementById("joinPhone"),
  roomStatus: document.getElementById("roomStatus"),
  latencyChip: document.getElementById("latencyChip"),
  screenStage: document.getElementById("screenStage"),
  stageEmpty: document.getElementById("stageEmpty"),
  participantList: document.getElementById("participantList"),
  aiTile: document.getElementById("aiTile"),
  aiName: document.getElementById("aiName"),
  aiPhone: document.getElementById("aiPhone"),
  aiState: document.getElementById("aiState"),
  micBtn: document.getElementById("micBtn"),
  camBtn: document.getElementById("camBtn"),
  shareBtn: document.getElementById("shareBtn"),
  leaveBtn: document.getElementById("leaveBtn"),
  chatToggle: document.getElementById("chatToggle"),
  transcriptPanel: document.getElementById("transcriptPanel"),
  messages: document.getElementById("messages"),
  askForm: document.getElementById("askForm"),
  textQuestion: document.getElementById("textQuestion"),
  recordingState: document.getElementById("recordingState")
};

function setStatus(text) {
  els.roomStatus.textContent = text;
}

function setRecordingState(text) {
  els.recordingState.textContent = text;
}

function addMessage(role, text, meta = "") {
  const message = document.createElement("article");
  message.className = `message ${role}`;
  message.innerHTML = `
    <div class="meta">${meta || (role === "agent" ? "RetailDaddy AI" : state.name)}</div>
    <p>${escapeHtml(text)}</p>
  `;
  els.messages.appendChild(message);
  els.messages.scrollTop = els.messages.scrollHeight;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function updateButton(button, active) {
  button.classList.toggle("active", active);
}

function createVideo(stream, { muted = false } = {}) {
  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  video.muted = muted;
  video.srcObject = stream;
  return video;
}

function renderParticipants() {
  els.participantList.innerHTML = "";
  for (const participant of state.participants.values()) {
    if (participant.isAi) continue;

    const tile = document.createElement("section");
    tile.className = "participant-tile";
    tile.dataset.participantId = participant.id;
    const stream = participant.stream;
    if (stream) {
      tile.appendChild(createVideo(stream, { muted: participant.id === state.clientId }));
    }
    const initials = participant.name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "G";
    tile.innerHTML += `
      <div class="avatar">${escapeHtml(initials)}</div>
      <div>
        <strong>${escapeHtml(participant.name)}</strong>
        <span>${escapeHtml(participant.phone || "Guest")}</span>
      </div>
      <small>${participant.micMuted ? "Muted" : "Live"}</small>
    `;
    els.participantList.appendChild(tile);
  }
}

function showStageStream(stream) {
  els.stageEmpty.hidden = true;
  const previous = els.screenStage.querySelector("video");
  if (previous) previous.remove();
  els.screenStage.appendChild(createVideo(stream, { muted: true }));
}

async function ensureLocalMedia() {
  if (state.localStream) return state.localStream;

  try {
    state.localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 }
      }
    });
  } catch (error) {
    state.localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      video: false
    });
    addMessage("agent", `Camera unavailable, joined with microphone only. ${error.message}`, "System");
  }

  state.cameraTrack = state.localStream.getVideoTracks()[0] || null;
  state.participants.set(state.clientId, {
    id: state.clientId,
    name: state.name,
    phone: state.phone,
    isAi: false,
    stream: state.localStream,
    micMuted: false
  });
  renderParticipants();
  startVad();
  return state.localStream;
}

function connectEvents() {
  const params = new URLSearchParams({
    clientId: state.clientId,
    name: state.name,
    phone: state.phone
  });
  state.eventSource = new EventSource(`/events?${params.toString()}`);
  state.eventSource.onopen = () => {
    setStatus(`Connected as ${state.name}`);
  };

  state.eventSource.addEventListener("room_status", (event) => {
    const data = JSON.parse(event.data);
    els.aiName.textContent = data.aiName || "RetailDaddy AI";
    els.aiPhone.textContent = data.aiPhone || "+91 AI Demo";
    setStatus(`Joined as ${state.name}`);
    for (const participant of data.participants || []) {
      state.participants.set(participant.id, participant);
    }
    state.participants.set(state.clientId, {
      ...(state.participants.get(state.clientId) || {}),
      id: state.clientId,
      name: state.name,
      phone: state.phone,
      isAi: false,
      stream: state.localStream,
      micMuted: !state.micEnabled
    });
    renderParticipants();
  });

  state.eventSource.addEventListener("participant_joined", async (event) => {
    const data = JSON.parse(event.data);
    for (const participant of data.participants || []) {
      state.participants.set(participant.id, {
        ...(state.participants.get(participant.id) || {}),
        ...participant
      });
    }
    renderParticipants();
    if (data.id && data.id !== state.clientId) {
      const pc = createPeer(data.id);
      await makeOffer(data.id, pc);
    }
  });

  state.eventSource.addEventListener("participant_left", (event) => {
    const data = JSON.parse(event.data);
    const peer = state.peers.get(data.id);
    if (peer) peer.close();
    state.peers.delete(data.id);
    state.participants.delete(data.id);
    renderParticipants();
  });

  state.eventSource.addEventListener("signal", (event) => {
    handleSignal(JSON.parse(event.data)).catch((error) => {
      addMessage("agent", `WebRTC signal error: ${error.message}`, "System");
    });
  });

  state.eventSource.addEventListener("user_transcript", (event) => {
    const data = JSON.parse(event.data);
    addMessage("user", data.transcript, data.source === "text" ? "Typed question" : "Voice transcript");
  });

  state.eventSource.addEventListener("agent_answer", (event) => {
    handleAgentAnswer(JSON.parse(event.data));
  });

  state.eventSource.onerror = () => {
    setStatus("Room event stream reconnecting...");
  };
}

function createPeer(remoteId) {
  if (state.peers.has(remoteId)) return state.peers.get(remoteId);

  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
  });
  for (const track of state.localStream?.getTracks() || []) {
    pc.addTrack(track, state.localStream);
  }
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendSignal(remoteId, "candidate", event.candidate);
    }
  };
  pc.ontrack = (event) => {
    const [stream] = event.streams;
    const participant = state.participants.get(remoteId) || {
      id: remoteId,
      name: "Guest",
      phone: "",
      isAi: false
    };
    participant.stream = stream;
    state.participants.set(remoteId, participant);
    renderParticipants();
  };
  state.peers.set(remoteId, pc);
  return pc;
}

async function makeOffer(remoteId, pc = createPeer(remoteId)) {
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await sendSignal(remoteId, "offer", pc.localDescription);
}

async function handleSignal(signal) {
  if (signal.to && signal.to !== state.clientId) return;
  if (!signal.from || signal.from === state.clientId || signal.from === "ai-agent") return;

  const pc = createPeer(signal.from);
  if (signal.type === "offer") {
    await pc.setRemoteDescription(new RTCSessionDescription(signal.data));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await sendSignal(signal.from, "answer", pc.localDescription);
  } else if (signal.type === "answer") {
    await pc.setRemoteDescription(new RTCSessionDescription(signal.data));
  } else if (signal.type === "candidate") {
    await pc.addIceCandidate(new RTCIceCandidate(signal.data));
  }
}

async function sendSignal(to, type, data) {
  await fetch("/api/signal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      from: state.clientId,
      to,
      type,
      data
    })
  });
}

function startVad() {
  const audioTrack = state.localStream?.getAudioTracks()[0];
  if (!audioTrack) return;

  const audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(new MediaStream([audioTrack]));
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  state.analyser = analyser;

  const samples = new Uint8Array(analyser.fftSize);
  const tick = () => {
    if (!state.localStream) return;
    analyser.getByteTimeDomainData(samples);
    let sum = 0;
    for (const value of samples) {
      const centered = (value - 128) / 128;
      sum += centered * centered;
    }
    const rms = Math.sqrt(sum / samples.length);
    const now = Date.now();
    const voiceActive = rms > 0.025 && state.micEnabled && !state.aiSpeaking;
    if (voiceActive) {
      if (!state.speechStartedAt) state.speechStartedAt = now;
      state.lastVoiceAt = now;
      if (!state.recording && now - state.speechStartedAt > 160) {
        startSpeechRecording();
      }
    } else if (now - state.lastVoiceAt > 850) {
      state.speechStartedAt = 0;
      if (state.recording) stopSpeechRecording();
    }
    state.vadTimer = requestAnimationFrame(tick);
  };
  tick();
}

function startSpeechRecording() {
  if (state.recording || !state.micEnabled || state.aiSpeaking) return;

  const audioTrack = state.localStream?.getAudioTracks()[0];
  if (!audioTrack) return;

  state.chunks = [];
  state.recorder = new MediaRecorder(new MediaStream([audioTrack]), {
    mimeType: MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm"
  });
  state.recorder.ondataavailable = (event) => {
    if (event.data?.size) state.chunks.push(event.data);
  };
  state.recorder.onstop = () => {
    const blob = new Blob(state.chunks, { type: state.recorder.mimeType });
    state.chunks = [];
    if (blob.size > 4000) sendAudio(blob);
  };
  state.recorder.start();
  state.recording = true;
  setRecordingState("Listening");
  window.setTimeout(() => {
    if (state.recording) stopSpeechRecording();
  }, 8000);
}

function stopSpeechRecording() {
  if (!state.recording) return;
  state.recording = false;
  setRecordingState("Processing");
  state.recorder?.stop();
}

async function sendAudio(blob) {
  try {
    const startedAt = performance.now();
    const response = await fetch("/api/audio", {
      method: "POST",
      headers: {
        "Content-Type": blob.type || "audio/webm"
      },
      body: blob
    });
    const result = await response.json();
    if (result.ignored) {
      setRecordingState("Idle");
      return;
    }
    els.latencyChip.textContent = `${Math.round(performance.now() - startedAt)} ms round trip`;
    handleAgentAnswer(result);
  } catch (error) {
    addMessage("agent", `Voice request failed: ${error.message}`, "System");
  } finally {
    setRecordingState("Idle");
  }
}

async function handleAgentAnswer(data) {
  if (!data?.requestId || state.answerIds.has(data.requestId)) return;
  state.answerIds.add(data.requestId);
  addMessage("agent", data.answer, `AI answer · ${data.totalMs || data.responseMs || "-"} ms`);

  if (data.audioUrl) {
    state.aiSpeaking = true;
    els.aiState.textContent = "Speaking";
    els.aiTile.classList.add("speaking");
    try {
      const audio = new Audio(data.audioUrl);
      audio.preload = "auto";
      await audio.play();
      await new Promise((resolve) => {
        audio.onended = resolve;
        audio.onerror = resolve;
      });
    } finally {
      state.aiSpeaking = false;
      els.aiState.textContent = "Listening";
      els.aiTile.classList.remove("speaking");
    }
  }
}

async function sendTextQuestion(question) {
  const response = await fetch("/api/text", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question })
  });
  const result = await response.json();
  handleAgentAnswer(result);
}

async function toggleMic() {
  state.micEnabled = !state.micEnabled;
  for (const track of state.localStream?.getAudioTracks() || []) {
    track.enabled = state.micEnabled;
  }
  const self = state.participants.get(state.clientId);
  if (self) self.micMuted = !state.micEnabled;
  updateButton(els.micBtn, state.micEnabled);
  if (!state.micEnabled && state.recording) stopSpeechRecording();
  setRecordingState(state.micEnabled ? "Idle" : "Muted");
  renderParticipants();
}

async function toggleCamera() {
  state.camEnabled = !state.camEnabled;
  for (const track of state.localStream?.getVideoTracks() || []) {
    track.enabled = state.camEnabled;
  }
  updateButton(els.camBtn, state.camEnabled);
}

async function shareScreen() {
  if (state.screenTrack) {
    stopScreenShare();
    return;
  }

  const screenStream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: false
  });
  state.screenTrack = screenStream.getVideoTracks()[0];
  state.screenTrack.onended = stopScreenShare;
  replaceVideoTrack(state.screenTrack);
  showStageStream(screenStream);
  els.shareBtn.classList.add("active");
}

function stopScreenShare() {
  state.screenTrack?.stop();
  state.screenTrack = null;
  if (state.cameraTrack) {
    replaceVideoTrack(state.cameraTrack);
    showStageStream(state.localStream);
  }
  els.shareBtn.classList.remove("active");
}

function replaceVideoTrack(track) {
  for (const pc of state.peers.values()) {
    const sender = pc.getSenders().find((item) => item.track?.kind === "video");
    if (sender) sender.replaceTrack(track);
  }
}

async function joinRoom() {
  state.name = els.joinName.value.trim() || "Guest";
  state.phone = els.joinPhone.value.trim();
  setStatus("Opening devices...");
  await ensureLocalMedia();
  showStageStream(state.localStream);
  connectEvents();
}

function leaveRoom() {
  state.eventSource?.close();
  for (const pc of state.peers.values()) pc.close();
  for (const track of state.localStream?.getTracks() || []) track.stop();
  if (state.vadTimer) cancelAnimationFrame(state.vadTimer);
  state.peers.clear();
  state.localStream = null;
  setStatus("Left room");
}

els.joinForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  els.joinDialog.close();
  try {
    await joinRoom();
  } catch (error) {
    setStatus("Join failed");
    addMessage("agent", error.message, "System");
    els.joinDialog.showModal();
  }
});

els.micBtn.addEventListener("click", toggleMic);
els.camBtn.addEventListener("click", toggleCamera);
els.shareBtn.addEventListener("click", () => shareScreen().catch((error) => addMessage("agent", error.message, "System")));
els.leaveBtn.addEventListener("click", leaveRoom);
els.chatToggle.addEventListener("click", () => {
  els.transcriptPanel.hidden = !els.transcriptPanel.hidden;
});
els.askForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const question = els.textQuestion.value.trim();
  if (!question) return;
  els.textQuestion.value = "";
  sendTextQuestion(question).catch((error) => addMessage("agent", error.message, "System"));
});

if (!window.isSecureContext) {
  setStatus("Open this room on HTTPS for mic/camera/screen share.");
} else {
  setStatus("Ready to join");
}

els.joinDialog.showModal();
