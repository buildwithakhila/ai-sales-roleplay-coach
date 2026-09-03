# AI Sales Roleplay Coach

Built for the [AssemblyAI Voice Agent Hackathon](https://lablab.ai/ai-hackathons/assemblyai-voice-agent-hackathon) (Sep 1–30, 2026).

Reps practice sales calls against an AI-voiced simulated customer persona, get live
coaching nudges during the roleplay, and get a scorecard after. See `/docs` in this
repo (coming in Week 3) for the full product write-up.

## Architecture

Two speech technologies, opposite directions:

- **Speech-to-text (STT):** [AssemblyAI](https://www.assemblyai.com/) Realtime Streaming API — the rep's mic audio becomes a live transcript.
- **Text-to-speech (TTS):** [ElevenLabs](https://elevenlabs.io/) — turns the AI customer persona's written reply into audio.

Full pipeline (target — see Week-by-week below for what's built so far):

1. Browser mic → WebSocket → AssemblyAI Realtime STT → live transcript
2. Transcript → customer-persona LLM (in-character reply) → ElevenLabs TTS → played back as "the customer"
3. Transcript → coaching LLM (parallel, lighter/faster) → text nudges in a sidebar
4. End of session → one more LLM call → scorecard (strengths, missed opportunities, score, drills)

## Week-by-week status

- **Week 1 (this repo, so far):** de-risk the two hardest unknowns in isolation.
  - `stt-demo/` — raw mic → live transcript, working end to end against AssemblyAI.
  - `tts-demo/` — bare text → spoken audio, working end to end against ElevenLabs.
  - Deliberately kept separate so an STT bug and a TTS bug can never be confused with each other.
- **Week 2:** wire STT → persona LLM → TTS into one live back-and-forth; 2–3 customer personas.
- **Week 3:** coaching-nudge pass + post-session scorecard + real UI.
- **Week 4:** deploy, demo video, slide deck, submit.

## Running the Week 1 demos

Requires Node.js 18+ (native `fetch` support).

```bash
npm install
cp .env.example .env
# fill in ASSEMBLYAI_API_KEY and ELEVENLABS_API_KEY in .env
npm start
```

Then open:

- `http://localhost:3000/stt-demo/` — click "Start", speak into your mic, watch the live transcript.
- `http://localhost:3000/tts-demo/` — type text, click "Speak", hear it played back.

Both demos are self-contained pages backed by two small server routes
(`server.js`): the browser never sees your raw API keys.

- **STT:** the server mints a short-lived AssemblyAI token (`GET /api/stt-token`); the browser
  connects *directly* to AssemblyAI's streaming WebSocket with that token, captures mic audio via
  the Web Audio API, downsamples it to 16kHz PCM16, and streams it up as it talks. Transcripts
  (partial + final) come back as JSON `Turn` messages.
- **TTS:** the browser POSTs text to the server (`POST /api/tts`), the server calls ElevenLabs'
  REST API with the real key, and streams the resulting MP3 back to the browser to play.

## Getting API keys

**AssemblyAI:** if you already have an AssemblyAI account, log out first, then use the
hackathon's own signup link (Challenge tab → Resources → "Sign up for an API account" on the
[hackathon page](https://lablab.ai/ai-hackathons/assemblyai-voice-agent-hackathon), while logged
into lablab.ai) so the hackathon credits get attached to the new account. Grab the API key from
your AssemblyAI dashboard.

**ElevenLabs:** sign up at [elevenlabs.io](https://elevenlabs.io/sign-up), grab an API key from
Settings → API Keys. The free tier is enough for this demo.

## Deploying

Build plan favors [Replit](https://replit.com/) for the eventual live demo — it holds a
persistent WebSocket open, which serverless platforms (e.g. Vercel functions) don't do well.
