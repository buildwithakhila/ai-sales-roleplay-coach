# AI Sales Roleplay Coach

Built for the [AssemblyAI Voice Agent Hackathon](https://lablab.ai/ai-hackathons/assemblyai-voice-agent-hackathon) (Sep 1–30, 2026).

Reps practice sales calls against an AI-voiced simulated customer persona, get live
coaching nudges during the roleplay, and get a scorecard after. See `/docs` in this
repo (coming in Week 3) for the full product write-up.

## Architecture

Two speech technologies, opposite directions:

- **Speech-to-text (STT):** [AssemblyAI](https://www.assemblyai.com/) Realtime Streaming API — the rep's mic audio becomes a live transcript.
- **Text-to-speech (TTS):** [Deepgram Aura](https://deepgram.com/) — turns the AI customer persona's written reply into audio. (Originally planned as ElevenLabs per the build plan — switched in Week 1 because ElevenLabs' free tier blocks *all* voices via the API, including ones added to "My Voices"; Deepgram's free trial credit has no such restriction. Revisit if/when there's budget for a paid ElevenLabs plan.)

Full pipeline (target — see Week-by-week below for what's built so far):

1. Browser mic → WebSocket → AssemblyAI Realtime STT → live transcript
2. Transcript → customer-persona LLM (in-character reply) → Deepgram TTS → played back as "the customer"
3. Transcript → coaching LLM (parallel, lighter/faster) → text nudges in a sidebar
4. End of session → one more LLM call → scorecard (strengths, missed opportunities, score, drills)

**LLM (Week 2):** the persona's replies come from [AssemblyAI's LLM Gateway](https://www.assemblyai.com/docs/llm-gateway/overview)
(`llm-gateway.assemblyai.com`, OpenAI-SDK-compatible `/v1/chat/completions`) rather than a
separate OpenAI/Anthropic key — same `ASSEMBLYAI_API_KEY` you already have, no new signup, 25+
models available (defaulting to `qwen3.5-4b-32k-fast` — the model AssemblyAI's own docs use in every example, and the one that turned out to actually be enabled on this account; Claude/GPT/Gemini via the Gateway returned "account does not have access to this LLM Gateway model" — worth revisiting if/when that opens up), and it keeps the story tied back to AssemblyAI for judging on "application of
technology." Override with `ASSEMBLYAI_LLM_URL` / `ASSEMBLYAI_LLM_MODEL` in `.env` if needed.

## Week-by-week status

- **Week 1:** de-risk the two hardest unknowns in isolation.
  - `stt-demo/` — raw mic → live transcript, working end to end against AssemblyAI.
  - `tts-demo/` — bare text → spoken audio, working end to end against Deepgram Aura.
  - Deliberately kept separate so an STT bug and a TTS bug can never be confused with each other.
- **Week 2 (this repo, so far):** wire STT → persona LLM → TTS into one live back-and-forth.
  - `roleplay-demo/` — pick one of 3 customer personas (skeptical CFO / price-sensitive
    SMB owner / technical IT director, each a different difficulty and Deepgram voice),
    then have a live back-and-forth call: your mic → AssemblyAI transcript → the
    persona's in-character reply from AssemblyAI's LLM Gateway → spoken back via
    Deepgram Aura. Turn-taking rides AssemblyAI's own `end_of_turn` flag, so no
    separate silence-detection logic was needed.
  - Not yet built: the coaching-nudge sidebar and post-session scorecard — that's Week 3.
- **Week 3:** coaching-nudge pass + post-session scorecard + real UI.
- **Week 4:** deploy, demo video, slide deck, submit.

## Running the demos

Requires Node.js 18+ (native `fetch` support).

```bash
npm install
cp .env.example .env
# fill in ASSEMBLYAI_API_KEY and DEEPGRAM_API_KEY in .env
npm start
```

Then open:

- `http://localhost:3000/roleplay-demo/` — Week 2: pick a customer persona and have a live
  roleplay call with them (mic in, persona voice back).
- `http://localhost:3000/stt-demo/` — Week 1: click "Start", speak into your mic, watch the
  live transcript.
- `http://localhost:3000/tts-demo/` — Week 1: type text, click "Speak", hear it played back.

Both demos are self-contained pages backed by two small server routes
(`server.js`): the browser never sees your raw API keys.

- **STT:** the server mints a short-lived AssemblyAI token (`GET /api/stt-token`); the browser
  connects *directly* to AssemblyAI's streaming WebSocket with that token, captures mic audio via
  the Web Audio API, downsamples it to 16kHz PCM16, and streams it up as it talks. Transcripts
  (partial + final) come back as JSON `Turn` messages.
- **TTS:** the browser POSTs text to the server (`POST /api/tts`), the server calls Deepgram's
  Aura REST API with the real key, and streams the resulting MP3 back to the browser to play.

## Getting API keys

**AssemblyAI:** if you already have an AssemblyAI account, log out first, then use the
hackathon's own signup link (Challenge tab → Resources → "Sign up for an API account" on the
[hackathon page](https://lablab.ai/ai-hackathons/assemblyai-voice-agent-hackathon), while logged
into lablab.ai) so the hackathon credits get attached to the new account. Grab the API key from
your AssemblyAI dashboard.

**Deepgram:** sign up at [console.deepgram.com/signup](https://console.deepgram.com/signup)
(free trial credit, no card usually required), grab an API key from the dashboard.

## Deploying

Build plan favors [Replit](https://replit.com/) for the eventual live demo — it holds a
persistent WebSocket open, which serverless platforms (e.g. Vercel functions) don't do well.
