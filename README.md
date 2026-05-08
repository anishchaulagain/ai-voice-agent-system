# Nexbizio AI Calling Agent — POC

A browser-based proof-of-concept for an AI marketing-call agent that pitches **Nexbizio** (a B2B buyer-seller marketplace). The browser is the "phone": mic captures the caller, AI talks back through the speakers. No telephony required.

```
[Browser]                                   [FastAPI backend]
  Mic ──MediaRecorder──┐                         ┌─→ Whisper (STT)
                       ├─WebSocket(audio chunks)─├─→ GPT-4o-mini  (streaming)
  Speaker ←──audio────┘                          └─→ TTS  (per sentence) ──┐
                       ←──WebSocket(audio chunks)─────────────────────────┘
  Energy-based VAD on the client → flushes utterance when caller stops talking
```

**Stack**
- Backend: FastAPI + WebSockets, Python 3.12
- Frontend: Next.js 16 (client component, MediaRecorder + Web Audio API)
- Providers: **OpenAI** (Whisper / GPT-4o-mini / TTS-1) — primary; **Groq** (Llama 3.3 70B + Whisper) — fallback. Switch in `backend/.env`.

## 1. Backend

```powershell
cd backend
py -3.12 -m venv .venv          # or: C:\Users\<you>\anaconda3\python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
# Edit backend\.env and paste your OPENAI_API_KEY
python -m app.main
```

Runs on `http://localhost:8000`. Quick check: `curl http://localhost:8000/health`.

## 2. Frontend

```powershell
cd frontend
npm install
npm run dev
```

Open `http://localhost:3000`, click **Start call**, allow mic. Maya will introduce Nexbizio; respond naturally — there's no push-to-talk.

## Switching to Groq

Edit `backend/.env`:

```
STT_PROVIDER=groq
LLM_PROVIDER=groq
TTS_PROVIDER=edge      # Groq has no TTS — use free Microsoft Edge voices
GROQ_API_KEY=gsk_...
```

Restart the backend. No code changes needed.

## How turn-taking works

The client polls the mic's RMS volume every ~60 ms. When energy crosses the threshold the caller is "speaking"; ~900 ms of silence after that flushes the utterance to the backend. While Maya is speaking, the caller's mic is ignored to prevent feedback. Tune `SILENCE_RMS_THRESHOLD`, `MIN_SPEECH_MS`, and `SILENCE_HANGOVER_MS` in [frontend/app/CallApp.tsx](frontend/app/CallApp.tsx) if your mic or environment is unusually loud/quiet.

## Latency budget (with OpenAI)

| Stage | Typical |
|---|---|
| STT (whisper-1, ~3 s utterance) | 800–1500 ms |
| LLM first token (gpt-4o-mini) | 400–700 ms |
| TTS first sentence (tts-1) | 500–800 ms |
| **Caller hears first word** | **~1.7–3 s after they stop** |

Sentences are streamed through TTS as soon as the LLM finishes each one, so Maya starts replying long before her full answer is generated.

## Files

- [backend/app/main.py](backend/app/main.py) — FastAPI entry
- [backend/app/ws/call.py](backend/app/ws/call.py) — WebSocket call handler (the pipeline)
- [backend/app/services/](backend/app/services/) — STT / LLM / TTS wrappers
- [backend/app/prompts.py](backend/app/prompts.py) — Maya's system prompt (edit this to refine the pitch)
- [frontend/app/CallApp.tsx](frontend/app/CallApp.tsx) — call UI + VAD + audio queue
