import logging
from collections.abc import AsyncIterator

import edge_tts
from elevenlabs import VoiceSettings
from elevenlabs.client import AsyncElevenLabs
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


async def _synthesize_elevenlabs(text: str) -> AsyncIterator[bytes]:
    if not settings.elevenlabs_api_key:
        raise RuntimeError("ELEVENLABS_API_KEY is not set but TTS_PROVIDER=elevenlabs")
    client = AsyncElevenLabs(api_key=settings.elevenlabs_api_key)
    stream = client.text_to_speech.convert_as_stream(
        voice_id=settings.elevenlabs_voice_id,
        text=text,
        model_id=settings.elevenlabs_model,
        # 128 kbps ~= the fidelity of the ElevenLabs website preview. Drop to
        # mp3_44100_64 only if bandwidth/first-byte latency becomes a problem.
        output_format="mp3_44100_128",
        # No latency optimization -> full quality (levels 1-4 audibly degrade the
        # voice). turbo_v2_5 is fast enough that this is still fine for live calls.
        optimize_streaming_latency=0,
        # Soft, calm, human delivery — slower pace, steady tone (see config.py).
        voice_settings=VoiceSettings(
            stability=settings.elevenlabs_stability,
            similarity_boost=settings.elevenlabs_similarity,
            style=settings.elevenlabs_style,
            use_speaker_boost=settings.elevenlabs_speaker_boost,
            speed=settings.elevenlabs_speed,
        ),
    )
    async for chunk in stream:
        if chunk:
            yield chunk


async def synthesize(text: str) -> AsyncIterator[bytes]:
    """Yield audio chunks for the given text."""
    if not text or not text.strip():
        return
    if settings.tts_provider == "elevenlabs":
        async for chunk in _synthesize_elevenlabs(text):
            yield chunk
    elif settings.tts_provider == "groq":
        async for chunk in _synthesize_groq(text):
            yield chunk
    elif settings.tts_provider == "edge":
        async for chunk in _synthesize_edge(text):
            yield chunk
    else:
        async for chunk in _synthesize_openai(text):
            yield chunk


def audio_mime_type() -> str:
    # Groq's TTS returns wav; everyone else returns mp3. Browser <audio>
    # sniffs the format from the bytes anyway, so this is mainly informational.
    return "audio/wav" if settings.tts_provider == "groq" else "audio/mpeg"
