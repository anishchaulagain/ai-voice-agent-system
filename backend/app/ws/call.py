import asyncio
import logging
from datetime import datetime, timezone

from fastapi import WebSocket, WebSocketDisconnect

from app import conversation
from app.services import call_store, llm, stt, tts

log = logging.getLogger(__name__)


async def _send_json(ws: WebSocket, payload: dict) -> None:
    try:
        await ws.send_json(payload)
    except Exception:
        log.debug("send_json failed", exc_info=True)


async def _send_bytes(ws: WebSocket, data: bytes) -> None:
    try:
        await ws.send_bytes(data)
    except Exception:
        log.debug("send_bytes failed", exc_info=True)


async def _speak(ws: WebSocket, text: str) -> None:
    """Synthesize text to audio and stream MP3 chunks to the client."""
    if not text.strip():
        return
    await _send_json(ws, {"type": "audio_start", "format": tts.audio_mime_type()})
    try:
        async for chunk in tts.synthesize(text):
            await _send_bytes(ws, chunk)
    except Exception as e:
        log.exception("TTS failed")
        await _send_json(ws, {"type": "error", "message": f"TTS error: {e}"})
    finally:
        await _send_json(ws, {"type": "audio_end"})


async def _generate_and_speak_reply(ws: WebSocket, session: conversation.Session) -> bool:
    """Stream LLM tokens; flush each completed sentence to TTS as soon as it's ready.

    Returns True if the call should end after this turn.
    """
    text_buf = ""
    full_text = ""
    spoke_any = False

    try:
        async for delta in llm.stream_reply(session.history_for_llm()):
            full_text += delta
            text_buf += delta
            await _send_json(ws, {"type": "assistant_text_delta", "text": delta})

            sentences, text_buf = conversation.split_sentences(text_buf)
            for s in sentences:
                clean, _ = conversation.strip_end_token(s)
                if clean:
                    if not spoke_any:
                        spoke_any = True
                    await _speak(ws, clean)
    except Exception as e:
        log.exception("LLM stream failed")
        await _send_json(ws, {"type": "error", "message": f"LLM error: {e}"})
        return False

    # Flush trailing buffer that didn't end with punctuation
    tail = text_buf.strip()
    if tail:
        clean, _ = conversation.strip_end_token(tail)
        if clean:
            await _speak(ws, clean)

    clean_full, ended = conversation.strip_end_token(full_text)
    if ended and not session.can_end():
        log.info(
            "model tried to end call after only %d user turn(s); suppressing",
            session.user_turns,
        )
        ended = False
    session.append_assistant(clean_full)
    await _send_json(
        ws,
        {"type": "assistant_text_done", "text": clean_full, "ended": ended},
    )
    return ended


async def handle_call(ws: WebSocket) -> None:
    await ws.accept()
    started_at = datetime.now(timezone.utc)
    ended_reason = "disconnected"
    session = conversation.new_session()
    await _send_json(ws, {"type": "session", "session_id": session.id})
    log.info("call started: %s", session.id)

    # Speak opener
    await _send_json(
        ws,
        {"type": "assistant_text_done", "text": conversation.OPENER, "ended": False},
    )
    await _speak(ws, conversation.OPENER)

    audio_buffer = bytearray()

    try:
        while True:
            msg = await ws.receive()

            if msg.get("type") == "websocket.disconnect":
                break

            if "bytes" in msg and msg["bytes"] is not None:
                audio_buffer.extend(msg["bytes"])
                log.info("audio chunk received: %d bytes (buffer=%d)", len(msg["bytes"]), len(audio_buffer))
                continue

            if "text" not in msg or msg["text"] is None:
                continue

            try:
                payload = _parse_json(msg["text"])
            except ValueError:
                await _send_json(ws, {"type": "error", "message": "invalid json"})
                continue

            mtype = payload.get("type")

            if mtype == "user_audio_end":
                log.info("user_audio_end received: buffer=%d bytes", len(audio_buffer))
                if not audio_buffer:
                    log.warning("user_audio_end with empty buffer — no audio arrived from client")
                    continue
                blob = bytes(audio_buffer)
                audio_buffer.clear()

                try:
                    text = await stt.transcribe(blob, filename="utterance.webm")
                except Exception as e:
                    log.exception("STT failed")
                    await _send_json(ws, {"type": "error", "message": f"STT error: {e}"})
                    continue

                log.info("STT transcript: %r", text)
                if not text:
                    await _send_json(ws, {"type": "user_transcript", "text": ""})
                    continue

                await _send_json(ws, {"type": "user_transcript", "text": text})
                session.append_user(text)

                ended = await _generate_and_speak_reply(ws, session)
                if ended:
                    session.ended = True
                    ended_reason = "agent_ended"
                    await _send_json(ws, {"type": "call_ended"})
                    break

            elif mtype == "end":
                ended_reason = "user_ended"
                break

            elif mtype == "ping":
                await _send_json(ws, {"type": "pong"})

    except WebSocketDisconnect:
        log.info("client disconnected: %s", session.id)
    except asyncio.CancelledError:
        raise
    except Exception:
        log.exception("call handler error")
    finally:
        # Persist before dropping the session. Shielded so server-shutdown
        # cancellation can't abort the write mid-way; BaseException so a
        # CancelledError here can't skip drop_session/ws.close either.
        try:
            call_id = await asyncio.shield(
                call_store.save_call(session, started_at, ended_reason)
            )
            if call_id:
                call_store.schedule_extraction(call_id)
        except BaseException:
            log.exception("failed to persist call %s", session.id)
        conversation.drop_session(session.id)
        try:
            await ws.close()
        except Exception:
            pass


def _parse_json(s: str) -> dict:
    import json

    try:
        v = json.loads(s)
    except json.JSONDecodeError as e:
        raise ValueError(str(e)) from e
    if not isinstance(v, dict):
        raise ValueError("expected object")
    return v
