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
    type: "function",
    name: "tokensOf",
    stateMutability: "view",
    inputs: [{ name: "burner_", type: "address" }],
    outputs: [{ name: "", type: "address[]" }],
  },
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "setCallbackGasLimit",
    stateMutability: "nonpayable",
    inputs: [{ name: "gasLimit_", type: "uint64" }],
    outputs: [],
  },
  {
    type: "function",
    name: "coverDebt",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  {
    type: "error",
    name: "OwnableUnauthorizedAccount",
    inputs: [{ name: "account", type: "address" }],
  },
  {
    type: "error",
    name: "InvalidArgument",
    inputs: [],
  },
  {
    type: "error",
    name: "RouteAlreadyRegistered",
    inputs: [
      { name: "burner", type: "address" },
      { name: "token", type: "address" },
    ],
  },
  {
    type: "error",
    name: "RouteNotRegistered",
    inputs: [
      { name: "burner", type: "address" },
      { name: "token", type: "address" },
    ],
  },
  {
    type: "error",
    name: "ForwarderNotSet",
    inputs: [],
  },
  {
    type: "event",
    name: "RouteRevoked",
    inputs: [
      { name: "burner", type: "address", indexed: true },
      { name: "token", type: "address", indexed: true },
    ],
  },
  {
    type: "event",
    name: "ForwarderSet",
    inputs: [{ name: "forwarder", type: "address", indexed: true }],
  },
  {
    type: "event",
    name: "CallbackGasLimitSet",
    inputs: [{ name: "gasLimit", type: "uint64", indexed: false }],
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
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "disarmRoute",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token_", type: "address" },
      { name: "burner_", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "coverDebt",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  {
    type: "error",
    name: "OwnableUnauthorizedAccount",
    inputs: [{ name: "account", type: "address" }],
  },
  {
    type: "error",
    name: "InvalidArgument",
    inputs: [],
  },
  {
    type: "error",
    name: "RouteNotArmed",
    inputs: [
      { name: "burner_", type: "address" },
      { name: "token_", type: "address" },
    ],
  },
  {
    type: "error",
    name: "DestinationMismatch",
    inputs: [
      { name: "expected_", type: "address" },
      { name: "received_", type: "address" },
    ],
  },
  {
    type: "error",
    name: "NothingToSweep",
    inputs: [
      { name: "burner_", type: "address" },
      { name: "token_", type: "address" },
      { name: "amount_", type: "uint256" },
    ],
  },
  {
    type: "error",
    name: "NotAuthorized",
    inputs: [
      { name: "sender_", type: "address" },
      { name: "provider_", type: "address" },
    ],
  },
  {
    type: "error",
    name: "CallbackNotAuthorized",
    inputs: [
      { name: "sender_", type: "address" },
      { name: "expectedSender_", type: "address" },
    ],
  },
  {
    type: "event",
    name: "RouteDisarmed",
    inputs: [
      { name: "burner", type: "address", indexed: true },
      { name: "token", type: "address", indexed: true },
    ],
  },
  {
    type: "event",
    name: "PermitArmed",
    inputs: [
      { name: "token", type: "address", indexed: true },
      { name: "burner", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
      { name: "deadline", type: "uint256", indexed: false },
    ],
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
    type: "function",
    name: "name",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "nonces",
    stateMutability: "view",
    inputs: [{ name: "owner_", type: "address" }],
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

export const payerAbi = [
  {
    type: "function",
    name: "debt",
    stateMutability: "view",
    inputs: [{ name: "contract_", type: "address" }],
    outputs: [{ name: "debt_", type: "uint256" }],
  },
] as const;
