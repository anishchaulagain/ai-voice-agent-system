import json
import logging
from typing import Literal

from pydantic import BaseModel, Field, ValidationError

from app.config import settings
from app.services import llm

log = logging.getLogger(__name__)


class ExtractionError(RuntimeError):
    pass


class LeadData(BaseModel):
    name: str | None = None
    company: str | None = None
    role_title: str | None = None
    phone: str | None = None
    email: str | None = None
    interest_level: Literal["high", "medium", "low", "not_interested", "unknown"] = (
        "unknown"
    )
    objections: list[str] = Field(default_factory=list)
    follow_up_requested: bool = False
    follow_up_details: str | None = None
    do_not_call: bool = False
    notes: str | None = None
    extra: dict[str, str] = Field(default_factory=dict)


class ExtractionResult(BaseModel):
    summary: str
    lead: LeadData


_SYSTEM_PROMPT = f"""You extract structured lead data from a promotional sales-call transcript.
The Agent pitched a product; the Caller is a potential lead.

Respond with a single JSON object matching exactly this JSON schema:

{json.dumps(ExtractionResult.model_json_schema(), indent=2)}

Rules:
- "summary": 2-4 sentences covering who the caller is, how they responded, and any next step.
- Only record facts the Caller actually stated in the transcript. Never invent or guess
  names, companies, phone numbers, or emails. Use null for anything not mentioned.
- "interest_level": high = wants to proceed/asked for follow-up; medium = curious but
  uncommitted; low = polite but dismissive; not_interested = clearly declined;
  unknown = call too short to tell.
- "objections": concerns or reasons for hesitation, in the caller's terms.
- "do_not_call": true only if the caller asked not to be contacted again.
- "extra": any other reusable details (budget, timeline, current tools, referrals...).
- Output raw JSON only — no markdown fences, no commentary."""


def _format_transcript(turns: list[tuple[str, str]]) -> str:
    label = {"assistant": "Agent", "user": "Caller"}
    return "\n".join(f"{label.get(role, role)}: {text}" for role, text in turns)


async def extract(turns: list[tuple[str, str]]) -> ExtractionResult:
    """Run one extraction pass over the transcript; retries once on invalid JSON."""
    client, default_model = llm.get_client()
    model = settings.extraction_model or default_model

    messages = [
        {"role": "system", "content": _SYSTEM_PROMPT},
        {"role": "user", "content": f"Transcript:\n\n{_format_transcript(turns)}"},
    ]

    last_error: Exception | None = None
    for attempt in range(2):
        resp = await client.chat.completions.create(
            model=model,
            messages=messages,
            response_format={"type": "json_object"},
            temperature=0,
            max_tokens=settings.extraction_max_tokens,
            stream=False,
        )
        raw = resp.choices[0].message.content or ""
        try:
            return ExtractionResult.model_validate_json(raw)
        except (ValidationError, ValueError) as e:
            last_error = e
            log.warning("extraction attempt %d returned invalid JSON: %s", attempt + 1, e)
            messages.append({"role": "assistant", "content": raw})
            messages.append(
                {
                    "role": "user",
                    "content": (
                        f"That response was invalid: {e}\n"
                        "Return only a valid JSON object matching the schema."
                    ),
                }
            )

    raise ExtractionError(f"extraction produced invalid JSON twice: {last_error}")
