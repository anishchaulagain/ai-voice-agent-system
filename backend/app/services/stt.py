import io
import logging

from openai import AsyncOpenAI

from app.config import settings

log = logging.getLogger(__name__)


def _client() -> tuple[AsyncOpenAI, str]:
    if settings.stt_provider == "groq":
        if not settings.groq_api_key:
            raise RuntimeError("GROQ_API_KEY is not set but STT_PROVIDER=groq")
        return (
            AsyncOpenAI(api_key=settings.groq_api_key, base_url=settings.groq_base_url),
            settings.groq_stt_model,
        )
    if not settings.openai_api_key:
        raise RuntimeError("OPENAI_API_KEY is not set but STT_PROVIDER=openai")
    return AsyncOpenAI(api_key=settings.openai_api_key), settings.openai_stt_model


async def transcribe(audio_bytes: bytes, filename: str = "audio.webm") -> str:
    """Transcribe an audio blob and return the recognized text."""
    if not audio_bytes:
        return ""

    client, model = _client()
    buf = io.BytesIO(audio_bytes)
    buf.name = filename

    resp = await client.audio.transcriptions.create(
        model=model,
        file=buf,
        response_format="text",
    )
    text = resp if isinstance(resp, str) else getattr(resp, "text", "")
    return (text or "").strip()
