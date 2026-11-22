import type { Tone } from "@/domain/tone";

export const TONE_BADGE: Record<Tone, string> = {
  ok: "border-lime-dim/60 bg-lime/5 text-lime",
  warn: "border-amber-900/60 bg-amber-950/20 text-amber-500",
  danger: "border-red-900/70 bg-red-950/25 text-red-300",
  muted: "border-steel bg-steel/20 text-slate-500",
  info: "border-sky-900/70 bg-sky-950/20 text-sky-300",
};

export const TONE_TEXT: Record<Tone | "default", string> = {
  default: "text-slate-100",
  ok: "text-lime",
  warn: "text-amber-500",
  danger: "text-red-300",
  muted: "text-slate-500",
  info: "text-sky-300",
};
