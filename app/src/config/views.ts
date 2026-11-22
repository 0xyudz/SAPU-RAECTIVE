export type ViewId = "registry" | "arm" | "ledger" | "budget" | "refusals";

export type StatusProbe =
  | "routes"
  | "arming"
  | "sweeps"
  | "budget"
  | "refusals";

export interface ViewDefinition {
  readonly id: ViewId;
  readonly href: string;
  readonly label: string;
  readonly description: string;
  readonly role: string;
  readonly statusProbe: StatusProbe;
}

export const VIEWS: readonly ViewDefinition[] = [
  {
    id: "registry",
    href: "/app",
    label: "Route Registry",
    description:
      "Every route this deployment knows about, confirmed by reading both contracts. Disagreement is a repair target, not a pending state.",
    role: "Operator inventory · owner-only repairs",
    statusProbe: "routes",
  },
  {
    id: "arm",
    href: "/app/arm",
    label: "Arm a route",
    description:
      "The four-step pipeline: set the forwarder, register the route, arm the destination rule, then verify both sides agree. Resumable from on-chain state.",
    role: "Owner · one-time per burner",
    statusProbe: "arming",
  },
  {
    id: "ledger",
    href: "/app/ledger",
    label: "Sweep Ledger",
    description:
      "One row per deposit across all three legs. Complete, reactive-only, and orphan-sweep are shown as three different facts.",
    role: "Read-only · public chain evidence",
    statusProbe: "sweeps",
  },
  {
    id: "budget",
    href: "/app/budget",
    label: "Callback Budget",
    description:
      "How many sweeps the destination budget can actually pay for at the current gas limit, plus debt on both sides.",
    role: "Read-only · owner can raise the gas limit",
    statusProbe: "budget",
  },
  {
    id: "refusals",
    href: "/app/refusals",
    label: "Refusal Lab",
    description:
      "Four negative paths executed against the live chain via eth_call, with the raw revert bytes and the decoded error name.",
    role: "Read-only · no key required",
    statusProbe: "refusals",
  },
] as const;

