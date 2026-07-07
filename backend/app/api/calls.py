import csv
import io
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.db import get_db
from app.models import Call, Lead
from app.services import call_store

router = APIRouter(prefix="/api")

SUMMARY_SNIPPET_LEN = 160


class LeadOut(BaseModel):
    name: str | None
    company: str | None
    role_title: str | None
    phone: str | None
    email: str | None
    interest_level: str
    objections: list[str]
    follow_up_requested: bool
    follow_up_details: str | None
    do_not_call: bool
    notes: str | None
    extra: dict

    model_config = {"from_attributes": True}


class TurnOut(BaseModel):
    idx: int
    role: str
    text: str
    ts: datetime

    model_config = {"from_attributes": True}


class CallListItem(BaseModel):
    id: str
    started_at: datetime
    duration_seconds: int
    ended_reason: str
    extraction_status: str
    summary_snippet: str | None
    lead_name: str | None
    lead_company: str | None
    interest_level: str | None


class CallList(BaseModel):
    items: list[CallListItem]
    total: int


class CallDetail(BaseModel):
    id: str
    started_at: datetime
    ended_at: datetime
    duration_seconds: int
    ended_reason: str
    extraction_status: str
    summary: str | None
    turns: list[TurnOut]
    lead: LeadOut | None


def _list_item(call: Call) -> CallListItem:
    snippet = None
    if call.summary:
        snippet = call.summary[:SUMMARY_SNIPPET_LEN]
        if len(call.summary) > SUMMARY_SNIPPET_LEN:
            snippet += "…"
    return CallListItem(
        id=call.id,
        started_at=call.started_at,
        duration_seconds=call.duration_seconds,
        ended_reason=call.ended_reason,
        extraction_status=call.extraction_status,
        summary_snippet=snippet,
        lead_name=call.lead.name if call.lead else None,
        lead_company=call.lead.company if call.lead else None,
        interest_level=call.lead.interest_level if call.lead else None,
    )


def _detail(call: Call) -> CallDetail:
    return CallDetail(
        id=call.id,
        started_at=call.started_at,
        ended_at=call.ended_at,
        duration_seconds=call.duration_seconds,
        ended_reason=call.ended_reason,
        extraction_status=call.extraction_status,
        summary=call.summary,
        turns=[TurnOut.model_validate(t) for t in call.turns],
        lead=LeadOut.model_validate(call.lead) if call.lead else None,
    )


async def _get_call(db: AsyncSession, call_id: str) -> Call:
    call = await db.scalar(
        select(Call)
        .where(Call.id == call_id)
        .options(selectinload(Call.turns), selectinload(Call.lead))
    )
    if call is None:
        raise HTTPException(status_code=404, detail="call not found")
    return call


@router.get("/calls", response_model=CallList)
async def list_calls(
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
) -> CallList:
    total = await db.scalar(select(func.count(Call.id))) or 0
    calls = (
        await db.scalars(
            select(Call)
            .options(selectinload(Call.lead))
            .order_by(Call.started_at.desc())
            .limit(limit)
            .offset(offset)
        )
    ).all()
    return CallList(items=[_list_item(c) for c in calls], total=total)


@router.get("/calls/{call_id}", response_model=CallDetail)
async def get_call(call_id: str, db: AsyncSession = Depends(get_db)) -> CallDetail:
    return _detail(await _get_call(db, call_id))


@router.post("/calls/{call_id}/re-extract", response_model=CallDetail)
async def re_extract(call_id: str, db: AsyncSession = Depends(get_db)) -> CallDetail:
    call = await _get_call(db, call_id)
    call.extraction_status = "pending"
    await db.commit()

    # Run inline so the response carries the final status + lead.
    await call_store.run_extraction(call_id)

    db.expire_all()
    return _detail(await _get_call(db, call_id))


def _csv_safe(value: object) -> str:
    """Neutralize spreadsheet formula injection in exported cells."""
    s = "" if value is None else str(value)
    if s and s[0] in "=+-@":
        return "'" + s
    return s


CSV_COLUMNS = [
    "call_id",
    "started_at",
    "duration_seconds",
    "name",
    "company",
    "role_title",
    "phone",
    "email",
    "interest_level",
    "objections",
    "follow_up_requested",
    "follow_up_details",
    "do_not_call",
    "notes",
    "summary",
]


@router.get("/export/leads.csv")
async def export_leads_csv(db: AsyncSession = Depends(get_db)) -> StreamingResponse:
    calls = (
        await db.scalars(
            select(Call).options(selectinload(Call.lead)).order_by(Call.started_at.desc())
        )
    ).all()

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(CSV_COLUMNS)
    for call in calls:
        lead = call.lead or Lead(call_id=call.id)
        writer.writerow(
            [
                _csv_safe(v)
                for v in [
                    call.id,
                    call.started_at.isoformat(),
                    call.duration_seconds,
                    lead.name,
                    lead.company,
                    lead.role_title,
                    lead.phone,
                    lead.email,
                    lead.interest_level,
                    "; ".join(lead.objections or []),
                    lead.follow_up_requested,
                    lead.follow_up_details,
                    lead.do_not_call,
                    lead.notes,
                    call.summary,
                ]
            ]
        )

    buf.seek(0)
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=leads.csv"},
    )
