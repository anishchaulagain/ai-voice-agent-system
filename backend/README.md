# Nexbizio Calling Agent — Backend

FastAPI server that runs an AI marketing-call agent over a WebSocket. The browser is the "phone": it captures the caller's mic, streams audio to this server, and plays the agent's spoken reply back.

## Pipeline

```
browser mic ──audio bytes──▶ /ws/call ──▶ STT ──▶ LLM (streaming) ──▶ TTS (per sentence) ──▶ browser speaker
```

- **STT / LLM / TTS** are pluggable: OpenAI by default, Groq for STT+LLM, Edge for TTS. Set the provider in `.env`.
- LLM responses are streamed and chunked into sentences so the agent starts speaking before it has finished "thinking".

## Setup

```powershell
cd backend
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy .env.example .env
# edit .env and set OPENAI_API_KEY (and optionally GROQ_API_KEY)
```

## Run

```powershell
python -m app.main
```

Server starts on `http://localhost:8000`. Health check at `/health`. Call endpoint at `ws://localhost:8000/ws/call`.

## Switching providers

Change these in `.env`:

```
STT_PROVIDER=openai      # or: groq
LLM_PROVIDER=openai      # or: groq
TTS_PROVIDER=openai      # or: edge   (free, uses Microsoft Edge voices)
```

## WebSocket protocol

**Client → Server**

| Message | Meaning |
|---|---|
| binary frame | audio chunk (browser MediaRecorder, webm/opus) |
| `{"type":"user_audio_end"}` | flush buffered audio → STT → LLM → TTS reply |
| `{"type":"end"}` | hang up |
| `{"type":"ping"}` | keepalive |

**Server → Client**

| Message | Meaning |
|---|---|
| `{"type":"session","session_id":...}` | sent on connect |
| `{"type":"user_transcript","text":...}` | what STT heard |
| `{"type":"assistant_text_delta","text":...}` | streamed LLM tokens |
| `{"type":"assistant_text_done","text":...,"ended":bool}` | end of LLM turn |
| `{"type":"audio_start","format":"audio/mpeg"}` | next binary frames are MP3 |
| binary frame | MP3 audio chunk |
| `{"type":"audio_end"}` | end of one TTS segment |
| `{"type":"call_ended"}` | the agent hung up |
| `{"type":"error","message":...}` | recoverable error |
