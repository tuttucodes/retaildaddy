const state = {
  clientId: crypto.randomUUID(),
  name: "",
  phone: "",
  localStream: null,
  cameraTrack: null,
  screenTrack: null,
  polling: false,
  cursor: 0,
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
  lastVoiceAt: 0,
  audioContext: null,
  audioUnlocked: false,
  pendingAudioUrl: ""
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
  demoBtn: document.getElementById("demoBtn"),
  soundBtn: document.getElementById("soundBtn"),
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

function getAudioContext() {
  if (state.audioContext) return state.audioContext;

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;

  state.audioContext = new AudioContextClass();
  return state.audioContext;
}

async function unlockAudioPlayback() {
  const context = getAudioContext();
  if (!context) {
    throw new Error("This browser does not support Web Audio playback.");
  }

  if (context.state === "suspended") {
    await context.resume();
  }

  const buffer = context.createBuffer(1, 1, 22050);
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  source.start(0);
  state.audioUnlocked = true;
  els.soundBtn.hidden = true;
  return context;
}

async function playWithWebAudio(audioUrl) {
  const context = await unlockAudioPlayback();
  const response = await fetch(audioUrl);
  if (!response.ok) {
    throw new Error(`Audio download failed with HTTP ${response.status}`);
  }

  const encoded = await response.arrayBuffer();
  const audioBuffer = await context.decodeAudioData(encoded.slice(0));
  await new Promise((resolve) => {
    const source = context.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(context.destination);
    source.onended = resolve;
    source.start(0);
  });
}

async function playWithHtmlAudio(audioUrl) {
  const audio = new Audio(audioUrl);
  audio.preload = "auto";
  await audio.play();
  await new Promise((resolve, reject) => {
    audio.onended = resolve;
    audio.onerror = () => reject(new Error(audio.error?.message || "HTML audio playback failed."));
  });
}

async function playAiAudio(audioUrl) {
  try {
    await playWithWebAudio(audioUrl);
    return;
  } catch (webAudioError) {
    try {
      await playWithHtmlAudio(audioUrl);
      return;
    } catch (htmlAudioError) {
      state.pendingAudioUrl = audioUrl;
      els.soundBtn.hidden = false;
      els.soundBtn.classList.add("attention");
      throw new Error(`${webAudioError.message}; ${htmlAudioError.message}`);
    }
  }
}

function createVideo(stream, { muted = false } = {}) {
  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  video.muted = muted;
  video.srcObject = stream;
  return video;
}

function clearStage() {
  for (const child of Array.from(els.screenStage.children)) {
    if (child !== els.stageEmpty) child.remove();
  }
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
  clearStage();
  els.screenStage.appendChild(createVideo(stream, { muted: true }));
}

function showAgentScreen(payload = {}) {
  els.stageEmpty.hidden = true;
  clearStage();

  const metrics = payload.metrics || [];
  const rows = payload.rows || [];
  const screen = document.createElement("section");
  screen.className = "ai-screen";
  screen.innerHTML = `
    <header class="ai-screen-header">
      <div>
        <span>RetailDaddy</span>
        <h2>${escapeHtml(payload.title || "RetailDaddy Operations Dashboard")}</h2>
        <p>${escapeHtml(payload.subtitle || "AI-guided product walkthrough")}</p>
      </div>
      <strong>AI presenting</strong>
    </header>
    <div class="ai-focus">
      <span>Focus</span>
      <strong>${escapeHtml(payload.focus || "Sales, stock, orders, and exceptions")}</strong>
    </div>
    <div class="ai-metrics">
      ${metrics
        .map(
          (metric) => `
            <article>
              <span>${escapeHtml(metric.label)}</span>
              <strong>${escapeHtml(metric.value)}</strong>
              <small>${escapeHtml(metric.trend)}</small>
            </article>
          `
        )
        .join("")}
    </div>
    <div class="ai-worktable">
      <div class="ai-table-head">
        <strong>Inventory watchlist</strong>
        <span>Live store signal</span>
      </div>
      <table>
        <thead><tr><th>SKU</th><th>Item</th><th>Stock</th><th>Status</th></tr></thead>
        <tbody>
          ${rows
            .map(
              (row) => `
                <tr>
                  <td>${escapeHtml(row.sku)}</td>
                  <td>${escapeHtml(row.item)}</td>
                  <td>${escapeHtml(row.stock)}</td>
                  <td><span class="status-pill">${escapeHtml(row.status)}</span></td>
                </tr>
              `
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
  els.screenStage.appendChild(screen);
  els.shareBtn.classList.remove("active");
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

async function connectEvents() {
  setStatus("Connecting room...");
  const joined = await fetch("/api/join", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientId: state.clientId,
      name: state.name,
      phone: state.phone
    })
  }).then((response) => response.json());

  if (!joined.ok) {
    throw new Error(joined.error || "Room join failed");
  }
  state.cursor = joined.cursor || 0;
  processRoomEvent("room_status", joined);
  state.polling = true;
  pollRoomEvents();
}

function processRoomEvent(eventName, data) {
  if (eventName === "room_status") {
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
    return;
  }

  if (eventName === "participant_joined") {
    for (const participant of data.participants || []) {
      state.participants.set(participant.id, {
        ...(state.participants.get(participant.id) || {}),
        ...participant
      });
    }
    renderParticipants();
    if (data.id && data.id !== state.clientId) {
      const pc = createPeer(data.id);
      makeOffer(data.id, pc).catch((error) => {
        addMessage("agent", `WebRTC offer error: ${error.message}`, "System");
      });
    }
    return;
  }

  if (eventName === "participant_left") {
    const peer = state.peers.get(data.id);
    if (peer) peer.close();
    state.peers.delete(data.id);
    state.participants.delete(data.id);
    renderParticipants();
    return;
  }

  if (eventName === "signal") {
    handleSignal(data).catch((error) => {
      addMessage("agent", `WebRTC signal error: ${error.message}`, "System");
    });
    return;
  }

  if (eventName === "user_transcript") {
    addMessage("user", data.transcript, data.source === "text" ? "Typed question" : "Voice transcript");
    return;
  }

  if (eventName === "agent_answer") {
    handleAgentAnswer(data);
    return;
  }

  if (eventName === "agent_presenting") {
    showAgentScreen(data);
    els.latencyChip.textContent = "AI presenting RetailDaddy";
  }
}

async function pollRoomEvents() {
  while (state.polling) {
    try {
      const params = new URLSearchParams({
        clientId: state.clientId,
        cursor: String(state.cursor)
      });
      const result = await fetch(`/api/poll?${params.toString()}`).then((response) => response.json());
      if (result.error) {
        setStatus(`Room polling error: ${result.error}`);
        await wait(1000);
        continue;
      }
      state.cursor = result.cursor ?? state.cursor;
      for (const item of result.events || []) {
        processRoomEvent(item.event, item.payload);
      }
      await wait((result.events || []).length ? 120 : 500);
    } catch {
      setStatus("Room polling reconnecting...");
      await wait(1200);
    }
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  const audioContext = getAudioContext();
  if (!audioContext) return;
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
      await playAiAudio(data.audioUrl);
    } catch (error) {
      addMessage("agent", `Tap Sound once to enable AI voice. ${error.message}`, "System");
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

async function startAiDemo() {
  els.demoBtn.classList.add("active");
  try {
    await fetch("/api/demo/start", { method: "POST" });
  } finally {
    window.setTimeout(() => els.demoBtn.classList.remove("active"), 1800);
  }
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
  await connectEvents();
}

function leaveRoom() {
  state.polling = false;
  fetch("/api/leave", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId: state.clientId })
  }).catch(() => {});
  for (const pc of state.peers.values()) pc.close();
  for (const track of state.localStream?.getTracks() || []) track.stop();
  if (state.vadTimer) cancelAnimationFrame(state.vadTimer);
  state.peers.clear();
  state.localStream = null;
  setStatus("Left room");
}

els.joinForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const audioUnlock = unlockAudioPlayback().catch((error) => {
    els.soundBtn.hidden = false;
    els.soundBtn.classList.add("attention");
    addMessage("agent", `Tap Sound once if you do not hear the AI voice. ${error.message}`, "System");
  });
  els.joinDialog.close();
  try {
    await joinRoom();
    await audioUnlock;
  } catch (error) {
    setStatus("Join failed");
    addMessage("agent", error.message, "System");
    els.joinDialog.showModal();
  }
});

els.micBtn.addEventListener("click", toggleMic);
els.camBtn.addEventListener("click", toggleCamera);
els.shareBtn.addEventListener("click", () => shareScreen().catch((error) => addMessage("agent", error.message, "System")));
els.demoBtn.addEventListener("click", () => startAiDemo().catch((error) => addMessage("agent", error.message, "System")));
els.soundBtn.addEventListener("click", async () => {
  try {
    await unlockAudioPlayback();
    els.soundBtn.classList.remove("attention");
    const pendingAudioUrl = state.pendingAudioUrl;
    state.pendingAudioUrl = "";
    if (pendingAudioUrl) {
      await playAiAudio(pendingAudioUrl);
    }
  } catch (error) {
    addMessage("agent", `Could not enable sound: ${error.message}`, "System");
  }
});
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
