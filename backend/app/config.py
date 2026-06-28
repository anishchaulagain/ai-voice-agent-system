from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    stt_provider: Literal["openai", "groq"] = "openai"
    llm_provider: Literal["openai", "groq"] = "openai"
    tts_provider: Literal["openai", "groq", "edge", "elevenlabs"] = "openai"

    openai_api_key: str = ""
    openai_stt_model: str = "whisper-1"
    openai_llm_model: str = "gpt-4o-mini"
    openai_tts_model: str = "tts-1"
    openai_tts_voice: str = "alloy"

    groq_api_key: str = ""
    groq_stt_model: str = "whisper-large-v3-turbo"
    groq_llm_model: str = "llama-3.3-70b-versatile"
    groq_tts_model: str = "playai-tts"
    groq_tts_voice: str = "Celeste-PlayAI"
    groq_base_url: str = "https://api.groq.com/openai/v1"

    elevenlabs_api_key: str = ""
    # Default: "Sarah" (soft, professional US female) — works on free tier. Most "library"
    # voices (Rachel, Aria, Charlotte) are paywalled; only a handful of default voices
    # (Sarah, Matilda, Jessica, Laura, River) are callable via API on free accounts.
    elevenlabs_voice_id: str = "EXAVITQu4vr4xnSDxMaL"
    # turbo_v2_5 = best latency/quality for voice agents. Alternatives: eleven_flash_v2_5, eleven_multilingual_v2.
    elevenlabs_model: str = "eleven_turbo_v2_5"

    host: str = "0.0.0.0"
    port: int = 8000
    cors_origins: str = "http://localhost:3000"
    log_level: str = "info"

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


settings = Settings()
