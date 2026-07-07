import asyncio
import logging
from datetime import datetime, timezone

from sqlalchemy import select

from app import conversation
from app.db import SessionLocal
from app.models import Call, Lead, TranscriptTurn
from app.services import extraction

log = logging.getLogger(__name__)

# Keep strong refs to fire-and-forget extraction tasks so they aren't GC'd mid-run.
_tasks: set[asyncio.Task] = set()


async def save_call(
    session: conversation.Session, started_at: datetime, ended_reason: str
) -> str | None:
    """Persist the call + transcript with extraction_status='pending'.

    Returns the call id, or None when the caller never spoke (nothing worth
    keeping — typically a page refresh or mic failure during the opener).
    """
    if session.user_turns == 0:
        log.info("call %s had no user turns; not saving", session.id)
        return None

    ended_at = datetime.now(timezone.utc)
    call = Call(
        id=session.id,
        started_at=started_at,
        ended_at=ended_at,
        duration_seconds=int((ended_at - started_at).total_seconds()),
        ended_reason=ended_reason,
        extraction_status="pending",
    )
    call.turns = [
        TranscriptTurn(
            idx=i,
            role=m["role"],
            text=m["content"],
            ts=datetime.fromtimestamp(m.get("ts", started_at.timestamp()), tz=timezone.utc),
        )
        for i, m in enumerate(session.messages)
    ]

    async with SessionLocal() as db:
        db.add(call)
        await db.commit()

    log.info("call %s saved (%d turns, %s)", session.id, len(call.turns), ended_reason)
    return session.id


def schedule_extraction(call_id: str) -> None:
    task = asyncio.create_task(run_extraction(call_id))
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)


async def run_extraction(call_id: str) -> None:
    """Extract lead details + summary for a saved call. Never raises."""
    try:
        async with SessionLocal() as db:
            turns = (
                await db.scalars(
                    select(TranscriptTurn)
                    .where(TranscriptTurn.call_id == call_id)
                    .order_by(TranscriptTurn.idx)
                )
            ).all()
            if not turns:
                log.warning("extraction: call %s has no turns", call_id)
                return

        result = await extraction.extract([(t.role, t.text) for t in turns])

        async with SessionLocal() as db:
            call = await db.get(Call, call_id)
            if call is None:
                return
            existing = await db.scalar(select(Lead).where(Lead.call_id == call_id))
            if existing is not None:
                await db.delete(existing)
                await db.flush()
            db.add(Lead(call_id=call_id, **result.lead.model_dump()))
            call.summary = result.summary
            call.extraction_status = "extracted"
            await db.commit()
        log.info("extraction done for call %s", call_id)
    except Exception:
        log.exception("extraction failed for call %s", call_id)
        try:
            async with SessionLocal() as db:
                call = await db.get(Call, call_id)
                if call is not None:
                    call.extraction_status = "failed"
                    await db.commit()
        except Exception:
            log.exception("failed to mark call %s extraction as failed", call_id)
