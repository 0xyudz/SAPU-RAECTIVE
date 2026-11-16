/**
 * Minimal, hand-picked ABIs.
 *
 * Only the members SAPU actually reads or calls are declared. A full ABI dump would
 * bloat the client bundle and, worse, invite accidental use of functions the app has
 * no business touching.
 */

export const sapuRscAbi = [
  {
    type: "function",
    name: "registerRoute",
    stateMutability: "nonpayable",
    inputs: [
      { name: "burner_", type: "address" },
      { name: "coldWallet_", type: "address" },
      { name: "token_", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "revokeRoute",
    stateMutability: "nonpayable",
    inputs: [
      { name: "burner_", type: "address" },
      { name: "token_", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setForwarder",
    stateMutability: "nonpayable",
    inputs: [{ name: "forwarder_", type: "address" }],
    outputs: [],
  },
  {
    type: "function",
    name: "routeOf",
    stateMutability: "view",
    inputs: [
      { name: "token_", type: "address" },
      { name: "burner_", type: "address" },
    ],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "coldWallet", type: "address" },
          { name: "active", type: "bool" },
          { name: "registeredBlock", type: "uint64" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "paused",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "sapuForwarder",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "callbackGasLimit",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint64" }],
  },
  {
    type: "function",
    name: "CHAIN_ID",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "subscriptionCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "event",
    name: "RouteRegistered",
    inputs: [
      { name: "burner", type: "address", indexed: true },
      { name: "coldWallet", type: "address", indexed: true },
      { name: "token", type: "address", indexed: true },
      { name: "gasLimit", type: "uint64", indexed: false },
    ],
  },
  {
    type: "event",
    name: "PurgeTriggered",
    inputs: [
      { name: "burner", type: "address", indexed: true },
      { name: "token", type: "address", indexed: true },
      { name: "coldWallet", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "originBlockNumber", type: "uint256", indexed: false },
    ],
  },
] as const;

export const sapuForwarderAbi = [
  {
    type: "function",
    name: "executeSweep",
    stateMutability: "nonpayable",
    inputs: [
      { name: "reactiveSender_", type: "address" },
      { name: "token_", type: "address" },
      { name: "burner_", type: "address" },
      { name: "coldWallet_", type: "address" },
      { name: "amount_", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "armRoute",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token_", type: "address" },
      { name: "burner_", type: "address" },
      { name: "coldWallet_", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "armWithPermit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token_", type: "address" },
      { name: "burner_", type: "address" },
      { name: "value_", type: "uint256" },
      { name: "deadline_", type: "uint256" },
      { name: "v_", type: "uint8" },
      { name: "r_", type: "bytes32" },
      { name: "s_", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "sweepCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "totalSwept",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "ruleOf",
    stateMutability: "view",
    inputs: [
      { name: "token_", type: "address" },
      { name: "burner_", type: "address" },
    ],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "coldWallet", type: "address" },
          { name: "armed", type: "bool" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "_CALLBACK_SENDER",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "event",
    name: "TokensSwept",
    inputs: [
      { name: "burner", type: "address", indexed: true },
      { name: "token", type: "address", indexed: true },
      { name: "coldWallet", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "reactiveSender", type: "address", indexed: false },
    ],
  },
  {
    type: "event",
    name: "RouteArmed",
    inputs: [
      { name: "burner", type: "address", indexed: true },
      { name: "token", type: "address", indexed: true },
      { name: "coldWallet", type: "address", indexed: true },
    ],
  },
] as const;

export const erc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to_", type: "address" },
      { name: "amount_", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
] as const;
