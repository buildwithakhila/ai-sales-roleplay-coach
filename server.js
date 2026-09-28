// Demo server.
//
// Week 1 routes (isolated, on purpose — see README):
//   GET  /api/stt-token   -> mints a short-lived AssemblyAI token for the browser
//   POST /api/tts         -> calls Deepgram Aura TTS server-side and streams audio back
//
// Week 2 routes (wire STT -> persona LLM -> TTS into one live loop):
//   GET  /api/personas       -> list of customer personas for the UI dropdown
//   POST /api/persona-reply  -> given conversation history, get the persona's next line
//                                from AssemblyAI's LLM Gateway (same ASSEMBLYAI_API_KEY,
//                                OpenAI-compatible /v1/chat/completions endpoint)
//
// Neither the AssemblyAI key nor the Deepgram key is ever sent to the browser.
//
// TTS vendor note: originally built against ElevenLabs per the build plan, but
// ElevenLabs' free tier blocks ALL voices (including "premade" ones) via the
// API - "Voice Library voices are not available via the API to free tier
// users" - full stop, even if you add the voice to "My Voices" first. Rather
// than pay to unblock it during Week 1, switched to Deepgram Aura, which has
// a generous free trial credit and no such restriction.
//
// LLM vendor note (Week 2): using AssemblyAI's own LLM Gateway rather than a
// separate OpenAI/Anthropic key. It's OpenAI-SDK-compatible, supports 25+
// models (including Claude) behind one API key, and ties the persona/coaching
// logic back to AssemblyAI's own infra for the "application of technology"
// judging criterion, per the build plan's Week 1 note to check this first.
require("dotenv").config();
const express = require("express");
const path = require("path");
const { listPersonasForClient, getPersona } = require("./personas");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const DEEPGRAM_TTS_MODEL = process.env.DEEPGRAM_TTS_MODEL || "aura-2-thalia-en";
const ASSEMBLYAI_LLM_URL =
  process.env.ASSEMBLYAI_LLM_URL || "https://llm-gateway.assemblyai.com/v1/chat/completions";
const ASSEMBLYAI_LLM_MODEL = process.env.ASSEMBLYAI_LLM_MODEL || "qwen3.5-4b-32k-fast";

// ---- STT demo -------------------------------------------------------------

app.get("/api/stt-token", async (req, res) => {
  if (!ASSEMBLYAI_API_KEY) {
    return res
      .status(500)
      .json({ error: "ASSEMBLYAI_API_KEY is not set on the server (.env)" });
  }
  try {
    const expiresInSeconds = 60; // one WebSocket session's worth
    const url = `https://streaming.assemblyai.com/v3/token?expires_in_seconds=${expiresInSeconds}`;
    const r = await fetch(url, {
      headers: { Authorization: ASSEMBLYAI_API_KEY },
    });
    if (!r.ok) {
      const body = await r.text();
      console.error("AssemblyAI token error:", r.status, body);
      return res
        .status(r.status)
        .json({ error: "Failed to mint AssemblyAI token", detail: body });
    }
    const data = await r.json();
    res.json(data); // { token: "..." }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

// ---- TTS demo ---------------------------------------------------------

app.post("/api/tts", async (req, res) => {
  if (!DEEPGRAM_API_KEY) {
    return res
      .status(500)
      .json({ error: "DEEPGRAM_API_KEY is not set on the server (.env)" });
  }
  const { text, voice } = req.body || {};
  if (!text || !text.trim()) {
    return res.status(400).json({ error: "Missing 'text' in request body" });
  }
  const model = voice || DEEPGRAM_TTS_MODEL;
  try {
    const url = `https://api.deepgram.com/v1/speak?model=${encodeURIComponent(model)}`;
    const r = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Token ${DEEPGRAM_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text }),
    });
    if (!r.ok) {
      const body = await r.text();
      console.error("Deepgram TTS error:", r.status, body);
      return res
        .status(r.status)
        .json({ error: "Deepgram TTS request failed", detail: body });
    }
    const buf = Buffer.from(await r.arrayBuffer());
    res.set("Content-Type", r.headers.get("content-type") || "audio/mpeg");
    res.send(buf);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

// ---- Week 2: personas + persona-reply -------------------------------------

app.get("/api/personas", (req, res) => {
  res.json(listPersonasForClient());
});

app.post("/api/persona-reply", async (req, res) => {
  if (!ASSEMBLYAI_API_KEY) {
    return res
      .status(500)
      .json({ error: "ASSEMBLYAI_API_KEY is not set on the server (.env)" });
  }
  const { personaId, history } = req.body || {};
  const persona = getPersona(personaId);
  if (!persona) {
    return res.status(400).json({ error: `Unknown personaId: ${personaId}` });
  }
  if (!Array.isArray(history) || history.length === 0) {
    return res.status(400).json({ error: "Missing 'history' array in request body" });
  }

  const messages = [
    { role: "system", content: persona.systemPrompt },
    ...history.map((m) => ({ role: m.role, content: m.content })),
  ];

  try {
    const reply = await callLLM(messages, { maxTokens: 200 });
    res.json({ reply: reply.replace(/<think>[\s\S]*?<\/think>/g, "").trim() });
  } catch (err) {
    console.error("persona-reply error:", err.message);
    res.status(err.status || 500).json({ error: "LLM Gateway request failed", detail: err.message });
  }
});

// ---- Week 3: coaching nudges + post-session scorecard ---------------------

// Shared LLM Gateway helper with a server-side backoff on 429s (the hackathon
// free tier rate-limits easily once each turn makes more than one call).
// All LLM Gateway traffic goes through ONE serial queue with a small gap between
// calls. The hackathon free tier rate-limits bursts (persona reply + nudge +
// scorecard used to collide and 429), so we never have two calls in flight.
let llmChain = Promise.resolve();
let llmPending = 0;
const LLM_GAP_MS = 500;
function enqueueLLM(task) {
  llmPending++;
  const p = llmChain.then(task);
  llmChain = p.catch(() => {}).then(() => new Promise((r) => setTimeout(r, LLM_GAP_MS)));
  return p.finally(() => { llmPending--; });
}

async function callLLM(messages, { maxTokens = 300, temperature } = {}) {
  return enqueueLLM(async () => {
    let lastErr;
    const waits = [2000, 4000, 8000, 12000];
    for (let attempt = 0; attempt <= waits.length; attempt++) {
      const body = { model: ASSEMBLYAI_LLM_MODEL, messages, max_tokens: maxTokens };
      if (temperature !== undefined) body.temperature = temperature;
      const r = await fetch(ASSEMBLYAI_LLM_URL, {
        method: "POST",
        headers: { authorization: ASSEMBLYAI_API_KEY, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (r.status === 429) {
        lastErr = new Error("LLM Gateway rate limited (429)");
        lastErr.status = 429;
        if (attempt === waits.length) break;
        const ra = Number(r.headers.get("retry-after"));
        const wait = ra > 0 ? Math.min(ra * 1000, 15000) : waits[attempt];
        console.warn("LLM 429, retrying in", wait, "ms");
        await new Promise((res) => setTimeout(res, wait));
        continue;
      }
      if (!r.ok) {
        const err = new Error("LLM Gateway error " + r.status + ": " + (await r.text()));
        err.status = r.status;
        throw err;
      }
      const data = await r.json();
      const content = data?.choices?.[0]?.message?.content;
      if (!content) throw new Error("LLM Gateway returned no content");
      return content;
    }
    throw lastErr;
  });
}

// Pull the first JSON object out of a model reply (models sometimes wrap it in
// prose or ```json fences, or emit <think> blocks).
function extractJSON(text) {
  const cleaned = String(text).replace(/<think>[\s\S]*?<\/think>/g, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object in model reply");
  return JSON.parse(cleaned.slice(start, end + 1));
}

function transcriptText(history, persona) {
  return history
    .map((m) => (m.role === "user" ? "REP" : persona.name.toUpperCase()) + ": " + m.content)
    .join("\n");
}

const NUDGE_CATEGORIES = [
  "objection", "value", "discovery", "specifics", "next-step", "rapport", "concise", "good",
];

// Coaching nudge: reads the conversation so far and returns ONE short tip for
// the rep's next move (shown as text in the sidebar, never spoken).
app.post("/api/coach-nudge", async (req, res) => {
  if (!ASSEMBLYAI_API_KEY) return res.status(500).json({ error: "ASSEMBLYAI_API_KEY is not set" });
  const { personaId, history } = req.body || {};
  const persona = getPersona(personaId);
  if (!persona) return res.status(400).json({ error: `Unknown personaId: ${personaId}` });
  if (!Array.isArray(history) || history.length === 0)
    return res.status(400).json({ error: "Missing 'history' array" });

  const system = `You are a live sales coach whispering in a rep's ear during a practice call with
a simulated customer (${persona.name}, ${persona.role}). Read the conversation and give ONE coaching
nudge for the rep's NEXT reply. Look for: an unaddressed or dodged objection, a vague claim that
needs a number or proof point, a missed chance to ask a discovery question, rambling, or no clear
next step. If the rep just did something well, say so briefly.

Respond with ONLY a JSON object, no other text:
{"category": one of ${JSON.stringify(NUDGE_CATEGORIES)}, "nudge": "max 14 words, imperative, specific to this moment"}`;

  if (llmPending >= 2) return res.json({ nudge: null }); // keep the queue free for replies

  try {
    const raw = await callLLM(
      [
        { role: "system", content: system },
        { role: "user", content: "Conversation so far:\n" + transcriptText(history, persona) },
      ],
      { maxTokens: 120, temperature: 0.2 }
    );
    const parsed = extractJSON(raw);
    const nudge = String(parsed.nudge || "").trim();
    if (!nudge) return res.json({ nudge: null });
    const category = NUDGE_CATEGORIES.includes(parsed.category) ? parsed.category : "value";
    res.json({ nudge, category });
  } catch (err) {
    console.error("coach-nudge error:", err.message);
    // Nudges are best-effort: never let them break the call.
    res.status(err.status || 502).json({ error: "coach-nudge failed", detail: err.message });
  }
});

const clampScore = (n) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
const strList = (a, max) =>
  (Array.isArray(a) ? a : []).map((s) => String(s).trim()).filter(Boolean).slice(0, max);

// Post-session scorecard: one LLM call over the whole transcript.
app.post("/api/scorecard", async (req, res) => {
  if (!ASSEMBLYAI_API_KEY) return res.status(500).json({ error: "ASSEMBLYAI_API_KEY is not set" });
  const { personaId, history, metrics } = req.body || {};
  const persona = getPersona(personaId);
  if (!persona) return res.status(400).json({ error: `Unknown personaId: ${personaId}` });
  if (!Array.isArray(history) || history.filter((m) => m.role === "user").length < 1)
    return res.status(400).json({ error: "Need at least one rep turn to score" });

  const system = `You are an expert sales coach grading a practice call. The REP pitched a simulated
customer (${persona.name}, ${persona.role}, difficulty: ${persona.difficulty}). Grade ONLY the rep.
Be honest and specific — quote or reference what the rep actually said. Do not inflate scores;
a rep who dodged objections or gave vague claims should score below 60.

Respond with ONLY a JSON object, no other text, in exactly this shape:
{
 "overall": 0-100 integer,
 "headline": "one-sentence verdict, max 20 words",
 "categories": {
   "discovery": 0-100,        // asked good questions to understand the customer's needs
   "objection_handling": 0-100,
   "value_articulation": 0-100, // specific, quantified, tied to the customer's problem
   "closing": 0-100           // proposed a clear next step
 },
 "strengths": ["2-3 items, each one sentence, specific"],
 "missed_opportunities": ["2-3 items, each one sentence, say what the rep should have said/done"],
 "best_moment": "short quote from the rep's strongest line",
 "drills": ["2-3 concrete practice drills for next time, each one sentence"]
}`;

  const metricsLine = metrics
    ? `\nObjective metrics measured client-side: ${JSON.stringify(metrics)}`
    : "";

  try {
    const raw = await callLLM(
      [
        { role: "system", content: system },
        { role: "user", content: "Call transcript:\n" + transcriptText(history, persona) + metricsLine },
      ],
      { maxTokens: 900, temperature: 0.2 }
    );
    const p = extractJSON(raw);
    const c = p.categories || {};
    res.json({
      overall: clampScore(p.overall),
      headline: String(p.headline || "").trim(),
      categories: {
        discovery: clampScore(c.discovery),
        objection_handling: clampScore(c.objection_handling),
        value_articulation: clampScore(c.value_articulation),
        closing: clampScore(c.closing),
      },
      strengths: strList(p.strengths, 3),
      missed_opportunities: strList(p.missed_opportunities, 3),
      best_moment: String(p.best_moment || "").trim(),
      drills: strList(p.drills, 3),
    });
  } catch (err) {
    console.error("scorecard error:", err.message);
    res.status(err.status || 502).json({ error: "scorecard failed", detail: err.message });
  }
});

// ---- static demo pages ------------------------------------------------

app.use("/stt-demo", express.static(path.join(__dirname, "stt-demo/public")));
app.use("/tts-demo", express.static(path.join(__dirname, "tts-demo/public")));
app.use("/app", express.static(path.join(__dirname, "app/public")));
app.use("/roleplay-demo", express.static(path.join(__dirname, "roleplay-demo/public")));

app.get("/", (req, res) => res.redirect("/app/"));

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
