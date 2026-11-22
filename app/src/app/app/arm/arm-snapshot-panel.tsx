import type { ArmingSnapshot, PolicyDivergence } from "@/application/registration-service";
import { DefinitionRow } from "@/components/primitives";

export function ArmSnapshotPanel({ snapshot }: { snapshot: ArmingSnapshot }) {
  return (
    <div className="panel p-5">
      <p className="label-caps">On-chain state</p>
      <dl className="mt-3 grid gap-1 font-mono text-[10.5px]">
        <DefinitionRow label="RSC.forwarder" value={snapshot.forwarder ?? "unset"} />
        <DefinitionRow label="route.active" value={String(snapshot.routeActive)} />
        <DefinitionRow label="route.coldWallet" value={snapshot.routeColdWallet ?? "unset"} />
        <DefinitionRow label="rule.armed" value={String(snapshot.ruleArmed)} />
        <DefinitionRow label="rule.coldWallet" value={snapshot.ruleColdWallet ?? "unset"} />
        <DefinitionRow label="allowance" value={snapshot.allowance.toString()} />
      </dl>
    </div>
  );
}

export function DivergencePanel({ divergence }: { divergence: PolicyDivergence }) {
  return (
    <section className="rounded-lg border border-red-900/70 bg-red-950/20 p-4">
      <p className="font-mono text-[11px] tracking-wider text-red-300">
        POLICY DIVERGENCE · {divergence.side.toUpperCase()}
      </p>
      <dl className="mt-2 grid gap-1 font-mono text-[11px] sm:grid-cols-[8rem_1fr]">
        <dt className="text-slate-500">expected</dt>
        <dd className="break-all text-lime-glow">{divergence.expected}</dd>
        <dt className="text-slate-500">actual</dt>
        <dd className="break-all text-red-300">{divergence.actual ?? "unset"}</dd>
        <dt className="text-slate-500">side</dt>
        <dd className="text-slate-300">{divergence.side}</dd>
      </dl>
      <p className="mt-2 text-[12px] leading-relaxed text-slate-400">{divergence.detail}</p>
    </section>
  );
}
