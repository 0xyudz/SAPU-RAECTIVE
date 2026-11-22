import type { ArmStepId, ArmStepState, ArmStepStatus } from "@/application/registration-service";

const STEP_LABEL: Record<ArmStepId, string> = {
  "set-forwarder": "1 · point SapuRSC at the forwarder",
  "register-route": "2 · register the route on SapuRSC",
  "arm-rule": "3 · arm the destination rule (and EIP-2612 permit)",
  verify: "4 · verify both sides",
};

const STEP_DOT: Record<ArmStepStatus, string> = {
  done: "bg-lime",
  skipped: "bg-sky-400",
  failed: "bg-red-400",
  running: "bg-amber-400 animate-pulse",
  todo: "bg-steel-bright",
};

export function ArmPipeline({
  steps,
  outcomeLabel,
  armed,
}: {
  steps: readonly ArmStepState[];
  outcomeLabel: string;
  armed: boolean;
}) {
  return (
    <section className="panel p-5">
      <div className="flex items-center justify-between">
        <p className="label-caps">Pipeline</p>
        <span className="font-mono text-[10px] text-slate-600">{outcomeLabel}</span>
      </div>

      <ol className="mt-4 space-y-2">
        {steps.map((step) => (
          <li
            key={step.id}
            className="flex items-start gap-3 rounded border border-steel/60 bg-void/30 px-3 py-2.5"
          >
            <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${STEP_DOT[step.status]}`} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-mono text-[11px] text-slate-200">{STEP_LABEL[step.id]}</span>
                <span className="font-mono text-[10px] uppercase tracking-wider text-slate-600">
                  {step.status}
                </span>
              </div>
              {step.detail && <p className="mt-1 text-[11px] leading-relaxed text-slate-500">{step.detail}</p>}
            </div>
          </li>
        ))}
      </ol>

      {armed && (
        <p className="mt-4 rounded border border-lime-dim/60 bg-lime/5 px-3 py-2 font-mono text-[11px] text-lime">
          Both sides agree. The route is armed and the allowance is non-zero.
        </p>
      )}
    </section>
  );
}
