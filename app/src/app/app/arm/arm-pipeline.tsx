import type { ArmStepId, ArmStepState, ArmStepStatus } from "@/application/registration-service";
import type { ArmAuthority } from "@/domain/arm-authority";

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

/**
 * Who signs each step, shown inline.
 *
 * The steps are owner calls on two different contracts, so a single "owner only" banner cannot
 * describe the situation: an operator may be able to sign steps 1–2 and not 3, or the reverse.
 * Naming the required contract next to each step is what makes a partial run understandable
 * instead of looking like a broken button.
 */
function authorityLabel(authority: ArmAuthority | undefined): string | null {
  if (authority === undefined || authority.kind === "permissionless") return null;
  if (authority.kind === "allowed") return "signable by this wallet";
  return authority.owner === null
    ? `needs ${authority.contract === "rsc" ? "SapuRSC" : "SapuForwarder"} owner (unread)`
    : `needs ${authority.contract === "rsc" ? "SapuRSC" : "SapuForwarder"} owner`;
}

export function ArmPipeline({
  steps,
  outcomeLabel,
  armed,
  authority,
}: {
  steps: readonly ArmStepState[];
  outcomeLabel: string;
  armed: boolean;
  authority: Readonly<Record<ArmStepId, ArmAuthority>>;
}) {
  return (
    <section className="panel p-5">
      <div className="flex items-center justify-between">
        <p className="label-caps">Pipeline</p>
        <span className="font-mono text-[10px] text-slate-600">{outcomeLabel}</span>
      </div>

      <ol className="mt-4 space-y-2">
        {steps.map((step) => {
          const label = authorityLabel(authority[step.id]);
          const blocked = authority[step.id]?.kind === "wrong-owner";
          return (
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
                {label !== null && (
                  <p
                    className={`mt-1 font-mono text-[10px] ${blocked ? "text-amber-500" : "text-slate-600"}`}
                  >
                    {label}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {armed && (
        <p className="mt-4 rounded border border-lime-dim/60 bg-lime/5 px-3 py-2 font-mono text-[11px] text-lime">
          Both sides agree. The route is armed and the allowance is non-zero.
        </p>
      )}
    </section>
  );
}
