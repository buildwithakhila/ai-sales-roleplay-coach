// Week 1 demo server.
//
// Two independent, isolated routes on purpose (see README):
//   GET  /api/stt-token   -> mints a short-lived AssemblyAI token for the browser
//   POST /api/tts         -> calls Deepgram Aura TTS server-side and streams audio back
//
// Neither the AssemblyAI key nor the Deepgram key is ever sent to the browser.
//
// TTS vendor note: originally built against ElevenLabs per the build plan, but
// ElevenLabs' free tier blocks ALL voices (including "premade" ones) via the
// API - "Voice Library voices are not available via the API to free tier
// users" - full stop, even if you add the voice to "My Voices" first. Rather
// than pay to unblock it during Week 1, switched to Deepgram Aura, which has
// a generous free trial credit and no such restriction.
require("dotenv").config();
const express = require("express");
const path = require("path");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const DEEPGRAM_TTS_MODEL = process.env.DEEPGRAM_TTS_MODEL || "aura-2-thalia-en";

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
  const { text } = req.body || {};
  if (!text || !text.trim()) {
    return res.status(400).json({ error: "Missing 'text' in request body" });
  }
  try {
    const url = `https://api.deepgram.com/v1/speak?model=${encodeURIComponent(
      DEEPGRAM_TTS_MODEL
    )}`;
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

// ---- static demo pages ------------------------------------------------

app.use("/stt-demo", express.static(path.join(__dirname, "stt-demo/public")));
app.use("/tts-demo", express.static(path.join(__dirname, "tts-demo/public")));

app.get("/", (req, res) => {
  res.send(
    '<h1>AI Sales Roleplay Coach — Week 1 demos</h1><ul><li><a href="/stt-demo/">STT demo (mic → live transcript)</a></li><li><a href="/tts-demo/">TTS demo (text → speech)</a></li></ul>'
  );
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
