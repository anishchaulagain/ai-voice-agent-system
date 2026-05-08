import logging
from collections.abc import AsyncIterator

import edge_tts
from openai import AsyncOpenAI

from app.config import settings

log = logging.getLogger(__name__)

# Default Edge voice — natural-sounding female US English.
EDGE_VOICE = "en-US-AriaNeural"


async def _synthesize_openai(text: str) -> AsyncIterator[bytes]:
    if not settings.openai_api_key:
        raise RuntimeError("OPENAI_API_KEY is not set but TTS_PROVIDER=openai")
    client = AsyncOpenAI(api_key=settings.openai_api_key)
    async with client.audio.speech.with_streaming_response.create(
        model=settings.openai_tts_model,
        voice=settings.openai_tts_voice,
        input=text,
        response_format="mp3",
    ) as resp:
        async for chunk in resp.iter_bytes(chunk_size=4096):
            if chunk:
                yield chunk


async def _synthesize_groq(text: str) -> AsyncIterator[bytes]:
    if not settings.groq_api_key:
        raise RuntimeError("GROQ_API_KEY is not set but TTS_PROVIDER=groq")
    client = AsyncOpenAI(
        api_key=settings.groq_api_key, base_url=settings.groq_base_url
    )
    # Groq's PlayAI TTS does not support streaming yet; the OpenAI-compatible
    # endpoint returns the full file. We chunk it on the way out.
    async with client.audio.speech.with_streaming_response.create(
        model=settings.groq_tts_model,
        voice=settings.groq_tts_voice,
        input=text,
        response_format="wav",
    ) as resp:
        async for chunk in resp.iter_bytes(chunk_size=4096):
            if chunk:
                yield chunk


async def _synthesize_edge(text: str) -> AsyncIterator[bytes]:
    communicate = edge_tts.Communicate(text, EDGE_VOICE)
    async for event in communicate.stream():
        if event["type"] == "audio":
            yield event["data"]


async def synthesize(text: str) -> AsyncIterator[bytes]:
    """Yield audio chunks for the given text."""
    if not text or not text.strip():
        return
    if settings.tts_provider == "groq":
        async for chunk in _synthesize_groq(text):
            yield chunk
    elif settings.tts_provider == "edge":
        async for chunk in _synthesize_edge(text):
            yield chunk
    else:
        async for chunk in _synthesize_openai(text):
            yield chunk


def audio_mime_type() -> str:
    # Groq returns wav; OpenAI/Edge return mp3. The browser <audio> element
    # detects the format from the bytes, so a generic type works for both.
    return "audio/mpeg" if settings.tts_provider != "groq" else "audio/wav"
