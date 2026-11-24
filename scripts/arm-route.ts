#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import {
  createPublicClient,
  createWalletClient,
  parseAbi,
  parseAbiItem,
  parseSignature,
  parseUnits,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import {
  rpcTransport,
  signerTransport,
  sendWithReconcile,
  BASE_SEPOLIA_FALLBACKS,
  REACTIVE_FALLBACKS,
} from "./lib/rpc";
import { explorerFor } from "./lib/explorers";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

loadEnv({ path: path.join(REPO_ROOT, ".env"), quiet: true });
loadEnv({ path: path.join(REPO_ROOT, "app", ".env.local"), quiet: true });

const MAX_UINT256 = (1n << 256n) - 1n;
// Reactive charges a fixed 1 wei priority fee; that is a property of the Reactive chain,
// not of Lasna specifically, so it applies to any reactive deployment.
const REACTIVE_FEES = { maxPriorityFeePerGas: 1n } as const;

const RSC_ABI = parseAbi([
  "function sapuForwarder() view returns (address)",
  "function setForwarder(address forwarder_)",
  "function registerRoute(address burner_, address coldWallet_, address token_)",
  "function routeOf(address token_, address burner_) view returns ((address coldWallet, bool active, uint64 registeredBlock))",
]);

const FORWARDER_ABI = parseAbi([
  "function armRoute(address token_, address burner_, address coldWallet_)",
  "function armWithPermit(address token_, address burner_, uint256 value_, uint256 deadline_, uint8 v_, bytes32 r_, bytes32 s_)",
  "function ruleOf(address token_, address burner_) view returns ((address coldWallet, bool armed))",
]);

const TOKEN_ABI = parseAbi([
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function nonces(address owner) view returns (uint256)",
  "function mint(address to_, uint256 amount_)",
]);

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requireAddr(primary: string, fallback?: string): `0x${string}` {
  const val = process.env[primary] || (fallback ? process.env[fallback] : undefined);
  if (!val || !/^0x[0-9a-fA-F]{40}$/.test(val)) {
    throw new Error(`Missing or invalid address env ${primary}`);
  }
  return val as `0x${string}`;
}

async function main(): Promise<void> {
  const outPath = argValue("--out");
  const depositAmountArg = argValue("--amount") ?? process.env.SAPU_DEPOSIT_AMOUNT ?? "1";

  const baseRpc = process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org";
  const reactiveRpc = process.env.REACTIVE_RPC_URL ?? "https://lasna-rpc.rnk.dev/";

  const deployerKey = process.env.DEPLOYER_PRIVATE_KEY as `0x${string}` | undefined;
  const reactiveKey = process.env.REACTIVE_PRIVATE_KEY as `0x${string}` | undefined;
  if (!deployerKey || !reactiveKey) {
    throw new Error("DEPLOYER_PRIVATE_KEY and REACTIVE_PRIVATE_KEY are required.");
  }

  const rscAddress = requireAddr("SAPU_RSC_ADDRESS", "NEXT_PUBLIC_SAPU_RSC_ADDRESS");
  const forwarderAddress = requireAddr("SAPU_FORWARDER_ADDRESS", "NEXT_PUBLIC_SAPU_FORWARDER_ADDRESS");
  const tokenAddress = requireAddr("SAPU_TOKEN_ADDRESS", "NEXT_PUBLIC_SAPU_TOKEN_ADDRESS");

  const deployerAccount = privateKeyToAccount(deployerKey);
  const reactiveAccount = privateKeyToAccount(reactiveKey);

  const coldWallet = (
    process.env.SAPU_COLD_WALLET && /^0x[0-9a-fA-F]{40}$/.test(process.env.SAPU_COLD_WALLET)
      ? process.env.SAPU_COLD_WALLET
      : deployerAccount.address
  ) as `0x${string}`;

  // A supplied key is the burner. This used to be gated on `SAPU_BURNER_ADDRESS` alone,
  // so a persisted `SAPU_BURNER_PRIVATE_KEY` was read into `burnerKey` and then immediately
  // overwritten by a fresh `generatePrivateKey()` — every run armed a brand-new burner and
  // the operator silently lost the ability to sign a later permit for the one actually in
  // use. Deriving the address from the key keeps the two in step and makes `rescueSweep`
  // demonstrable: the key on disk is always the key for the armed burner.
  const suppliedKey = process.env.SAPU_BURNER_PRIVATE_KEY as `0x${string}` | undefined;
  const suppliedAddress = process.env.SAPU_BURNER_ADDRESS as `0x${string}` | undefined;
  const hasAddress = !!suppliedAddress && /^0x[0-9a-fA-F]{40}$/.test(suppliedAddress);

  let burnerKey: `0x${string}` | undefined = suppliedKey;
  let burnerAddress: `0x${string}`;

  if (hasAddress) {
    burnerAddress = suppliedAddress;
    if (burnerKey && privateKeyToAccount(burnerKey).address.toLowerCase() !== burnerAddress.toLowerCase()) {
      throw new Error(
        `SAPU_BURNER_ADDRESS ${burnerAddress} does not match SAPU_BURNER_PRIVATE_KEY (${privateKeyToAccount(burnerKey).address}); refusing to arm a burner it cannot sign for.`,
      );
    }
  } else if (burnerKey) {
    burnerAddress = privateKeyToAccount(burnerKey).address;
  } else {
    burnerKey = generatePrivateKey();
    burnerAddress = privateKeyToAccount(burnerKey).address;
    console.warn(
      "  no SAPU_BURNER_PRIVATE_KEY supplied: generated a throwaway burner. Its key is NOT persisted, so this burner can never be re-permitted.",
    );
  }

  const basePublic = createPublicClient({ transport: rpcTransport(baseRpc, BASE_SEPOLIA_FALLBACKS) });
  const baseSigner = createPublicClient({ transport: signerTransport(baseRpc) });
  const baseWallet = createWalletClient({
    account: deployerAccount,
    transport: signerTransport(baseRpc),
  });
  const reactivePublic = createPublicClient({ transport: rpcTransport(reactiveRpc, REACTIVE_FALLBACKS) });
  const reactiveSigner = createPublicClient({ transport: signerTransport(reactiveRpc) });
  const reactiveWallet = createWalletClient({
    account: reactiveAccount,
    transport: signerTransport(reactiveRpc),
  });

  const baseCtx = { client: baseSigner, address: deployerAccount.address };
  const reactiveCtx = { client: reactiveSigner, address: reactiveAccount.address };

  // The chain ids come from the nodes. They are used for the EIP-2612 permit domain (a
  // wrong `chainId` produces a signature the token rejects) and for the explorer links in
  // the arm record, so both must describe the chain the run is actually on.
  const [originChainId, reactiveChainId] = await Promise.all([
    basePublic.getChainId(),
    reactivePublic.getChainId(),
  ]);
  const originExplorer = explorerFor(originChainId, process.env.SAPU_ORIGIN_EXPLORER_URL);
  const reactiveExplorer = explorerFor(reactiveChainId, process.env.SAPU_REACTIVE_EXPLORER_URL);
  if (originExplorer === null || reactiveExplorer === null) {
    console.warn(
      "warning: no explorer URL known for one of these chains. Hashes are still recorded; " +
        "links are omitted rather than pointed at the wrong chain.",
    );
  }

  let armTx: {
    hash: `0x${string}`;
    chainId: number;
    explorerUrl: string;
    blockNumber: string;
    gasUsed: string;
    label: string;
  } | null = null;

  const currentFwd = await reactivePublic.readContract({
    address: rscAddress,
    abi: RSC_ABI,
    functionName: "sapuForwarder",
  });
  if (currentFwd.toLowerCase() !== forwarderAddress.toLowerCase()) {
    const hash = await sendWithReconcile(
      "setForwarder",
      (nonce) =>
        reactiveWallet.writeContract({
          address: rscAddress,
          abi: RSC_ABI,
          functionName: "setForwarder",
          args: [forwarderAddress],
          account: reactiveAccount,
          chain: null,
          nonce,
          ...REACTIVE_FEES,
        }),
      reactiveCtx,
    );
    const receipt = await reactivePublic.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("setForwarder reverted");
    console.log(`setForwarder  ${hash}`);
  }

  const route = await reactivePublic.readContract({
    address: rscAddress,
    abi: RSC_ABI,
    functionName: "routeOf",
    args: [tokenAddress, burnerAddress],
  });
  if (!route.active) {
    const hash = await sendWithReconcile(
      "registerRoute",
      (nonce) =>
        reactiveWallet.writeContract({
          address: rscAddress,
          abi: RSC_ABI,
          functionName: "registerRoute",
          args: [burnerAddress, coldWallet, tokenAddress],
          account: reactiveAccount,
          chain: null,
          nonce,
          ...REACTIVE_FEES,
        }),
      reactiveCtx,
    );
    const receipt = await reactivePublic.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("registerRoute reverted");
    armTx = {
      hash,
      chainId: reactiveChainId,
      explorerUrl: `${reactiveExplorer ?? ""}/tx/${hash}`,
      blockNumber: receipt.blockNumber.toString(),
      gasUsed: receipt.gasUsed.toString(),
      label: "Register route on SapuRSC",
    };
    console.log(`registerRoute ${hash}`);
  } else {
    console.log(`registerRoute already active for ${burnerAddress}`);
    const head = await reactivePublic.getBlockNumber();
    const fromBlock = route.registeredBlock > 0n ? BigInt(route.registeredBlock) : head > 50_000n ? head - 50_000n : 0n;
    const logs = await reactivePublic.getLogs({
      address: rscAddress,
      event: parseAbiItem(
        "event RouteRegistered(address indexed burner, address indexed coldWallet, address indexed token, uint64 gasLimit)",
      ),
      args: { burner: burnerAddress, token: tokenAddress },
      fromBlock,
      toBlock: route.registeredBlock > 0n ? BigInt(route.registeredBlock) : head,
    }).catch(() => []);
    const last = logs[logs.length - 1];
    if (last?.transactionHash) {
      // This is a real `RouteRegistered` transaction from an earlier run, not a zero-gas
      // call. Reporting `gasUsed: "0"` made the proof record a number the chain never
      // produced, so read the receipt and report what it actually cost.
      const prior = await reactivePublic
        .getTransactionReceipt({ hash: last.transactionHash })
        .catch(() => null);
      armTx = {
        hash: last.transactionHash,
        chainId: reactiveChainId,
        explorerUrl: `${reactiveExplorer ?? ""}/tx/${last.transactionHash}`,
        blockNumber: last.blockNumber.toString(),
        gasUsed: prior?.gasUsed.toString() ?? "unknown",
        label: "Register route on SapuRSC",
      };
    }
  }

  const allowance = await basePublic.readContract({
    address: tokenAddress,
    abi: TOKEN_ABI,
    functionName: "allowance",
    args: [burnerAddress, forwarderAddress],
  });
  if (allowance === 0n) {
    if (!burnerKey) {
      throw new Error(
        `Burner ${burnerAddress} has 0 allowance and SAPU_BURNER_PRIVATE_KEY is unset; cannot sign EIP-2612 permit.`,
      );
    }
    const burnerAccount = privateKeyToAccount(burnerKey);
    const [tokenName, nonce] = await Promise.all([
      basePublic.readContract({ address: tokenAddress, abi: TOKEN_ABI, functionName: "name" }),
      basePublic.readContract({
        address: tokenAddress,
        abi: TOKEN_ABI,
        functionName: "nonces",
        args: [burnerAddress],
      }),
    ]);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const sig = await burnerAccount.signTypedData({
      domain: {
        name: tokenName,
        version: "1",
        chainId: originChainId,
        verifyingContract: tokenAddress,
      },
      types: {
        Permit: [
          { name: "owner", type: "address" },
          { name: "spender", type: "address" },
          { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      primaryType: "Permit",
      message: {
        owner: burnerAddress,
        spender: forwarderAddress,
        value: MAX_UINT256,
        nonce,
        deadline,
      },
    });
    const parsed = parseSignature(sig);
    const hash = await sendWithReconcile(
      "armWithPermit",
      (nonce) =>
        baseWallet.writeContract({
          address: forwarderAddress,
          abi: FORWARDER_ABI,
          functionName: "armWithPermit",
          args: [tokenAddress, burnerAddress, MAX_UINT256, deadline, Number(parsed.v), parsed.r, parsed.s],
          account: deployerAccount,
          chain: null,
          nonce,
        }),
      baseCtx,
    );
    const receipt = await basePublic.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("armWithPermit reverted");
    console.log(`armWithPermit ${hash}`);
  }

  const rule = await basePublic.readContract({
    address: forwarderAddress,
    abi: FORWARDER_ABI,
    functionName: "ruleOf",
    args: [tokenAddress, burnerAddress],
  });
  if (!rule.armed || rule.coldWallet.toLowerCase() !== coldWallet.toLowerCase()) {
    const hash = await sendWithReconcile(
      "armRoute",
      (nonce) =>
        baseWallet.writeContract({
          address: forwarderAddress,
          abi: FORWARDER_ABI,
          functionName: "armRoute",
          args: [tokenAddress, burnerAddress, coldWallet],
          account: deployerAccount,
          chain: null,
          nonce,
        }),
      baseCtx,
    );
    const receipt = await basePublic.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("armRoute reverted");
    armTx ??= {
      hash,
      chainId: originChainId,
      explorerUrl: `${originExplorer ?? ""}/tx/${hash}`,
      blockNumber: receipt.blockNumber.toString(),
      gasUsed: receipt.gasUsed.toString(),
      label: "Arm rule on SapuForwarder",
    };
    console.log(`armRoute      ${hash}`);
  } else {
    console.log(`armRoute      already armed on SapuForwarder`);
  }

  const [decimals, deployerBal] = await Promise.all([
    basePublic.readContract({ address: tokenAddress, abi: TOKEN_ABI, functionName: "decimals" }),
    basePublic.readContract({
      address: tokenAddress,
      abi: TOKEN_ABI,
      functionName: "balanceOf",
      args: [deployerAccount.address],
    }),
  ]);
  const needed = parseUnits(depositAmountArg, Number(decimals));
  if (deployerBal < needed) {
    // Only the demo token has a permissionless `mint`. A real ERC-20 does not, so this
    // must report what is missing instead of sending a call that can only revert.
    const mintable = await basePublic
      .readContract({ address: tokenAddress, abi: TOKEN_ABI, functionName: "mint", args: [deployerAccount.address, 0n] })
      .then(() => true)
      .catch(() => false);
    if (!mintable) {
      throw new Error(
        `Deployer ${deployerAccount.address} holds ${deployerBal} base units of ${tokenAddress} but needs ` +
          `${needed} to make the demo deposit, and this token has no permissionless mint(). ` +
          `Fund the deployer with the token, or lower --deposit-amount.`,
      );
    }
    const hash = await sendWithReconcile(
      "mint",
      (nonce) =>
        baseWallet.writeContract({
          address: tokenAddress,
          abi: TOKEN_ABI,
          functionName: "mint",
          args: [deployerAccount.address, needed * 10n],
          account: deployerAccount,
          chain: null,
          nonce,
        }),
      baseCtx,
    );
    await basePublic.waitForTransactionReceipt({ hash });
    console.log(`minted        ${hash}`);
  }

  const summary = {
    burner: burnerAddress,
    coldWallet,
    rsc: rscAddress,
    forwarder: forwarderAddress,
    token: tokenAddress,
    armTx,
  };

  if (outPath) {
    fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
  }
  console.log(`BURNER=${burnerAddress}`);
  console.log(`COLD_WALLET=${coldWallet}`);
}

main().catch((error) => {
  console.error("arm-route failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
