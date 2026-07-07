"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";

import { StatusPill } from "../components";
import {
  API_URL,
  CallDetail,
  fmtDate,
  fmtDuration,
  interestClass,
  interestLabel,
} from "../lib";

export default function CallDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [call, setCall] = useState<CallDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reExtracting, setReExtracting] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${API_URL}/api/calls/${id}`);
      if (!r.ok) throw new Error(r.status === 404 ? "Call not found" : `API returned ${r.status}`);
      setCall(await r.json());
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  // While extraction is pending, poll until it settles.
  useEffect(() => {
    if (call?.extraction_status !== "pending") return;
    const t = setInterval(load, 2500);
    return () => clearInterval(t);
  }, [call?.extraction_status, load]);

  const reExtract = async () => {
    setReExtracting(true);
    try {
      const r = await fetch(`${API_URL}/api/calls/${id}/re-extract`, {
        method: "POST",
      });
      if (r.ok) setCall(await r.json());
      else setError(`Re-extract failed: API returned ${r.status}`);
    } catch (e) {
      setError(`Re-extract failed: ${e}`);
    } finally {
      setReExtracting(false);
    }
  };

  return (
    <main className="flex flex-1 flex-col items-center px-5 py-10 sm:py-14">
      <div className="flex w-full max-w-3xl flex-col gap-8">
        {/* masthead */}
        <header className="flex items-center justify-between">
          <div className="flex items-baseline gap-2.5">
            <span className="font-display text-xl font-semibold tracking-tight text-text">
              Nexbizio
            </span>
            <span className="mono text-[0.62rem] uppercase tracking-[0.22em] text-dim">
              Call Record
            </span>
          </div>
          <Link
            href="/dashboard"
            className="mono text-[0.7rem] uppercase tracking-[0.14em] text-dim transition-colors hover:text-text"
          >
            ← All calls
          </Link>
        </header>

        {error && (
          <div
            role="alert"
            className="rounded-lg border border-[rgba(255,107,107,0.4)] bg-[rgba(255,107,107,0.08)] px-4 py-3 text-sm text-[#ffb4b4]"
          >
            {error}
          </div>
        )}

        {!call && !error && (
          <p className="p-8 text-center text-sm text-dim">Loading…</p>
        )}

        {call && (
          <>
            {/* call meta */}
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
              <h1 className="font-display text-[1.4rem] font-medium tracking-tight text-text">
                {call.lead?.name ?? "Unknown caller"}
                {call.lead?.company && (
                  <span className="text-dim"> · {call.lead.company}</span>
                )}
              </h1>
              <span className={interestClass(call.lead?.interest_level ?? null)}>
                {interestLabel(call.lead?.interest_level ?? null)}
              </span>
              <StatusPill status={call.extraction_status} />
            </div>
            <p className="mono -mt-6 text-[0.72rem] text-dim">
              {fmtDate(call.started_at)} · {fmtDuration(call.duration_seconds)} ·{" "}
              {call.ended_reason.replace("_", " ")}
            </p>

            {call.extraction_status === "failed" && (
              <div className="flex items-center justify-between rounded-lg border border-[rgba(255,107,107,0.4)] bg-[rgba(255,107,107,0.08)] px-4 py-3">
                <span className="text-sm text-[#ffb4b4]">
                  Lead extraction failed for this call.
                </span>
                <button
                  onClick={reExtract}
                  disabled={reExtracting}
                  className="btn-call btn-end !px-4 !py-1.5 !text-xs"
                >
                  {reExtracting ? "Retrying…" : "Retry extraction"}
                </button>
              </div>
            )}

            {/* summary */}
            <section className="flex flex-col gap-3">
              <h2 className="mono text-[0.66rem] uppercase tracking-[0.16em] text-dim">
                Summary
              </h2>
              <div className="glass rounded-2xl p-5">
                <p className="text-sm leading-relaxed text-text/90">
                  {call.summary ??
                    (call.extraction_status === "pending"
                      ? "Extracting…"
                      : "No summary available.")}
                </p>
              </div>
            </section>

            {/* lead details */}
            <section className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <h2 className="mono text-[0.66rem] uppercase tracking-[0.16em] text-dim">
                  Lead details
                </h2>
                {call.extraction_status === "extracted" && (
                  <button
                    onClick={reExtract}
                    disabled={reExtracting}
                    className="mono text-[0.66rem] uppercase tracking-[0.14em] text-dim transition-colors hover:text-text disabled:opacity-50"
                  >
                    {reExtracting ? "Re-extracting…" : "Re-extract"}
                  </button>
                )}
              </div>
              <div className="glass grid grid-cols-1 gap-x-8 gap-y-4 rounded-2xl p-5 sm:grid-cols-2">
                {call.lead ? (
                  <>
                    <Field label="Name" value={call.lead.name} />
                    <Field label="Company" value={call.lead.company} />
                    <Field label="Role" value={call.lead.role_title} />
                    <Field label="Phone" value={call.lead.phone} />
                    <Field label="Email" value={call.lead.email} />
                    <Field
                      label="Follow-up"
                      value={
                        call.lead.follow_up_requested
                          ? (call.lead.follow_up_details ?? "Requested")
                          : "Not requested"
                      }
                    />
                    {call.lead.do_not_call && (
                      <Field label="Do not call" value="Yes — remove from list" danger />
                    )}
                    {call.lead.objections.length > 0 && (
                      <Field
                        label="Objections"
                        value={call.lead.objections.join(" · ")}
                        wide
                      />
                    )}
                    {call.lead.notes && (
                      <Field label="Notes" value={call.lead.notes} wide />
                    )}
                    {Object.entries(call.lead.extra).map(([k, v]) => (
                      <Field key={k} label={k.replace(/_/g, " ")} value={v} />
                    ))}
                  </>
                ) : (
                  <p className="text-sm text-dim sm:col-span-2">
                    {call.extraction_status === "pending"
                      ? "Extracting lead details…"
                      : "No lead details extracted."}
                  </p>
                )}
              </div>
            </section>

            {/* transcript */}
            <section className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <h2 className="mono text-[0.66rem] uppercase tracking-[0.16em] text-dim">
                  Transcript
                </h2>
                <span className="mono text-[0.66rem] text-dim">
                  {call.turns.length} {call.turns.length === 1 ? "turn" : "turns"}
                </span>
              </div>
              <div className="glass scroll-area flex max-h-[50vh] flex-col gap-4 overflow-y-auto rounded-2xl p-5">
                {call.turns.map((t) => (
                  <div key={t.idx} className="flex gap-3">
                    <span
                      className={`turn-tag shrink-0 ${
                        t.role === "assistant" ? "agent" : "caller"
                      }`}
                    >
                      {t.role === "assistant" ? "Agent" : "Caller"}
                    </span>
                    <p className="text-sm leading-relaxed text-text/90">{t.text}</p>
                  </div>
                ))}
              </div>
            </section>
          </>
        )}
      </div>
    </main>
  );
}

function Field({
  label,
  value,
  wide,
  danger,
}: {
  label: string;
  value: string | null;
  wide?: boolean;
  danger?: boolean;
}) {
  return (
    <div className={`flex flex-col gap-1 ${wide ? "sm:col-span-2" : ""}`}>
      <span className="mono text-[0.62rem] uppercase tracking-[0.16em] text-dim">
        {label}
      </span>
      <span
        className={`text-sm ${
          danger
            ? "text-[#ffb4b4]"
            : value
              ? "text-text/90"
              : "text-[var(--text-faint)]"
        }`}
      >
        {value ?? "—"}
      </span>
    </div>
  );
}
