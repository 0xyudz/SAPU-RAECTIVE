/**
 * What the network switch is allowed to claim.
 *
 * ## Why this is a domain module and not component state
 *
 * A testnet/mainnet switch invites a specific lie: letting the operator pick "mainnet" and
 * then rendering the testnet numbers underneath it. Nothing would look wrong — the page
 * would fill with plausible blocks and balances — and the operator would believe they were
 * reading mainnet. So the rules for what each selection means live here, as data, and are
 * pinned by tests; the component only renders the verdict.
 *
 * The verdict is deliberately binary:
 *
 * - `live` — the selection matches the deployment this build is configured against, so the
 *   pages really are reading the chain they name.
 * - `preview` — the selection does not match, so nothing on the page is that chain's data.
 *   The panel says so and lists what is missing.
 *
 * There is no third state. "Probably fine" is exactly the claim this module exists to
 * prevent.
 */

export type NetworkSelection = "mainnet" | "testnet";

export interface NetworkScope {
  /** `live` only when the selection matches the deployment this build reads. */
  readonly state: "live" | "preview";
  /** Short label for the badge next to the switch. */
  readonly label: string;
  /** One sentence describing what the pages are actually reading. */
  readonly summary: string;
  /** Concrete reasons the selected network is not readable yet. Empty when `live`. */
  readonly limitations: readonly string[];
  /** What an operator would have to do to make the selection `live`. Empty when `live`. */
  readonly prerequisites: readonly string[];
}

/**
 * Facts about the mainnet deployment as of this build.
 *
 * These are claims about the world, so they are stated as what was verified, not as what is
 * planned. Every line is checkable against the chain: the addresses below either have code
 * on mainnet or they do not.
 */
const MAINNET_LIMITATIONS: readonly string[] = [
  "No SAPU contracts are deployed on mainnet. SapuRSC and SapuForwarder exist only on Base Sepolia (84532) and Reactive Lasna (5318007), so there is nothing on Reactive mainnet (1597) or any mainnet token chain to read.",
  "Reactive mainnet is not a testnet with a different label. It is a separate chain with its own system contract state, its own REACT balance, and its own callback billing. A testnet route cannot be migrated; the route has to be armed again from scratch.",
  "Mainnet costs real value to run. SapuRSC must hold REACT to pay for reactive transactions and SapuForwarder must hold the origin chain's native token to pay callback gas. On testnet both are free faucet funds.",
  "The deployed forwarder has no rescueSweep, so a burner whose callback fails permanently cannot be recovered by the owner. A mainnet deployment should be built from current source, which does include it.",
  "A mainnet token must support EIP-2612 permit for the one-signature arming flow. Without it, arming needs the burner key to send a separate approve(), and a burner with no gas cannot do that on its own.",
];

const MAINNET_PREREQUISITES: readonly string[] = [
  "Deploy SapuRSC on Reactive mainnet (1597), funded with REACT.",
  "Deploy SapuForwarder on the token's chain, passing the official token as SAPU_TOKEN_ADDRESS so no token is created.",
  "Point the app at them with NEXT_PUBLIC_SAPU_NETWORK=mainnet, NEXT_PUBLIC_RPC_URL_1597, the origin chain's NEXT_PUBLIC_RPC_URL_<id>, and the three SAPU addresses.",
  "Arm the route again on both sides. A mainnet route shares no state with the testnet one.",
];

/** Preview text for a selection that is not the configured deployment. */
export function networkScope(input: {
  readonly configured: NetworkSelection;
  readonly selected: NetworkSelection;
  /** Human label of the origin chain this build actually reads. */
  readonly liveOrigin: string;
  /** Human label of the Reactive chain this build actually reads. */
  readonly liveReactive: string;
}): NetworkScope {
  if (input.selected === input.configured) {
    return {
      state: "live",
      label: "live",
      summary: `Reading the ${input.liveOrigin} + ${input.liveReactive} deployment. Every number on these pages comes from those two chains.`,
      limitations: [],
      prerequisites: [],
    };
  }

  const isMainnetPreview = input.selected === "mainnet";

  return {
    state: "preview",
    label: "not deployed",
    summary: `This build reads ${input.liveOrigin} + ${input.liveReactive}. Nothing below is ${input.selected} data, because no ${input.selected} deployment exists.`,
    limitations: isMainnetPreview
      ? MAINNET_LIMITATIONS
      : ["This build is configured for mainnet. Point NEXT_PUBLIC_SAPU_NETWORK at testnet to read the demo deployment."],
    prerequisites: isMainnetPreview
      ? MAINNET_PREREQUISITES
      : ["Set NEXT_PUBLIC_SAPU_NETWORK=testnet and rebuild."],
  };
}
