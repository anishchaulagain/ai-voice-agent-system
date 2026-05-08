import io
import logging
import re

from openai import AsyncOpenAI

from app.config import settings

log = logging.getLogger(__name__)

# Whisper hallucinates these common phrases when the audio is silence,
# noise, or a tiny mic blip. If the transcript matches one of these
# *exactly* (after normalization), we treat it as silence.
_HALLUCINATION_PHRASES = frozenset(
    {
        "thank you",
        "thanks",
        "thanks for watching",
        "thank you for watching",
        "thanks a lot",
        "thank you very much",
        "thanks so much",
        "thanks for listening",
        "thank you for listening",
        "you",
        "",
        "[music]",
        "[blank_audio]",
        "[silence]",
        "music",
        "applause",
    }
)

_PUNCT_RE = re.compile(r"[\.\,\!\?…—\-\s]+")


def _normalize(text: str) -> str:
    # Lowercase, strip leading/trailing punctuation/whitespace, collapse internal whitespace.
    s = text.strip().lower()
    s = _PUNCT_RE.sub(" ", s).strip()
    return s


def _is_hallucination(text: str) -> bool:
    return _normalize(text) in _HALLUCINATION_PHRASES


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
        temperature=0.0,
    )
    text = resp if isinstance(resp, str) else getattr(resp, "text", "")
    text = (text or "").strip()

    if _is_hallucination(text):
        log.info("dropped likely Whisper hallucination: %r", text)
        return ""
    return text
