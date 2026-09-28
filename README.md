# AI Sales Roleplay Coach

Built for the [AssemblyAI Voice Agent Hackathon](https://lablab.ai/ai-hackathons/assemblyai-voice-agent-hackathon) (Sep 1–30, 2026).

Reps practice a sales call **out loud** against an AI-voiced customer, get **live coaching nudges**
while they talk, and a **scorecard** when they hang up.

## How a call works

1. **Pick a buyer** — a blunt CFO (Hard), a budget-conscious agency owner (Medium), or a
   security-minded IT director (Medium-Hard). Each has its own personality, objections and voice.
2. **Talk** — your mic is transcribed live; the customer answers in character, out loud. A
   "Live coach" sidebar shows short text nudges (never spoken, so they don't talk over the customer).
3. **Get scored** — overall score, discovery / objection handling / value articulation / closing
   scores, what worked, what you missed, your best line, and practice drills.

No microphone handy? Click **Score a sample call** on the start screen to see the scorecard.

## Architecture

- **Speech-to-text:** [AssemblyAI](https://www.assemblyai.com/) Realtime Streaming API (v3 WebSocket). The
  browser streams 16 kHz PCM16 straight to AssemblyAI using a **short-lived token minted by the server**
  (`GET /api/stt-token`), so the API key never reaches the client. AssemblyAI's `end_of_turn` flag
  drives turn-taking — no custom silence detection.
- **LLM:** [AssemblyAI LLM Gateway](https://www.assemblyai.com/docs/llm-gateway/overview)
  (OpenAI-compatible, same `ASSEMBLYAI_API_KEY`) for three jobs:
  - `POST /api/persona-reply` — the customer's next in-character line
  - `POST /api/coach-nudge` — one short coaching tip per rep turn
  - `POST /api/scorecard` — full-transcript scoring when the call ends
  Default model is `qwen3.5-4b-32k-fast` (the one enabled on the hackathon account); override with
  `ASSEMBLYAI_LLM_MODEL`.
- **Text-to-speech:** [Deepgram Aura-2](https://deepgram.com/), one voice per persona (`POST /api/tts`).
  (ElevenLabs was the original plan; its free tier blocks every voice via the API.)

Design notes:

- Instant, zero-latency nudges (filler words, rambling turns) run locally in the browser; the LLM handles
  the judgment calls (dodged objections, vague claims, missed next step).
- LLM calls are sequenced per turn and retried with backoff on 429s to stay inside free-tier rate limits.
- While the customer is speaking the mic is muted so its own voice isn't transcribed as the rep's.
- LLM output is rendered with `textContent` only, never as HTML.

## Run locally

Requires Node.js 18+.

```bash
npm install
cp .env.example .env
# fill in ASSEMBLYAI_API_KEY and DEEPGRAM_API_KEY
npm start
```

Open `http://localhost:3000/` (Chrome recommended; allow microphone access).

Earlier build-stage demos are still served: `/roleplay-demo/` (Week 2 loop), `/stt-demo/`, `/tts-demo/`.

## API keys

**AssemblyAI:** if you already have an account, log out first and use the hackathon's signup link
(hackathon page → Challenge → Resources → "Sign up for an API account") so the hackathon credits are attached.

**Deepgram:** sign up at [console.deepgram.com/signup](https://console.deepgram.com/signup) (free trial credit).

## Deploy (Replit)

The app needs a long-lived Node server, so serverless hosts don't fit. On Replit:

1. Create a Repl from this GitHub repo (Import from GitHub).
2. Add **Secrets**: `ASSEMBLYAI_API_KEY` and `DEEPGRAM_API_KEY` (the `.env` file is gitignored and is not deployed).
3. Press Run to test, then **Deploy** (Autoscale or Reserved VM) with run command `npm start`.
4. Open the HTTPS deployment URL — browsers only allow microphone access on HTTPS or localhost.

The server reads `PORT` from the environment and defaults to 3000.

## Built with AI assistance

This project was built with [Claude](https://claude.ai) as a coding assistant, under Akhila's direction;
you'll see Claude listed as a commit author/co-author in the git history.
