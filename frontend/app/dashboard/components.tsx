"use client";

export function StatusPill({ status }: { status: string }) {
  if (status === "extracted") return <span className="pill pill-ok">extracted</span>;
  if (status === "failed") return <span className="pill pill-danger">failed</span>;
  return <span className="pill pill-dim pill-pulse">pending</span>;
}
