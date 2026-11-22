import Link from "next/link";
import type { RouteIndexRow } from "@/infrastructure/route-indexer";
import { StatusPill } from "@/components/primitives";
import { RepairAction, type RepairKind } from "@/components/repair-action";
import { shortAddress } from "@/components/short-value";

export interface RepairAuthority {
  readonly isOwner: boolean;
  readonly owner: string | null;
  readonly ownerRole: string;
}

export function RegistryRow({
  row,
  busy,
  walletConnected,
  authority,
  onRevoke,
  onDisarm,
}: {
  row: RouteIndexRow;
  busy: RepairKind | null;
  walletConnected: boolean;
  authority: RepairAuthority;
  onRevoke: () => void;
  onDisarm: () => void;
}) {
  const { diagnosis } = row;
  const danger = diagnosis.tone === "danger";

  return (
    <tr className={`border-b border-steel/40 align-top ${danger ? "bg-red-950/10" : "hover:bg-steel/20"}`}>
      <td className="px-4 py-3 font-mono text-[11px]">
        <span className="block text-slate-200" title={row.burner}>
          {shortAddress(row.burner)}
        </span>
        <span className="mt-0.5 block text-slate-600" title={row.token}>
          {shortAddress(row.token)}
        </span>
        <span className="mt-0.5 block text-[10px] text-slate-600">tokensOf: {row.rscTokens.length}</span>
      </td>
      <td className="px-4 py-3 font-mono text-[11px]">
        <span className={row.rscActive ? "text-lime" : "text-slate-600"}>
          {row.rscActive ? "active" : "inactive"}
        </span>
        <span className="mt-0.5 block text-slate-600" title={row.rscColdWallet ?? undefined}>
          {shortAddress(row.rscColdWallet)}
        </span>
      </td>
      <td className="px-4 py-3 font-mono text-[11px]">
        <span className={row.forwarderArmed ? "text-lime" : "text-slate-600"}>
          {row.forwarderArmed ? "armed" : "unarmed"}
        </span>
        <span className="mt-0.5 block text-slate-600" title={row.forwarderColdWallet ?? undefined}>
          {shortAddress(row.forwarderColdWallet)}
        </span>
      </td>
      <td className="px-4 py-3 font-mono text-[10.5px] text-slate-500">
        {diagnosis.status === "drifted" ? (
          <span className="text-red-300">mismatch</span>
        ) : (
          shortAddress(row.rscColdWallet ?? row.forwarderColdWallet)
        )}
      </td>
      <td className="px-4 py-3 font-mono text-[10.5px] text-slate-600">{row.lastEventBlock ?? "—"}</td>
      <td className="px-4 py-3">
        <StatusPill label={diagnosis.status} tone={diagnosis.tone} />
        <p className="mt-1.5 max-w-xs text-[11px] leading-relaxed text-slate-500">{diagnosis.summary}</p>
        {row.readError && (
          <p className="mt-1 max-w-xs font-mono text-[10px] text-amber-500">{row.readError}</p>
        )}
      </td>
      <td className="px-4 py-3">
        <RepairAction
          repair={diagnosis.repair}
          tone={diagnosis.tone}
          busy={busy}
          walletConnected={walletConnected}
          isOwner={authority.isOwner}
          owner={authority.owner}
          ownerRole={authority.ownerRole}
          onRevoke={onRevoke}
          onDisarm={onDisarm}
        />
      </td>
    </tr>
  );
}

export function EmptyInventory() {
  return (
    <div className="px-4 py-8">
      <p className="text-[12.5px] text-slate-500">No routes registered in the scanned window.</p>
      <Link href="/app/arm" className="mt-2 inline-block font-mono text-[11px] text-lime-glow hover:underline">
        arm the first route →
      </Link>
    </div>
  );
}
