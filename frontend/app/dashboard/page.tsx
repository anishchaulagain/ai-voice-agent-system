"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { StatusPill } from "./components";
import {
  API_URL,
  CallList,
  CallListItem,
  fmtDate,
  fmtDuration,
  interestClass,
  interestLabel,
} from "./lib";

export default function DashboardPage() {
  const [data, setData] = useState<CallList | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_URL}/api/calls?limit=100`)
      .then((r) => {
        if (!r.ok) throw new Error(`API returned ${r.status}`);
        return r.json();
      })
      .then((d: CallList) => {
        if (!cancelled) setData(d);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="flex flex-1 flex-col items-center px-5 py-10 sm:py-14">
      <div className="flex w-full max-w-4xl flex-col gap-8">
        {/* masthead */}
        <header className="flex items-center justify-between">
          <div className="flex items-baseline gap-2.5">
            <span className="font-display text-xl font-semibold tracking-tight text-text">
              Nexbizio
            </span>
            <span className="mono text-[0.62rem] uppercase tracking-[0.22em] text-dim">
              Call Records
            </span>
          </div>
          <nav className="flex items-center gap-4">
            <a
              href={`${API_URL}/api/export/leads.csv`}
              className="mono text-[0.7rem] uppercase tracking-[0.14em] text-dim transition-colors hover:text-text"
            >
              Export CSV
            </a>
            <Link
              href="/"
              className="mono text-[0.7rem] uppercase tracking-[0.14em] text-dim transition-colors hover:text-text"
            >
              ← Call screen
            </Link>
          </nav>
        </header>

        <div className="flex flex-col gap-1.5">
          <h1 className="font-display text-[1.7rem] font-medium leading-tight tracking-tight text-text">
            Conversations
          </h1>
          <p className="text-sm leading-relaxed text-dim">
            Every call the agent has taken — lead details captured, summarized,
            and ready to reuse.
            {data && (
              <span className="mono text-[0.7rem] text-dim"> · {data.total} total</span>
            )}
          </p>
        </div>

        {error && (
          <div
            role="alert"
            className="rounded-lg border border-[rgba(255,107,107,0.4)] bg-[rgba(255,107,107,0.08)] px-4 py-3 text-sm text-[#ffb4b4]"
          >
            Couldn&apos;t reach the backend at {API_URL} — {error}
          </div>
        )}

        <div className="glass scroll-area overflow-x-auto rounded-2xl">
          {!data && !error ? (
            <p className="p-8 text-center text-sm text-dim">Loading…</p>
          ) : data && data.items.length === 0 ? (
            <div className="flex flex-col items-center gap-1.5 p-10 text-center">
              <p className="font-display text-sm text-dim">No calls recorded yet</p>
              <p className="max-w-xs text-xs leading-relaxed text-[var(--text-faint)]">
                Take a call from the call screen. Once the caller speaks, the
                conversation lands here with its extracted lead details.
              </p>
            </div>
          ) : data ? (
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-line">
                  {["Date", "Name", "Company", "Interest", "Duration", "Status", "Summary"].map(
                    (h) => (
                      <th
                        key={h}
                        className="mono px-4 py-3 text-[0.62rem] font-normal uppercase tracking-[0.16em] text-dim"
                      >
                        {h}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {data.items.map((c) => (
                  <Row key={c.id} call={c} />
                ))}
              </tbody>
            </table>
          ) : null}
        </div>
      </div>
    </main>
  );
}

function Row({ call }: { call: CallListItem }) {
  return (
    <tr className="row-link border-b border-line/50 last:border-b-0">
      <td className="mono whitespace-nowrap px-4 py-3 text-[0.75rem] text-dim">
        <Link href={`/dashboard/${call.id}`} className="block">
          {fmtDate(call.started_at)}
        </Link>
      </td>
      <td className="px-4 py-3 text-text/90">
        <Link href={`/dashboard/${call.id}`} className="block">
          {call.lead_name ?? <span className="text-[var(--text-faint)]">—</span>}
        </Link>
      </td>
      <td className="px-4 py-3 text-text/90">
        <Link href={`/dashboard/${call.id}`} className="block">
          {call.lead_company ?? <span className="text-[var(--text-faint)]">—</span>}
        </Link>
      </td>
      <td className="px-4 py-3">
        <Link href={`/dashboard/${call.id}`} className="block">
          <span className={interestClass(call.interest_level)}>
            {interestLabel(call.interest_level)}
          </span>
        </Link>
      </td>
      <td className="mono px-4 py-3 text-[0.75rem] tabular-nums text-dim">
        <Link href={`/dashboard/${call.id}`} className="block">
          {fmtDuration(call.duration_seconds)}
        </Link>
      </td>
      <td className="px-4 py-3">
        <Link href={`/dashboard/${call.id}`} className="block">
          <StatusPill status={call.extraction_status} />
        </Link>
      </td>
      <td className="max-w-[18rem] px-4 py-3 text-xs leading-relaxed text-dim">
        <Link href={`/dashboard/${call.id}`} className="block truncate">
          {call.summary_snippet ?? ""}
        </Link>
      </td>
    </tr>
  );
}
