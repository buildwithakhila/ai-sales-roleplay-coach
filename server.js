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
    const r = await fetch(ASSEMBLYAI_LLM_URL, {
      method: "POST",
      headers: {
        authorization: ASSEMBLYAI_API_KEY,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: ASSEMBLYAI_LLM_MODEL,
        messages,
        max_tokens: 200,
      }),
    });
    if (!r.ok) {
      const body = await r.text();
      console.error("LLM Gateway error:", r.status, body);
      return res
        .status(r.status)
        .json({ error: "LLM Gateway request failed", detail: body });
    }
    const data = await r.json();
    const reply = data?.choices?.[0]?.message?.content;
    if (!reply) {
      console.error("LLM Gateway: no reply in response", JSON.stringify(data));
      return res.status(502).json({ error: "LLM Gateway returned no reply" });
    }
    res.json({ reply: reply.trim() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

// ---- static demo pages ------------------------------------------------

app.use("/stt-demo", express.static(path.join(__dirname, "stt-demo/public")));
app.use("/tts-demo", express.static(path.join(__dirname, "tts-demo/public")));
app.use("/roleplay-demo", express.static(path.join(__dirname, "roleplay-demo/public")));

app.get("/", (req, res) => {
  res.send(
    '<h1>AI Sales Roleplay Coach — demos</h1><ul>' +
      '<li><a href="/roleplay-demo/">Week 2: live roleplay call vs AI customer</a></li>' +
      '<li><a href="/stt-demo/">Week 1: STT demo (mic → live transcript)</a></li>' +
      '<li><a href="/tts-demo/">Week 1: TTS demo (text → speech)</a></li>' +
      "</ul>"
  );
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
