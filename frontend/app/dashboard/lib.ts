export const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export type LeadOut = {
  name: string | null;
  company: string | null;
  role_title: string | null;
  phone: string | null;
  email: string | null;
  interest_level: string;
  objections: string[];
  follow_up_requested: boolean;
  follow_up_details: string | null;
  do_not_call: boolean;
  notes: string | null;
  extra: Record<string, string>;
};

export type TurnOut = {
  idx: number;
  role: "user" | "assistant";
  text: string;
  ts: string;
};

export type CallListItem = {
  id: string;
  started_at: string;
  duration_seconds: number;
  ended_reason: string;
  extraction_status: string;
  summary_snippet: string | null;
  lead_name: string | null;
  lead_company: string | null;
  interest_level: string | null;
};

export type CallList = { items: CallListItem[]; total: number };

export type CallDetail = {
  id: string;
  started_at: string;
  ended_at: string;
  duration_seconds: number;
  ended_reason: string;
  extraction_status: string;
  summary: string | null;
  turns: TurnOut[];
  lead: LeadOut | null;
};

export function fmtDuration(total: number): string {
  const m = Math.floor(total / 60)
    .toString()
    .padStart(2, "0");
  const s = (total % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

export function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function interestClass(level: string | null): string {
  switch (level) {
    case "high":
      return "pill pill-hot";
    case "medium":
    case "low":
      return "pill pill-warm";
    case "not_interested":
      return "pill pill-danger";
    default:
      return "pill pill-dim";
  }
}

export function interestLabel(level: string | null): string {
  if (!level) return "—";
  return level.replace("_", " ");
}
