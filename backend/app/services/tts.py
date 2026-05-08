import logging
from collections.abc import AsyncIterator

import edge_tts
from openai import AsyncOpenAI

from app.config import settings

log = logging.getLogger(__name__)

# Default Edge voice — natural-sounding female US English. Override with TTS_PROVIDER=edge + custom code if needed.
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


async def _synthesize_edge(text: str) -> AsyncIterator[bytes]:
    communicate = edge_tts.Communicate(text, EDGE_VOICE)
    async for event in communicate.stream():
        if event["type"] == "audio":
            yield event["data"]


async def synthesize(text: str) -> AsyncIterator[bytes]:
    """Yield MP3 audio chunks for the given text."""
    if not text or not text.strip():
        return
    if settings.tts_provider == "edge":
        async for chunk in _synthesize_edge(text):
            yield chunk
    else:
        async for chunk in _synthesize_openai(text):
            yield chunk


def audio_mime_type() -> str:
    return "audio/mpeg"
