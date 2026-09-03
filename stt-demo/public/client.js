// Mic capture -> 16kHz PCM16 -> AssemblyAI Realtime Streaming WebSocket.
//
// Flow:
//   1. Ask our own server for a short-lived AssemblyAI token (GET /api/stt-token).
//   2. Open a WebSocket directly to AssemblyAI with that token.
//   3. Capture mic audio via Web Audio API, downsample to 16kHz, convert to
//      Int16 PCM, and stream it up as binary frames.
//   4. Render "Turn" messages the server sends back (partial + final text).

const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const statusEl = document.getElementById("status");
const transcriptEl = document.getElementById("transcript");

let audioContext = null;
let mediaStream = null;
let sourceNode = null;
let processorNode = null;
let socket = null;

const SAMPLE_RATE = 16000;

function setStatus(text) {
  statusEl.textContent = text;
}

function floatTo16BitPCM(float32Array) {
  const out = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    let s = Math.max(-1, Math.min(1, float32Array[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

async function start() {
  startBtn.disabled = true;
  setStatus("requesting mic access...");

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    setStatus("mic access denied: " + err.message);
    startBtn.disabled = false;
    return;
  }

  setStatus("fetching AssemblyAI token...");
  let token;
  try {
    const r = await fetch("/api/stt-token");
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "failed to get token");
    token = data.token;
  } catch (err) {
    setStatus("token error: " + err.message);
    startBtn.disabled = false;
    return;
  }

  setStatus("connecting to AssemblyAI...");
  const wsUrl = `wss://streaming.assemblyai.com/v3/ws?token=${encodeURIComponent(
    token
  )}&sample_rate=${SAMPLE_RATE}&encoding=pcm_s16le&format_turns=true`;
  socket = new WebSocket(wsUrl);
  socket.binaryType = "arraybuffer";

  socket.onopen = () => {
    setStatus("connected — listening");
    stopBtn.disabled = false;
    startAudioPipeline();
  };

  socket.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.type === "Turn") {
      const text = msg.transcript || "";
      if (!text) return;
      // Show the in-progress turn on one line; once end_of_turn, commit it.
      const existingPartial = transcriptEl.querySelector(".partial");
      if (existingPartial) existingPartial.remove();
      if (msg.end_of_turn) {
        const line = document.createElement("div");
        line.className = "final";
        line.textContent = text;
        transcriptEl.appendChild(line);
      } else {
        const line = document.createElement("div");
        line.className = "partial";
        line.textContent = text;
        transcriptEl.appendChild(line);
      }
    } else if (msg.type === "Begin") {
      console.log("session began", msg);
    } else if (msg.type === "Termination") {
      console.log("session ended", msg);
    }
  };

  socket.onerror = (err) => {
    console.error("WebSocket error", err);
    setStatus("WebSocket error — check console");
  };

  socket.onclose = () => {
    setStatus("disconnected");
    stopBtn.disabled = true;
    startBtn.disabled = false;
  };
}

function startAudioPipeline() {
  audioContext = new (window.AudioContext || window.webkitAudioContext)({
    sampleRate: SAMPLE_RATE,
  });
  sourceNode = audioContext.createMediaStreamSource(mediaStream);

  // ScriptProcessorNode is deprecated but universally supported and plenty
  // for a Week 1 demo; swap for an AudioWorklet later if needed.
  const bufferSize = 4096;
  processorNode = audioContext.createScriptProcessor(bufferSize, 1, 1);

  processorNode.onaudioprocess = (event) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const input = event.inputBuffer.getChannelData(0);
    const pcm16 = floatTo16BitPCM(input);
    socket.send(pcm16.buffer);
  };

  sourceNode.connect(processorNode);
  processorNode.connect(audioContext.destination);
}

function stop() {
  stopBtn.disabled = true;

  if (processorNode) {
    processorNode.disconnect();
    processorNode = null;
  }
  if (sourceNode) {
    sourceNode.disconnect();
    sourceNode = null;
  }
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  if (socket) {
    socket.close();
    socket = null;
  }
  setStatus("stopped");
  startBtn.disabled = false;
}

startBtn.addEventListener("click", start);
stopBtn.addEventListener("click", stop);
