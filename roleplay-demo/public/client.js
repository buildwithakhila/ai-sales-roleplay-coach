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
let turnInFlight = false; // true while a persona-reply/tts round trip is in progress
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

async function fetchPersonaReply(body, attempt) {
  const r = await fetch("/api/persona-reply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (r.status === 429 && attempt < 2) {
    // Hackathon free-tier rate limit is easy to hit with rapid back-and-forth
    // testing. One short backoff-and-retry before giving up and surfacing it.
    const waitMs = 1500 * (attempt + 1);
    setStatus(selectedPersona.name + " — rate limited, retrying in " + Math.round(waitMs / 1000) + "s…");
    await new Promise((res) => setTimeout(res, waitMs));
    return fetchPersonaReply(body, attempt + 1);
  }
  return r;
}

async function handleRepTurn(text) {
  if (!text.trim()) return;
  history.push({ role: "user", content: text });

  turnInFlight = true;
  micMuted = true;
  setStatus(selectedPersona.name + " is thinking…");
  let errored = false;

  try {
    const replyRes = await fetchPersonaReply({ personaId: selectedPersona.id, history }, 0);
    const replyData = await replyRes.json().catch(() => ({}));
    if (!replyRes.ok) {
      const friendly = replyRes.status === 429
        ? "still rate limited after retrying — wait a bit longer between turns"
        : (replyData.error || "unknown error") + (replyData.detail ? " — " + replyData.detail : "");
      throw new Error("persona-reply " + replyRes.status + ": " + friendly);
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
    console.log("TTS audio blob:", blob.size, "bytes,", blob.type);
    if (blob.size === 0) throw new Error("tts returned an empty audio blob");
    player.src = URL.createObjectURL(blob);

    await new Promise((resolve, reject) => {
      player.onended = resolve;
      player.onerror = () => reject(new Error("audio element failed to play the response"));
      player.play().then(resolve).catch((err) => {
        // Most likely a browser autoplay-block (NotAllowedError). The <audio>
        // element still has visible controls, so the user can hit play
        // manually — don't hang the turn waiting for that, just move on.
        console.error("player.play() rejected:", err);
        addLogLine("System", "⚠️ Autoplay blocked (" + err.name + ") — hit play on the audio bar below.", "persona");
        resolve();
      });
    });
  } catch (err) {
    console.error(err);
    errored = true;
    setStatus("error: " + err.message);
    addLogLine("System", "⚠️ " + err.message, "persona");
  } finally {
    turnInFlight = false;
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
      if (turnInFlight) {
        // A stray/overlapping Turn arrived while we're still processing the
        // last one (e.g. buffered audio finalizing right as we muted the
        // mic) — drop it rather than firing another LLM call on top.
        console.warn("Dropping overlapping turn (already in flight):", text);
        return;
      }
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
