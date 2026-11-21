export interface DocSection {
  readonly heading: string;
  readonly body: readonly string[];
  readonly code?: { readonly language: string; readonly content: string };
  readonly list?: readonly string[];
}

export interface DocPage {
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly sections: readonly DocSection[];
}

export const DOC_PAGES: readonly DocPage[] = [
  {
    slug: "reactive-loop",
    title: "The reactive loop",
    summary:
      "Exact topic hashes, subscription criteria, gas requirements, and the three transactions that prove the loop ran.",
    sections: [
      {
        heading: "Origin event",
        body: [
          "The origin is a plain ERC-20 Transfer on Base Sepolia. Nothing custom, nothing wrapped — SAPU reads the same event every wallet and indexer already understands.",
          "Transfer has two indexed parameters, so a deposit arrives with three topics and only the amount left in data. That third topic position is what makes a per-burner subscription possible without watching every transfer on the chain.",
        ],
        code: {
          language: "solidity",
          content: `event Transfer(address indexed from, address indexed to, uint256 value);

// topic0 = keccak256("Transfer(address,address,uint256)")
//        = 0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef
// topic1 = from   (left-padded to 32 bytes)
// topic2 = to     (left-padded to 32 bytes)  <-- the burner
// data   = abi.encode(uint256 value)
// opCode = 3 (LOG3)`,
        },
      },
      {
        heading: "Subscription criteria",
        body: [
          "SapuRSC subscribes once per (token, burner) pair. The six criteria are passed verbatim to the system contract at 0x8888888888888888888888888888888888888888.",
          "topic1 and topic3 are left as REACTIVE_IGNORE, so any sender may deposit and extra topics are irrelevant. topic2 is narrowed to the burner, which is the whole trick: the node filters before the reactive contract ever pays for a transaction.",
        ],
        code: {
          language: "solidity",
          content: `SYSTEM.subscribe(
    84532,                                    // Base Sepolia
    token,                                    // the ERC-20
    0xddf252ad...b3ef,                        // TRANSFER_TOPIC_0
    REACTIVE_IGNORE,                          // topic1: any sender
    uint256(uint160(burner)),                 // topic2: only deposits TO the burner
    REACTIVE_IGNORE                           // topic3: unused by ERC-20 Transfer
);`,
        },
        list: [
          "Criteria are equality-only — there are no ranges or wildcards beyond REACTIVE_IGNORE.",
          "Subscriptions live in the node, not in contract storage, so they cannot be read back on-chain. SAPU tracks them itself and replays them exactly.",
          "unsubscribe only removes a criteria set that matches all six arguments exactly, which is why the criteria are stored once and reused.",
        ],
      },
      {
        heading: "Callback payload",
        body: [
          "Reactive Network overwrites the first 160 bits of every callback payload with the address of the reactive contract that requested it. The destination therefore has to declare address as its first parameter — this is the single most common way to break a callback.",
          "SapuRSC passes address(0) as that zero-address sentinel. The proxy replaces it before delivery, and SapuForwarder checks the result against the immutable _CALLBACK_SENDER.",
        ],
        code: {
          language: "solidity",
          content: `bytes memory payload = abi.encodeWithSignature(
    "executeSweep(address,address,address,address,uint256)",
    address(0),        // <- overwritten by the proxy with SapuRSC's address
    token,
    burner,
    coldWallet,
    amount
);

SYSTEM.requestCallbackV_1_0(
    ISystemContract.CallbackConfiguration_V_1_0({
        chainId: 84532,
        recipient: forwarder,
        gasLimit: 150_000,
        payload: payload
    })
);`,
        },
      },
      {
        heading: "Gas requirements",
        body: [
          "Three separate balances have to stay funded, on three different budgets. A contract in debt receives nothing, so an unfunded component silently stops working.",
        ],
        list: [
          "SapuRSC pays for its own reactive transactions in REACT (lREACT on Lasna). Fund it at deployment; the constructor is payable.",
          "SapuForwarder pays for callback execution in the destination chain's native token (ETH on Base Sepolia). The callback proxy bills it, not the RSC.",
          "The burner pays for nothing. It holds zero ETH for its entire life — that is the product.",
          "150,000 gas is the requested callback limit. The proxy withholds some for its own accounting, so a forwarder that emits CallbackFailure may need the limit raised rather than more funding.",
        ],
      },
      {
        heading: "The three transactions",
        body: [
          "Tx1 is the deposit: an ERC-20 Transfer on Base Sepolia into the burner. Tx2 is the system contract's CallbackRequest on Reactive Lasna. Tx3 is the forwarder's TokensSwept on Base Sepolia.",
          "Each leg is independently verifiable on its own explorer. The proof table in the console links all three.",
        ],
        list: [
          "Tx2 topic0 = keccak256(\"CallbackRequest(uint256,address,address,uint8,bytes)\") = 0xef94dbc6…b133",
          "Tx2 topic1 = destination chain id, topic2 = requesting RSC, topic3 = recipient forwarder",
          "Tx3 topic0 = keccak256(\"TokensSwept(address,address,address,uint256,address)\") = 0x17699015…6454",
        ],
      },
    ],
  },
  {
    slug: "security",
    title: "Security model",
    summary: "The two independent callback guards, the on-chain destination re-check, and what each one actually buys.",
    sections: [
      {
        heading: "Two guards, neither sufficient alone",
        body: [
          "SapuForwarder applies onlyServiceProvider and onlyCallbackSender to executeSweep. They answer different questions and one is not a substitute for the other.",
        ],
        list: [
          "onlyServiceProvider asks: is msg.sender the callback proxy? Without it, anyone can call executeSweep directly and pass whatever address they like as the first argument, defeating the second check entirely.",
          "onlyCallbackSender asks: is the injected address the RSC we authorized? Without it, any reactive contract on the network can drive this forwarder through the legitimate proxy.",
          "Both are required. Together they establish that the call came through the network and originated from the contract we trust.",
        ],
      },
      {
        heading: "Destination re-checked on-chain",
        body: [
          "The forwarder keeps its own (token, burner) -> coldWallet registry and rejects any callback whose destination disagrees with it. This is defence in depth against a compromised or upgraded RSC.",
          "A test proves it: a second, attacker-controlled SapuRSC registers the same burner pointing at the attacker, requests a callback through the genuine proxy, and the forwarder rejects it with DestinationMismatch. The attacker receives nothing.",
        ],
      },
      {
        heading: "Owner-gated registration",
        body: [
          "registerRoute is onlyOwner. A permissionless version would be a direct theft primitive: an attacker could point someone else's burner at the attacker's cold wallet and harvest every deposit.",
          "The same applies to armRoute on the forwarder. Both sides are operator-controlled, which is the correct tradeoff for a personal privacy tool.",
        ],
      },
      {
        heading: "Burner key handling",
        body: [
          "Burner private keys are generated in the browser with crypto.getRandomValues and held in a module-scoped Map. Every vault function throws if window is absent, so no server-side code path can touch a key.",
          "The key is never written to localStorage, sessionStorage, cookies, IndexedDB, or the network. It dies with the tab.",
        ],
        list: [
          "This protects against server-side leakage and accidental persistence.",
          "It does not protect against XSS in this app, a compromised browser, or a malicious extension.",
          "The burner key is only ever used to sign an EIP-2612 permit, which reveals nothing on-chain and costs no gas.",
        ],
      },
    ],
  },
  {
    slug: "limitations",
    title: "Limitations and tradeoffs",
    summary:
      "Permit versus allowance, what SAPU does not hide, latency reality, and the failure modes you should know about.",
    sections: [
      {
        heading: "Permit vs allowance",
        body: [
          "SapuForwarder needs permission to move tokens out of the burner. There are exactly two ways to grant it, and they are not equivalent.",
        ],
        list: [
          "EIP-2612 permit (the default): the burner signs a message off-chain for free, a relayer submits it, and the forwarder gets a standing allowance. No gas in the burner, no transaction from the burner. This is the only option that preserves the product's core promise.",
          "Plain approve(): requires a transaction from the burner, which requires native gas in the burner — which requires funding it from somewhere, which recreates the exact link SAPU exists to destroy. Only viable if the burner already has gas for unrelated reasons.",
          "The permit path only works for tokens that implement EIP-2612. SweepableERC20 does; most major tokens do; some do not. For a non-permit token the operator must fall back to approve() and accept the gas requirement.",
        ],
      },
      {
        heading: "What SAPU does not hide",
        body: [
          "Privacy is not anonymity, and overclaiming here would be dishonest.",
        ],
        list: [
          "The deposit transaction is public. Anyone watching the burner sees the funds arrive and sees them leave. SAPU shrinks the window; it does not hide the event.",
          "The cold wallet is linked to the burner on-chain by the sweep itself. If the cold wallet is your main wallet, the sweep creates the very link you were trying to avoid. Use a genuinely separate cold wallet.",
          "SAPU removes the gas-funding link specifically — the one you would create by sending ETH to the burner. That is a real and meaningful reduction, not a complete solution.",
          "Timing correlation still exists: a deposit and a sweep seconds apart are visibly related.",
        ],
      },
      {
        heading: "Latency",
        body: [
          "The loop is fast but not instant. Reactive Lasna targets roughly one-second blocks with CometBFT instant finality, and Base Sepolia has its own block time. End-to-end is typically a few seconds.",
          "The claim to hold SAPU to is \"before anyone can watch it fill\" — meaning the burner is not a durable resting place for value — not \"zero latency\".",
        ],
      },
      {
        heading: "Failure modes",
        body: [
          "Things that can go wrong, stated plainly.",
        ],
        list: [
          "Route not armed on the forwarder: the callback fires and reverts with RouteNotArmed. The deposit sits in the burner until the rule is added and a later deposit re-triggers the loop.",
          "No allowance: executeSweep reverts, surfacing as CallbackFailure on the destination. The deposit stays put.",
          "Forwarder in debt: the proxy reverts with InDebt before delivery, so callbacks stop entirely until it is funded. coverDebt() is permissionless so anyone can fix it.",
          "RSC in debt: it receives no reactive transactions at all. coverDebt() is likewise permissionless.",
          "Callback gas too low: surfaces as CallbackFailure rather than a catchable revert. Raise callbackGasLimit on the RSC.",
          "A failed callback still costs the forwarder gas. Repeated failures drain it, so failures are not free to ignore.",
        ],
      },
    ],
  },
];

export function findDoc(slug: string): DocPage | undefined {
  return DOC_PAGES.find((page) => page.slug === slug);
}
