from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    stt_provider: Literal["openai", "groq"] = "openai"
    llm_provider: Literal["openai", "groq", "openrouter"] = "openai"
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

    # OpenRouter — OpenAI-compatible gateway to many models. Set LLM_PROVIDER=openrouter
    # to use it. Most models are paid (need credits at openrouter.ai/settings/credits);
    # models with a ":free" suffix work without credit but are heavily rate-limited.
    openrouter_api_key: str = ""
    openrouter_base_url: str = "https://openrouter.ai/api/v1"
    openrouter_model: str = "openai/gpt-4o-mini"

    elevenlabs_api_key: str = ""
    # Custom voice picked from the ElevenLabs voice library (requires a paid plan).
    # Free-tier fallbacks if needed: Sarah EXAVITQu4vr4xnSDxMaL, Rachel 21m00Tcm4TlvDq8ikWAM.
    elevenlabs_voice_id: str = "56AoDkrOh6qfVPDXZ7Pt"
    # turbo_v2_5 = best latency/quality for voice agents. Alternatives: eleven_flash_v2_5, eleven_multilingual_v2.
    elevenlabs_model: str = "eleven_turbo_v2_5"

    # Delivery tuning — defaults tuned for a soft, calm, human call-center feel.
    # speed < 1.0 slows speech; stability mid keeps it steady but not robotic;
    # style 0 = natural (no performed exaggeration). All overridable via .env.
    elevenlabs_speed: float = 0.9  # 0.7 (slowest) .. 1.2 (fastest); 1.0 = default
    elevenlabs_stability: float = 0.5  # higher = calmer/steadier; too high = monotone
    elevenlabs_similarity: float = 0.8  # how closely to match the source voice
    elevenlabs_style: float = 0.0  # 0 = natural; higher exaggerates style + adds latency
    elevenlabs_speaker_boost: bool = True

    host: str = "0.0.0.0"
    port: int = 8000
    cors_origins: str = "http://localhost:3000"
    log_level: str = "info"

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


settings = Settings()
