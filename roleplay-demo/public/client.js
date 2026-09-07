// Week 2: live roleplay loop.
//
// Same mic -> 16kHz PCM16 -> AssemblyAI Realtime STT pipeline as stt-demo/,
// but now each rep "Turn" (end_of_turn) triggers:
//   1. POST /api/persona-reply  -> persona LLM's in-character text reply
//   2. POST /api/tts            -> that text spoken in the persona's voice
// While the persona's audio is playing, we stop forwarding mic frames to
// AssemblyAI so the persona's own voice can't get transcribed as if the
// rep said it (simple echo-avoidance — no AEC needed for a demo).

const personaSelect = document.getElementById("personaSelect");
const personaCard = document.getElementById("personaCard");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const statusEl = document.getElementById("status");
const logEl = document.getElementById("log");
const player = document.getElementById("player");

let personas = [];
let selectedPersona = null;

let audioContext = null;
let mediaStream = null;
let sourceNode = null;
let processorNode = null;
let socket = null;
let micMuted = false; // true while persona is "thinking" or speaking
let history = []; // [{role: 'user'|'assistant', content: string}]

const SAMPLE_RATE = 16000;

function setStatus(text) {
  statusEl.textContent = text;
}

function renderPersonaCard() {
  if (!selectedPersona) return;
  personaCard.innerHTML =
    '<span class="name">' + selectedPersona.name + "</span>" +
    '<span class="difficulty">' + selectedPersona.difficulty + "</span>" +
    "<br>" + selectedPersona.role +
    '<br><span style="color:#666">' + selectedPersona.tagline + "</span>";
}

async function loadPersonas() {
  const r = await fetch("/api/personas");
  personas = await r.json();
  personaSelect.innerHTML = "";
  for (const p of personas) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name + " — " + p.role;
    personaSelect.appendChild(opt);
  }
  selectedPersona = personas[0];
  renderPersonaCard();
}

personaSelect.addEventListener("change", () => {
  selectedPersona = personas.find((p) => p.id === personaSelect.value);
  renderPersonaCard();
});

function addLogLine(who, text, cls) {
  const existingPartial = logEl.querySelector(".partial");
  if (existingPartial) existingPartial.remove();
  const div = document.createElement("div");
  div.className = "turn " + cls;
  div.innerHTML = '<span class="who">' + who + ":</span> " + text;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

function showPartial(text) {
  const existingPartial = logEl.querySelector(".partial");
  if (existingPartial) existingPartial.remove();
  const div = document.createElement("div");
  div.className = "partial";
  div.textContent = "You: " + text;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

function floatTo16BitPCM(float32Array) {
  const out = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    let s = Math.max(-1, Math.min(1, float32Array[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

async function handleRepTurn(text) {
  if (!text.trim()) return;
  history.push({ role: "user", content: text });

  micMuted = true;
  setStatus(selectedPersona.name + " is thinking…");
  let errored = false;

  try {
    const replyRes = await fetch("/api/persona-reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ personaId: selectedPersona.id, history }),
    });
    const replyData = await replyRes.json().catch(() => ({}));
    if (!replyRes.ok) {
      throw new Error(
        "persona-reply " + replyRes.status + ": " + (replyData.error || "unknown error") +
          (replyData.detail ? " — " + replyData.detail : "")
      );
    }
    const reply = replyData.reply;

    history.push({ role: "assistant", content: reply });
    addLogLine(selectedPersona.name, reply, "persona");

    setStatus(selectedPersona.name + " is speaking…");
    const ttsRes = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: reply, voice: selectedPersona.voiceModel }),
    });
    if (!ttsRes.ok) {
      const d = await ttsRes.json().catch(() => ({}));
      throw new Error(
        "tts " + ttsRes.status + ": " + (d.error || "unknown error") +
          (d.detail ? " — " + d.detail : "")
      );
    }
    const blob = await ttsRes.blob();
    player.src = URL.createObjectURL(blob);

    await new Promise((resolve) => {
      player.onended = resolve;
      player.onerror = resolve;
      player.play().catch(resolve);
    });
  } catch (err) {
    console.error(err);
    errored = true;
    setStatus("error: " + err.message);
    addLogLine("System", "⚠️ " + err.message, "persona");
  } finally {
    micMuted = false;
    if (!errored && socket && socket.readyState === WebSocket.OPEN) {
      setStatus("connected — listening");
    }
  }
}

async function start() {
  if (!selectedPersona) await loadPersonas();

  startBtn.disabled = true;
  personaSelect.disabled = true;
  history = [];
  logEl.innerHTML = "";
  setStatus("requesting mic access...");

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    setStatus("mic access denied: " + err.message);
    startBtn.disabled = false;
    personaSelect.disabled = false;
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
    personaSelect.disabled = false;
    return;
  }

  setStatus("connecting to AssemblyAI...");
  const wsUrl =
    "wss://streaming.assemblyai.com/v3/ws?token=" +
    encodeURIComponent(token) +
    "&sample_rate=" + SAMPLE_RATE +
    "&encoding=pcm_s16le&format_turns=true";
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
    if (msg.type !== "Turn") return;
    const text = msg.transcript || "";
    if (!text) return;
    if (msg.end_of_turn) {
      addLogLine("You", text, "rep");
      handleRepTurn(text);
    } else {
      showPartial(text);
    }
  };

  socket.onerror = (err) => {
    console.error("WebSocket error", err);
    setStatus("WebSocket error — check console");
  };

  socket.onclose = () => {
    setStatus("call ended");
    stopBtn.disabled = true;
    startBtn.disabled = false;
    personaSelect.disabled = false;
  };
}

function startAudioPipeline() {
  audioContext = new (window.AudioContext || window.webkitAudioContext)({
    sampleRate: SAMPLE_RATE,
  });
  sourceNode = audioContext.createMediaStreamSource(mediaStream);

  const bufferSize = 4096;
  processorNode = audioContext.createScriptProcessor(bufferSize, 1, 1);

  processorNode.onaudioprocess = (event) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    if (micMuted) return; // don't let the persona's own voice get transcribed
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
  personaSelect.disabled = false;
}

startBtn.addEventListener("click", start);
stopBtn.addEventListener("click", stop);

loadPersonas();
