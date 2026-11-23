import { STRAND_CAUSE_TONE, type StrandCause, type StrandCauseId } from "@/domain/strand-cause";
import { StatusPill } from "./primitives";

/**
 * Short labels for the "why stranded" column.
 *
 * Deliberately shorter than `StrandCause.headline`: a table cell has room for a tag,
 * not a sentence. The full headline and detail are still reachable as the tooltip, so
 * nothing is lost — it is only compressed.
 */
const CAUSE_LABEL: Record<StrandCauseId, string> = {
  resolved: "—",
  "allowance-missing": "no allowance",
  "allowance-partial": "partial allowance",
  "rule-disarmed": "rule disarmed",
  "route-inactive": "route revoked",
  "cold-wallet-mismatch": "wallet mismatch",
  "preconditions-unread": "unread",
  "not-reproducible": "historical",
};

/**
 * The cause of a residue, for one ledger row.
 *
 * `not-reproducible` is the interesting case and the reason this column exists: every
 * precondition currently passes, so the app cannot claim a live cause. It says so
 * plainly ("historical") instead of inventing one, and the tooltip points at the rescue
 * path, which is the only thing that helps there.
 */
export function StrandCauseCell({ cause }: { cause: StrandCause }) {
  const tone = STRAND_CAUSE_TONE[cause.id];

  if (cause.id === "resolved") {
    return (
      <span className="font-mono text-[10px] text-slate-600" title={cause.detail}>
        —
      </span>
    );
  }

  return (
    <span className="inline-flex flex-col gap-1" title={`${cause.headline} ${cause.detail}`}>
      <StatusPill label={CAUSE_LABEL[cause.id]} tone={tone} />
    </span>
  );
}

/**
 * Every cause a row can carry, in the order a sweep would hit them.
 *
 * Declared here rather than passed in, so the legend and the column can never drift
 * apart: both read from the same list.
 */
const LEGEND_ORDER: readonly StrandCauseId[] = [
  "allowance-missing",
  "rule-disarmed",
  "route-inactive",
  "cold-wallet-mismatch",
  "allowance-partial",
  "preconditions-unread",
  "not-reproducible",
];

/** Explains what each cause means, so the column is readable without guessing. */
export function StrandCauseLegend() {
  return (
    <div className="mt-3 grid gap-3 md:grid-cols-2">
      {LEGEND_ORDER.map((id) => (
        <div key={id}>
          <StatusPill label={CAUSE_LABEL[id]} tone={STRAND_CAUSE_TONE[id]} />
          <p className="mt-2 text-[11.5px] leading-relaxed text-slate-500">{CAUSE_NOTE[id]}</p>
        </div>
      ))}
    </div>
  );
}

const CAUSE_NOTE: Record<StrandCauseId, string> = {
  resolved: "The burner is empty, so there is no residue to explain.",
  "allowance-missing":
    "The burner's allowance is zero, so every sweep for it reverts inside safeTransferFrom before any token moves.",
  "allowance-partial":
    "The allowance is smaller than the balance. A sweep moves what it permits and leaves the remainder behind.",
  "rule-disarmed":
    "The forwarder rule is disarmed, so a callback for this pair reverts with RouteNotArmed.",
  "route-inactive":
    "The reactive route is revoked, so the RSC returns early and no callback is ever requested.",
  "cold-wallet-mismatch":
    "The two sides name different destination wallets, so the forwarder rejects the callback with DestinationMismatch.",
  "preconditions-unread":
    "At least one precondition could not be read. The app will not name a cause it cannot check.",
  "not-reproducible":
    "Every precondition a sweep needs passes right now, so the residue is historical: an earlier callback failed and nothing retried it.",
};
