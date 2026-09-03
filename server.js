// Week 1 demo server.
//
// Two independent, isolated routes on purpose (see README):
//   GET  /api/stt-token   -> mints a short-lived AssemblyAI token for the browser
//   POST /api/tts         -> calls ElevenLabs TTS server-side and streams audio back
//
// Neither the AssemblyAI key nor the ElevenLabs key is ever sent to the browser.
require("dotenv").config();
const express = require("express");
const path = require("path");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID =
  process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM"; // stock "Rachel" voice

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
  if (!ELEVENLABS_API_KEY) {
    return res
      .status(500)
      .json({ error: "ELEVENLABS_API_KEY is not set on the server (.env)" });
  }
  const { text } = req.body || {};
  if (!text || !text.trim()) {
    return res.status(400).json({ error: "Missing 'text' in request body" });
  }
  try {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}?output_format=mp3_44100_128`;
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_multilingual_v2",
      }),
    });
    if (!r.ok) {
      const body = await r.text();
      console.error("ElevenLabs error:", r.status, body);
      return res
        .status(r.status)
        .json({ error: "ElevenLabs TTS request failed", detail: body });
    }
    const buf = Buffer.from(await r.arrayBuffer());
    res.set("Content-Type", "audio/mpeg");
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
