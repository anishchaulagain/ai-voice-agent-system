from datetime import datetime

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class Call(Base):
    __tablename__ = "calls"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    ended_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    duration_seconds: Mapped[int] = mapped_column(Integer)
    # "agent_ended" | "user_ended" | "disconnected"
    ended_reason: Mapped[str] = mapped_column(String)
    # "pending" | "extracted" | "failed"
    extraction_status: Mapped[str] = mapped_column(String, default="pending")
    summary: Mapped[str | None] = mapped_column(Text, default=None)

    turns: Mapped[list["TranscriptTurn"]] = relationship(
        back_populates="call",
        order_by="TranscriptTurn.idx",
        cascade="all, delete-orphan",
    )
    lead: Mapped["Lead | None"] = relationship(
        back_populates="call",
        uselist=False,
        cascade="all, delete-orphan",
    )


class TranscriptTurn(Base):
    __tablename__ = "transcript_turns"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    call_id: Mapped[str] = mapped_column(
        ForeignKey("calls.id", ondelete="CASCADE"), index=True
    )
    idx: Mapped[int] = mapped_column(Integer)
    # "user" | "assistant"
    role: Mapped[str] = mapped_column(String)
    text: Mapped[str] = mapped_column(Text)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True))

    call: Mapped[Call] = relationship(back_populates="turns")


class Lead(Base):
    __tablename__ = "leads"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    call_id: Mapped[str] = mapped_column(
        ForeignKey("calls.id", ondelete="CASCADE"), unique=True
    )
    name: Mapped[str | None] = mapped_column(String, default=None)
    company: Mapped[str | None] = mapped_column(String, default=None)
    role_title: Mapped[str | None] = mapped_column(String, default=None)
    phone: Mapped[str | None] = mapped_column(String, default=None)
    email: Mapped[str | None] = mapped_column(String, default=None)
    # "high" | "medium" | "low" | "not_interested" | "unknown"
    interest_level: Mapped[str] = mapped_column(String, default="unknown")
    objections: Mapped[list] = mapped_column(JSON, default=list)
    follow_up_requested: Mapped[bool] = mapped_column(Boolean, default=False)
    follow_up_details: Mapped[str | None] = mapped_column(Text, default=None)
    do_not_call: Mapped[bool] = mapped_column(Boolean, default=False)
    notes: Mapped[str | None] = mapped_column(Text, default=None)
    extra: Mapped[dict] = mapped_column(JSON, default=dict)

    call: Mapped[Call] = relationship(back_populates="lead")
