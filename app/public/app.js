// Week 3: full product UI.
//   setup screen -> live call (transcript + coach sidebar + live metrics) -> scorecard.
//
// Voice loop is the Week 2 one: mic -> 16kHz PCM16 -> AssemblyAI Realtime STT ->
// (end_of_turn) -> persona LLM -> Deepgram TTS. New in Week 3:
//   * /api/coach-nudge  - LLM coaching tip after each turn (text only, never spoken)
//   * instant local nudges (filler words, rambling) - zero latency, zero LLM calls
//   * /api/scorecard    - one LLM call over the full transcript when the call ends

const $ = (id) => document.getElementById(id);
const SAMPLE_RATE = 16000;

// ---- state ----------------------------------------------------------------
let personas = [];
let selectedPersona = null;

let audioContext = null, mediaStream = null, sourceNode = null, processorNode = null, socket = null;
let micMuted = false;
let turnInFlight = false;
let history = [];        // [{role: 'user'|'assistant', content}]
let callId = 0;          // bumps on every call start/end so stale async work is ignored
let callStartedAt = 0;
let timerHandle = null;
let repStats = { words: 0, personaWords: 0, turns: 0, fillers: 0, fillerBreakdown: {} };
let lastScorePayload = null;

// ---- helpers --------------------------------------------------------------
function showScreen(name) {
  for (const el of document.querySelectorAll(".screen")) el.classList.remove("active");
  $("screen-" + name).classList.add("active");
  window.scrollTo(0, 0);
}

function setStatus(text, kind) {
  const pill = $("statusPill");
  pill.textContent = text;
  pill.className = "pill" + (kind ? " " + kind : "");
}

const wordCount = (t) => (t.trim().match(/\S+/g) || []).length;

// Fillers: only unambiguous ones, so we don't flag legitimate "like".
const FILLER_PATTERNS = [
  ["um", /\b(um+|umm+)\b/gi],
  ["uh", /\b(uh+|uhh+|er|erm)\b/gi],
  ["you know", /\byou know\b/gi],
  ["basically", /\bbasically\b/gi],
  ["literally", /\bliterally\b/gi],
  ["sort of / kind of", /\b(sort of|kind of)\b/gi],
  ["like (filler)", /(?:^|[,.]\s*)like,/gi],
];
function countFillers(text) {
  const found = {};
  let total = 0;
  for (const [label, re] of FILLER_PATTERNS) {
    const n = (text.match(re) || []).length;
    if (n) { found[label] = n; total += n; }
  }
  return { total, found };
}

function fmtTime(sec) {
  const m = Math.floor(sec / 60), s = sec % 60;
  return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
}

function updateMetrics() {
  const total = repStats.words + repStats.personaWords;
  $("mTalk").textContent = total ? Math.round((repStats.words / total) * 100) + "%" : "0%";
  $("mFillers").textContent = repStats.fillers;
  $("mTurns").textContent = repStats.turns;
}

function currentMetrics() {
  const total = repStats.words + repStats.personaWords;
  return {
    durationSeconds: callStartedAt ? Math.round((Date.now() - callStartedAt) / 1000) : 0,
    repTurns: repStats.turns,
    repTalkPercent: total ? Math.round((repStats.words / total) * 100) : 0,
    avgWordsPerRepTurn: repStats.turns ? Math.round(repStats.words / repStats.turns) : 0,
    fillerWords: repStats.fillers,
    fillerBreakdown: repStats.fillerBreakdown,
  };
}

// ---- transcript rendering (textContent only: LLM output is never trusted as HTML)
function addBubble(who, text, cls) {
  const partial = $("transcript").querySelector(".partial");
  if (partial) partial.remove();
  const hint = $("transcript").querySelector(".empty-hint");
  if (hint) hint.remove();
  const div = document.createElement("div");
  div.className = "bubble " + cls;
  if (cls !== "system") {
    const w = document.createElement("span");
    w.className = "who";
    w.textContent = who;
    div.appendChild(w);
  }
  div.appendChild(document.createTextNode(text));
  $("transcript").appendChild(div);
  $("transcript").scrollTop = $("transcript").scrollHeight;
}

function showPartial(text) {
  const t = $("transcript");
  let p = t.querySelector(".partial");
  const hint = t.querySelector(".empty-hint");
  if (hint) hint.remove();
  if (!p) {
    p = document.createElement("div");
    p.className = "bubble rep partial";
    t.appendChild(p);
  }
  p.textContent = text;
  t.scrollTop = t.scrollHeight;
}

// ---- nudges ---------------------------------------------------------------
const TAG_LABELS = {
  objection: "Objection", value: "Value", discovery: "Discovery", specifics: "Be specific",
  "next-step": "Next step", rapport: "Rapport", concise: "Keep it tight", good: "Nice", filler: "Filler words",
};
function addNudge(category, text, source) {
  const box = $("nudges");
  const empty = box.querySelector(".nudge-empty");
  if (empty) empty.remove();
  for (const n of box.querySelectorAll(".nudge")) n.classList.add("old");
  const div = document.createElement("div");
  div.className = "nudge " + category;
  const tag = document.createElement("div");
  tag.className = "tag";
  tag.textContent = (TAG_LABELS[category] || category) + (source === "instant" ? " · instant" : "");
  const msg = document.createElement("div");
  msg.className = "msg";
  msg.textContent = text;
  div.append(tag, msg);
  box.prepend(div);
}

// Zero-latency heuristics that run the moment a rep turn ends.
function instantNudges(text, fillers) {
  const words = wordCount(text);
  if (fillers.total >= 3) {
    addNudge("filler", "Lots of filler words that turn — pause instead of saying um/uh.", "instant");
  }
  if (words > 70) {
    addNudge("concise", "That was a long turn. Lead with the answer, then stop talking.", "instant");
  }
}

// Instant, rule-based coaching: reacts to what the customer just asked for.
// Zero LLM calls, so it never hits the rate limit and shows up before the rep answers.
const RULES = [
  ["proof", /(how much|what.{0,25}(cost|save|roi|payback)|number|percent|%|dollar|\$|figure|metric|proof|evidence|case study|prove)/i,
    "value", "They want proof. Answer with one specific number or customer result."],
  ["security", /(security|soc ?2|hipaa|compliance|encrypt|data residency|audit|gdpr|privacy)/i,
    "specifics", "Name the exact certification or control. Skip 'we take security seriously'."],
  ["price", /(cheaper|too expensive|budget|pricing|price|discount|competitor|other (two )?(agencies|vendors|options)|what we have)/i,
    "objection", "Don't discount yet. Ask what they're comparing, then anchor on value."],
  ["rollout", /(integrat|api|implement|rollout|migration|onboard|timeline|how long)/i,
    "specifics", "Be concrete: timeline in weeks, who does what, what could go wrong."],
];
const NEXT_STEP_RE = /(pilot|demo|trial|next step|schedule|book|meeting|follow.?up|send you|call (you|on)|thursday|friday|monday|tuesday|wednesday)/i;
let lastRuleId = null;
let nextStepNudged = false;
function ruleNudge(reply) {
  const repTurns = history.filter((m) => m.role === "user").map((m) => m.content);
  const lastRep = repTurns[repTurns.length - 1] || "";
  for (const [id, re, cat, msg] of RULES) {
    if (re.test(reply) && id !== lastRuleId) {
      lastRuleId = id;
      addNudge(cat, msg, "instant");
      return;
    }
  }
  lastRuleId = null;
  if (repTurns.length >= 3 && !nextStepNudged && !repTurns.some((t) => NEXT_STEP_RE.test(t))) {
    nextStepNudged = true;
    addNudge("next-step", "You haven't proposed a next step yet. Ask for a concrete follow-up.", "instant");
    return;
  }
  if (repTurns.length >= 2 && !/\?/.test(lastRep)) {
    addNudge("discovery", "Ask a question about their situation before pitching more.", "instant");
  }
}

async function fetchNudge(id) {
  try {
    const r = await fetch("/api/coach-nudge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ personaId: selectedPersona.id, history }),
    });
    if (!r.ok) return;
    const d = await r.json();
    if (id !== callId || !d.nudge) return;
    addNudge(d.category || "value", d.nudge, "ai");
  } catch (e) {
    console.warn("nudge failed (non-fatal):", e);
  }
}

// ---- persona reply + TTS (Week 2 loop) -------------------------------------
async function fetchPersonaReply(body, attempt) {
  const r = await fetch("/api/persona-reply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (r.status === 429 && attempt < 2) {
    const waitMs = 1500 * (attempt + 1);
    setStatus("rate limited — retrying…", "thinking");
    await new Promise((res) => setTimeout(res, waitMs));
    return fetchPersonaReply(body, attempt + 1);
  }
  return r;
}

async function handleRepTurn(text, id) {
  history.push({ role: "user", content: text });
  const fillers = countFillers(text);
  repStats.words += wordCount(text);
  repStats.turns += 1;
  repStats.fillers += fillers.total;
  for (const [k, v] of Object.entries(fillers.found)) {
    repStats.fillerBreakdown[k] = (repStats.fillerBreakdown[k] || 0) + v;
  }
  updateMetrics();
  instantNudges(text, fillers);

  turnInFlight = true;
  micMuted = true;
  setStatus(selectedPersona.name.split(" ")[0] + " is thinking…", "thinking");
  let errored = false;

  try {
    const replyRes = await fetchPersonaReply({ personaId: selectedPersona.id, history }, 0);
    const replyData = await replyRes.json().catch(() => ({}));
    if (id !== callId) return; // call ended while we were waiting
    if (!replyRes.ok) {
      const friendly = replyRes.status === 429
        ? "still rate limited — wait a moment between turns"
        : (replyData.error || "unknown error");
      throw new Error("persona-reply " + replyRes.status + ": " + friendly);
    }
    const reply = replyData.reply;
    history.push({ role: "assistant", content: reply });
    repStats.personaWords += wordCount(reply);
    updateMetrics();
    addBubble(selectedPersona.name, reply, "persona");

    // Coaching nudge runs while the TTS audio is fetched/played (LLM calls stay
    // sequential per turn, which keeps us under the free-tier rate limit).
    ruleNudge(reply);
    fetchNudge(id);

    setStatus(selectedPersona.name.split(" ")[0] + " is speaking…", "speaking");
    const ttsRes = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: reply, voice: selectedPersona.voiceModel }),
    });
    if (!ttsRes.ok) {
      const d = await ttsRes.json().catch(() => ({}));
      throw new Error("tts " + ttsRes.status + ": " + (d.error || "unknown error"));
    }
    const blob = await ttsRes.blob();
    if (id !== callId) return;
    if (blob.size === 0) throw new Error("tts returned an empty audio blob");
    const player = $("player");
    player.src = URL.createObjectURL(blob);
    await new Promise((resolve, reject) => {
      player.onended = resolve;
      player.onerror = () => reject(new Error("audio failed to play"));
      player.play().catch((err) => {
        console.error("player.play() rejected:", err);
        player.hidden = false; // let the user press play manually
        addBubble("", "Autoplay was blocked — press play on the audio bar.", "system");
        resolve();
      });
    });
  } catch (err) {
    console.error(err);
    errored = true;
    if (id === callId) {
      setStatus("error", "error");
      addBubble("", "⚠️ " + err.message, "system");
    }
  } finally {
    if (id === callId) {
      turnInFlight = false;
      micMuted = false;
      if (!errored && socket && socket.readyState === WebSocket.OPEN) setStatus("listening", "listening");
      else if (errored) setTimeout(() => { if (id === callId) setStatus("listening", "listening"); }, 2500);
    }
  }
}

// ---- mic + STT -------------------------------------------------------------
function floatTo16BitPCM(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function startAudioPipeline() {
  audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SAMPLE_RATE });
  sourceNode = audioContext.createMediaStreamSource(mediaStream);
  processorNode = audioContext.createScriptProcessor(4096, 1, 1);
  processorNode.onaudioprocess = (event) => {
    if (!socket || socket.readyState !== WebSocket.OPEN || micMuted) return;
    socket.send(floatTo16BitPCM(event.inputBuffer.getChannelData(0)).buffer);
  };
  sourceNode.connect(processorNode);
  processorNode.connect(audioContext.destination);
}

function teardownAudio() {
  if (processorNode) { processorNode.disconnect(); processorNode = null; }
  if (sourceNode) { sourceNode.disconnect(); sourceNode = null; }
  if (audioContext) { audioContext.close(); audioContext = null; }
  if (mediaStream) { mediaStream.getTracks().forEach((t) => t.stop()); mediaStream = null; }
  if (socket) {
    const s = socket;
    socket = null;
    s.onclose = null;
    try { s.close(); } catch {}
  }
  const p = $("player");
  p.pause();
}

function showSetupError(msg) {
  const el = $("setupError");
  el.textContent = msg;
  el.hidden = !msg;
}

async function startCall() {
  showSetupError("");
  $("startBtn").disabled = true;

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    showSetupError("Microphone access was denied: " + err.message);
    $("startBtn").disabled = false;
    return;
  }
  let token;
  try {
    const r = await fetch("/api/stt-token");
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "failed to get token");
    token = data.token;
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop());
    showSetupError("Couldn't start speech recognition: " + err.message);
    $("startBtn").disabled = false;
    return;
  }

  mediaStream = stream;
  const id = ++callId;
  history = [];
  lastRuleId = null;
  nextStepNudged = false;
  repStats = { words: 0, personaWords: 0, turns: 0, fillers: 0, fillerBreakdown: {} };
  turnInFlight = false;
  micMuted = false;
  updateMetrics();

  $("transcript").innerHTML = '<div class="empty-hint">Say hello — pitch ' + selectedPersona.name.split(" ")[0] + " out loud.</div>";
  $("nudges").innerHTML = '<div class="nudge-empty">Nudges appear here as you talk. Just speak to start.</div>';
  $("callPersonaName").textContent = selectedPersona.name;
  $("callPersonaRole").textContent = selectedPersona.role + " · " + selectedPersona.difficulty;
  $("player").hidden = true;
  $("stopBtn").disabled = false;
  setStatus("connecting…", "thinking");
  showScreen("call");

  const wsUrl =
    "wss://streaming.assemblyai.com/v3/ws?token=" + encodeURIComponent(token) +
    "&sample_rate=" + SAMPLE_RATE + "&encoding=pcm_s16le&format_turns=true";
  socket = new WebSocket(wsUrl);
  socket.binaryType = "arraybuffer";

  socket.onopen = () => {
    callStartedAt = Date.now();
    clearInterval(timerHandle);
    $("timer").textContent = "00:00";
    timerHandle = setInterval(() => {
      $("timer").textContent = fmtTime(Math.floor((Date.now() - callStartedAt) / 1000));
    }, 500);
    setStatus("listening", "listening");
    startAudioPipeline();
  };

  socket.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.type !== "Turn") return;
    const text = msg.transcript || "";
    if (!text) return;
    if (msg.end_of_turn) {
      if (turnInFlight) { console.warn("Dropping overlapping turn:", text); return; }
      addBubble("You", text, "rep");
      handleRepTurn(text, id);
    } else {
      showPartial(text);
    }
  };

  socket.onerror = (e) => { console.error("WebSocket error", e); setStatus("connection error", "error"); };
  socket.onclose = () => { if (id === callId) endCall(); };
}

// ---- end call + scorecard --------------------------------------------------
function endCall() {
  const id = callId;
  const metrics = currentMetrics();
  callId++; // invalidate any in-flight persona/TTS/nudge work
  clearInterval(timerHandle);
  teardownAudio();
  turnInFlight = false;
  $("stopBtn").disabled = true;
  $("startBtn").disabled = false;

  if (!history.some((m) => m.role === "user")) {
    showScreen("setup");
    showSetupError("The call ended before you said anything — nothing to score. Try again and speak after it connects.");
    return;
  }
  requestScorecard({ personaId: selectedPersona.id, history: history.slice(), metrics });
}

async function requestScorecard(payload) {
  lastScorePayload = payload;
  showScreen("results");
  $("resultsLoading").hidden = false;
  $("resultsBody").hidden = true;
  $("resultsError").hidden = true;
  try {
    const r = await fetch("/api/scorecard", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.detail || d.error || "scorecard request failed (" + r.status + ")");
    renderScorecard(d, payload);
  } catch (err) {
    console.error(err);
    $("resultsLoading").hidden = true;
    $("resultsErrorMsg").textContent = "Couldn't build your scorecard: " + err.message;
    $("resultsError").hidden = false;
  }
}

const scoreColor = (n) => (n >= 75 ? "var(--good)" : n >= 50 ? "var(--warn)" : "var(--bad)");

function fillList(id, items) {
  const el = $(id);
  el.innerHTML = "";
  for (const t of items) {
    const li = document.createElement("li");
    li.textContent = t;
    el.appendChild(li);
  }
  if (!items.length) {
    const li = document.createElement("li");
    li.textContent = "—";
    el.appendChild(li);
  }
}

function renderScorecard(d, payload) {
  const persona = personas.find((p) => p.id === payload.personaId) || selectedPersona;
  $("resultsWho").textContent = "Call with " + persona.name + " · " + persona.difficulty;
  $("headline").textContent = d.headline || "Here's how the call went.";

  const chips = $("statChips");
  chips.innerHTML = "";
  const m = payload.metrics || {};
  const chipData = [
    m.durationSeconds != null ? fmtTime(m.durationSeconds) + " long" : null,
    m.repTurns != null ? m.repTurns + " turns" : null,
    m.repTalkPercent != null ? m.repTalkPercent + "% talk time" : null,
    m.fillerWords != null ? m.fillerWords + " filler words" : null,
  ].filter(Boolean);
  for (const c of chipData) {
    const s = document.createElement("span");
    s.className = "chip";
    s.textContent = c;
    chips.appendChild(s);
  }

  const bars = $("bars");
  bars.innerHTML = "";
  const labels = {
    discovery: "Discovery", objection_handling: "Objection handling",
    value_articulation: "Value articulation", closing: "Closing / next step",
  };
  const fills = [];
  for (const [k, label] of Object.entries(labels)) {
    const v = d.categories?.[k] ?? 0;
    const wrap = document.createElement("div");
    wrap.className = "bar";
    const top = document.createElement("div");
    top.className = "bar-top";
    const a = document.createElement("span"); a.textContent = label;
    const b = document.createElement("span"); b.textContent = v;
    top.append(a, b);
    const track = document.createElement("div"); track.className = "bar-track";
    const fill = document.createElement("div"); fill.className = "bar-fill";
    fill.style.background = scoreColor(v);
    track.appendChild(fill);
    wrap.append(top, track);
    bars.appendChild(wrap);
    fills.push([fill, v]);
  }

  fillList("strengths", d.strengths || []);
  fillList("missed", d.missed_opportunities || []);
  fillList("drills", d.drills || []);
  $("bestMomentCard").hidden = !d.best_moment;
  $("bestMoment").textContent = d.best_moment ? "“" + d.best_moment.replace(/^["“]|["”]$/g, "") + "”" : "";

  $("resultsLoading").hidden = true;
  $("resultsBody").hidden = false;

  // animate score ring + bars after the layout paints
  const overall = d.overall || 0;
  $("overall").textContent = overall;
  const ring = $("ringFg");
  ring.style.stroke = scoreColor(overall);
  ring.setAttribute("stroke-dashoffset", "326.7");
  requestAnimationFrame(() => requestAnimationFrame(() => {
    ring.setAttribute("stroke-dashoffset", String(326.7 * (1 - overall / 100)));
    for (const [f, v] of fills) f.style.width = v + "%";
  }));
}

// ---- sample call (no mic): also the demo fallback --------------------------
const SAMPLE_HISTORY = [
  { role: "user", content: "Hi Marcus, thanks for taking the time. We help logistics companies cut dispatch planning time with an AI routing platform." },
  { role: "assistant", content: "Okay, but I hear AI everywhere. What does this actually save me in dollars?" },
  { role: "user", content: "Um, so basically it's, like, a lot. Customers see big savings and it's really easy to use." },
  { role: "assistant", content: "Big savings isn't a number. Give me a payback period or I'm not interested." },
  { role: "user", content: "Fair. Before I quote you, how many dispatchers do you have and what's your fuel spend per month? A customer your size, around 400 people, cut fuel costs by about 8 percent and paid back the platform in five months." },
  { role: "assistant", content: "Eight percent on what base? And what happens to my team during the five month rollout?" },
  { role: "user", content: "Good questions. Rollout is phased over six weeks with no downtime, and I'd suggest we run a 30 day pilot on one region so you can verify the number yourself. Can we book the pilot scoping call for Thursday?" },
];
const SAMPLE_METRICS = {
  durationSeconds: 154, repTurns: 3, repTalkPercent: 71, avgWordsPerRepTurn: 30,
  fillerWords: 3, fillerBreakdown: { um: 1, basically: 1, "like (filler)": 1 },
};

// ---- setup screen ---------------------------------------------------------
function renderPersonaGrid() {
  const grid = $("personaGrid");
  grid.innerHTML = "";
  for (const p of personas) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "persona" + (selectedPersona && selectedPersona.id === p.id ? " selected" : "");
    const av = document.createElement("div"); av.className = "avatar"; av.textContent = p.name.split(" ").map((w) => w[0]).join("");
    const nm = document.createElement("div"); nm.className = "p-name"; nm.textContent = p.name;
    const rl = document.createElement("div"); rl.className = "p-role"; rl.textContent = p.role;
    const tg = document.createElement("div"); tg.className = "p-tag"; tg.textContent = p.tagline;
    const df = document.createElement("span"); df.className = "diff " + p.difficulty; df.textContent = p.difficulty;
    b.append(av, nm, rl, tg, df);
    b.addEventListener("click", () => { selectedPersona = p; renderPersonaGrid(); });
    grid.appendChild(b);
  }
}

async function loadPersonas() {
  try {
    const r = await fetch("/api/personas");
    personas = await r.json();
    selectedPersona = personas[0];
    renderPersonaGrid();
  } catch (e) {
    showSetupError("Couldn't load personas — is the server running?");
  }
}

$("startBtn").addEventListener("click", () => selectedPersona && startCall());
$("stopBtn").addEventListener("click", endCall);
$("sampleBtn").addEventListener("click", () => {
  selectedPersona = personas.find((p) => p.id === "cfo") || personas[0];
  renderPersonaGrid();
  requestScorecard({ personaId: selectedPersona.id, history: SAMPLE_HISTORY, metrics: SAMPLE_METRICS });
});
$("retryScoreBtn").addEventListener("click", () => lastScorePayload && requestScorecard(lastScorePayload));
for (const b of document.querySelectorAll(".again")) {
  b.addEventListener("click", () => { callId++; showSetupError(""); showScreen("setup"); });
}

loadPersonas();
