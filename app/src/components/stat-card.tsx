export function StatCard({
  label,
  value,
  detail,
  tone = "default",
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: "default" | "warn" | "danger" | "muted" | "lime";
}) {
  const toneClass =
    tone === "warn"
      ? "text-amber-500"
      : tone === "danger"
        ? "text-red-300"
        : tone === "muted"
          ? "text-slate-500"
          : tone === "lime"
            ? "text-lime-glow"
            : "text-slate-100";

  return (
    <div className="panel px-4 py-3">
      <p className="label-caps">{label}</p>
      <p className={`mt-1 font-mono text-2xl ${toneClass}`}>{value}</p>
      {detail && <p className="mt-1 text-[10.5px] text-slate-600">{detail}</p>}
    </div>
  );
}

export function InfoCard({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded border border-steel/70 p-3">
      <h3 className="font-mono text-[11.5px] text-slate-200">{title}</h3>
      <p className="mt-1.5 text-[11.5px] leading-relaxed text-slate-500">{body}</p>
    </div>
  );
}
