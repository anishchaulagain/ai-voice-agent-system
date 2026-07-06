import logging
from collections.abc import AsyncIterator

from openai import AsyncOpenAI

from app.config import settings

log = logging.getLogger(__name__)


def _client() -> tuple[AsyncOpenAI, str]:
    if settings.llm_provider == "groq":
        if not settings.groq_api_key:
            raise RuntimeError("GROQ_API_KEY is not set but LLM_PROVIDER=groq")
        return (
            AsyncOpenAI(api_key=settings.groq_api_key, base_url=settings.groq_base_url),
            settings.groq_llm_model,
        )
    if settings.llm_provider == "openrouter":
        if not settings.openrouter_api_key:
            raise RuntimeError(
                "OPENROUTER_API_KEY is not set but LLM_PROVIDER=openrouter"
            )
        return (
            AsyncOpenAI(
                api_key=settings.openrouter_api_key,
                base_url=settings.openrouter_base_url,
                # Optional attribution headers OpenRouter uses for ranking; harmless.
                default_headers={
                    "HTTP-Referer": "https://nexbizio.com",
                    "X-Title": "Nexbizio Calling Agent",
                },
            ),
            settings.openrouter_model,
        )
    if not settings.openai_api_key:
        raise RuntimeError("OPENAI_API_KEY is not set but LLM_PROVIDER=openai")
    return AsyncOpenAI(api_key=settings.openai_api_key), settings.openai_llm_model


async def stream_reply(messages: list[dict]) -> AsyncIterator[str]:
    """Yield text deltas from the chat model for the given message history."""
    client, model = _client()
    stream = await client.chat.completions.create(
        model=model,
        messages=messages,
        temperature=0.6,
        max_tokens=160,  # Maya is told to keep replies to 1-2 sentences; cap enforces faster completion
        stream=True,
    )
    async for chunk in stream:
        if not chunk.choices:
            continue
        delta = chunk.choices[0].delta
        if delta and delta.content:
            yield delta.content
