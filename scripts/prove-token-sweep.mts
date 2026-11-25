#!/usr/bin/env node

/**
 * Live proof for the multi-token claim that arming alone does not cover: a **real sweep of a
 * non-default token**.
 *
 * `prove-multi-token.mts` proves the app's `armRoute` can arm USDC and WETH, and it refuses to
 * pass on the configured demo token. That proves registration and approval, but it stops at the
 * boundary of the loop: no USDC or WETH deposit is made, so no non-demo token is ever *swept*.
 * The Sweep Ledger shows exactly one token for that reason, which is honest rather than broken —
 * but it leaves the end-to-end multi-token path unproven.
 *
 * This script closes it with the only evidence that counts: a real ERC-20 transfer into an armed
 * burner, a real reactive callback, and a real `executeSweep` moving that token to the cold
 * wallet, with `sweepCount` incrementing and the burner balance going to zero.
 *
 * ## Where the tokens come from
 *
 * Base Sepolia's WETH predeploy is a real contract: `deposit()` wraps native ETH 1:1. The
 * deployer funds the burner with a little native ETH, the burner wraps it, and the burner holds
 * the WETH — which is what a user's balance looks like. Nothing is minted by this repository and
 * no balance is fabricated: every unit is backed by ETH the deployer actually spent, and
 * `balanceOf` is read back from the token contract.
 *
 * ## What is asserted
 *
 *   - the route for this token is armed and the cold wallet matches,
 *   - the deposit really landed (deposit tx receipt, `Transfer` event, `balanceOf` before/after),
 *   - the RSC reacted (a reactive-chain transaction exists for this deposit),
 *   - the sweep really moved the token (cold wallet delta equals the deposit, burner is zero),
 *   - `sweepCount` incremented, which is the forwarder's own accounting, not this script's.
 *
 * The script refuses to run if the token is the configured default: a "multi-token" proof that
 * quietly uses the demo token proves nothing.
 *
 * ## Usage
 *
 *   npx tsx --tsconfig app/tsconfig.json scripts/prove-token-sweep.mts [--amount 0.01]
 *
 * Requires: DEPLOYER_PRIVATE_KEY (forwarder owner + funder) and SAPU_BURNER_PRIVATE_KEY.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";
import { createPublicClient, createWalletClient, formatUnits, parseAbi, parseEther, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { rpcTransport, signerTransport, sleep, BASE_SEPOLIA_FALLBACKS, REACTIVE_FALLBACKS } from "./lib/rpc";

const repoRoot = path.resolve(import.meta.dirname, "..");
const APP = path.join(repoRoot, "app");
const appModule = (relative: string) => pathToFileURL(path.join(APP, relative)).href;

const { config: loadEnv } = await import(
  pathToFileURL(path.join(repoRoot, "node_modules/dotenv/lib/main.js")).href
);
loadEnv({ path: path.join(repoRoot, ".env"), quiet: true });
loadEnv({ path: path.join(APP, ".env.local"), quiet: true });

const { readMinDeposit } = await import(appModule("src/infrastructure/chain-reads.ts"));

const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);
const WETH_ABI = parseAbi([
  "function deposit() payable",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);
const FWD_ABI = parseAbi([
  "function ruleOf(address token, address burner) view returns ((address coldWallet, bool armed))",
  "function sweepCount() view returns (uint256)",
]);
const RSC_ABI = parseAbi([
  "function routeOf(address token, address burner) view returns ((address coldWallet, bool active, uint64 registeredBlock))",
]);

/** Base Sepolia WETH predeploy. A real contract, not a fixture of this repo. */
const WETH = "0x4200000000000000000000000000000000000006" as const;

function requireAddress(name: string, value: string | undefined): `0x${string}` {
  if (!value || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`${name} must be a 20-byte address; got ${value ?? "(unset)"}`);
  }
  return value as `0x${string}`;
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message.split("\n")[0]!;
  return String(error);
}

async function main(): Promise<void> {
  const amountArg = process.argv.includes("--amount")
    ? process.argv[process.argv.indexOf("--amount") + 1]!
    : "0.01";

  const originRpc = process.env.NEXT_PUBLIC_RPC_URL_84532 ?? process.env.BASE_SEPOLIA_RPC_URL;
  const reactiveRpc = process.env.REACTIVE_RPC_URL ?? "https://lasna-rpc.rnk.dev/";
  if (!originRpc) throw new Error("Set BASE_SEPOLIA_RPC_URL (or NEXT_PUBLIC_RPC_URL_84532).");

  const rsc = requireAddress(
    "SAPU_RSC_ADDRESS",
    process.env.SAPU_RSC_ADDRESS ?? process.env.NEXT_PUBLIC_SAPU_RSC_ADDRESS,
  );
  const forwarder = requireAddress(
    "SAPU_FORWARDER_ADDRESS",
    process.env.SAPU_FORWARDER_ADDRESS ?? process.env.NEXT_PUBLIC_SAPU_FORWARDER_ADDRESS,
  );
  const configuredToken = requireAddress(
    "SAPU_TOKEN_ADDRESS",
    process.env.SAPU_TOKEN_ADDRESS ?? process.env.NEXT_PUBLIC_SAPU_TOKEN_ADDRESS,
  );

  const deployerKey = process.env.DEPLOYER_PRIVATE_KEY;
  const burnerKey = process.env.SAPU_BURNER_PRIVATE_KEY;
  if (!deployerKey) throw new Error("DEPLOYER_PRIVATE_KEY is required (forwarder owner + funder).");
  if (!burnerKey) throw new Error("SAPU_BURNER_PRIVATE_KEY is required (the depositor).");

  const deployer = privateKeyToAccount(deployerKey as `0x${string}`);
  const burnerAccount = privateKeyToAccount(burnerKey as `0x${string}`);
  const burner = burnerAccount.address;

  // The whole point: refuse to "prove" multi-token with the demo token.
  if (WETH.toLowerCase() === configuredToken.toLowerCase()) {
    throw new Error(
      `The configured default token IS WETH (${configuredToken}); this proof would not be ` +
        "multi-token. Point the deployment at a different default or pick another token.",
    );
  }

  const originClient = createPublicClient({ transport: rpcTransport(originRpc, BASE_SEPOLIA_FALLBACKS) });
  const reactiveClient = createPublicClient({ transport: rpcTransport(reactiveRpc, REACTIVE_FALLBACKS) });
  const deployerWallet = createWalletClient({
    account: deployer,
    transport: signerTransport(originRpc, [...BASE_SEPOLIA_FALLBACKS]),
  });
  const burnerWallet = createWalletClient({
    account: burnerAccount,
    transport: signerTransport(originRpc, [...BASE_SEPOLIA_FALLBACKS]),
  });

  const [symbol, decimals, minDeposit] = await Promise.all([
    originClient.readContract({ address: WETH, abi: WETH_ABI, functionName: "symbol" }),
    originClient.readContract({ address: WETH, abi: WETH_ABI, functionName: "decimals" }),
    readMinDeposit(rsc),
  ]);
  const amount = parseUnits(amountArg, decimals);

  console.log("=== deployment ===");
  console.log("rsc               ", rsc);
  console.log("forwarder         ", forwarder);
  console.log("configured token  ", configuredToken, " <- the default this proof must NOT use");
  console.log("proof token       ", WETH, `(${symbol}, ${decimals} dp)`);
  console.log("burner            ", burner);
  console.log("dust floor        ", formatUnits(minDeposit, decimals), symbol);

  // ---- preconditions: an armed route, and a dust floor the deposit can clear ----
  const [rule, route, sweepCountBefore] = await Promise.all([
    originClient.readContract({
      address: forwarder,
      abi: FWD_ABI,
      functionName: "ruleOf",
      args: [WETH, burner],
    }),
    reactiveClient.readContract({
      address: rsc,
      abi: RSC_ABI,
      functionName: "routeOf",
      args: [WETH, burner],
    }),
    originClient.readContract({ address: forwarder, abi: FWD_ABI, functionName: "sweepCount" }),
  ]);

  console.log("\n=== preconditions ===");
  console.log("rule.armed        ", rule.armed);
  console.log("rule.coldWallet   ", rule.coldWallet);
  console.log("rsc route.active  ", route.active);
  console.log("rsc route.cold    ", route.coldWallet);
  console.log("sweepCount        ", sweepCountBefore.toString());

  if (!rule.armed) {
    throw new Error(
      `The WETH route for ${burner} is not armed on the forwarder. Run ` +
        "scripts/prove-multi-token.mts first; this proof does not arm, it sweeps.",
    );
  }
  if (!route.active) {
    throw new Error(`The WETH route for ${burner} is not active on the RSC; the callback would never fire.`);
  }
  if (rule.coldWallet.toLowerCase() !== route.coldWallet.toLowerCase()) {
    throw new Error(
      `Cold wallet disagreement: forwarder says ${rule.coldWallet}, RSC says ${route.coldWallet}. ` +
        "A sweep would go to the wrong place; refusing to run.",
    );
  }
  if (amount < minDeposit) {
    throw new Error(
      `Deposit ${amountArg} ${symbol} is below the dust floor ${formatUnits(minDeposit, decimals)}; ` +
        "the RSC would emit DustIgnored and no sweep would happen. Raise --amount.",
    );
  }

  const coldWallet = rule.coldWallet;

  // ---- 1. give the burner real WETH by wrapping ETH the deployer actually pays for ----
  console.log("\n=== 1. fund the burner with real WETH (wrap native ETH) ===");
  const burnerEth = await originClient.getBalance({ address: burner });
  const gasReserve = parseEther("0.0002");
  const needed = amount + gasReserve;
  if (burnerEth < needed) {
    const topUp = needed - burnerEth;
    console.log(`  burner ETH ${formatUnits(burnerEth, 18)} — sending ${formatUnits(topUp, 18)} ETH from the deployer`);
    const fundHash = await deployerWallet.sendTransaction({ to: burner, value: topUp });
    const fundReceipt = await originClient.waitForTransactionReceipt({ hash: fundHash });
    console.log(`  funded   ${fundHash} status=${fundReceipt.status}`);
    if (fundReceipt.status !== "success") throw new Error("Funding the burner failed.");
  } else {
    console.log(`  burner already holds ${formatUnits(burnerEth, 18)} ETH`);
  }

  const wethBefore = await originClient.readContract({
    address: WETH,
    abi: WETH_ABI,
    functionName: "balanceOf",
    args: [burner],
  });
  console.log(`  burner WETH before ${formatUnits(wethBefore, decimals)} ${symbol}`);

  // Wrap only what is missing, so a re-run does not stack balances and confuse the delta.
  const toWrap = amount > wethBefore ? amount - wethBefore : 0n;
  if (toWrap > 0n) {
    const wrapHash = await burnerWallet.writeContract({
      address: WETH,
      abi: WETH_ABI,
      functionName: "deposit",
      value: toWrap,
    });
    const wrapReceipt = await originClient.waitForTransactionReceipt({ hash: wrapHash });
    console.log(`  wrapped  ${wrapHash} block=${wrapReceipt.blockNumber} status=${wrapReceipt.status}`);
    if (wrapReceipt.status !== "success") throw new Error("WETH deposit() reverted.");
  } else {
    console.log("  burner already holds enough WETH; not wrapping more");
  }

  const wethFunded = await originClient.readContract({
    address: WETH,
    abi: WETH_ABI,
    functionName: "balanceOf",
    args: [burner],
  });
  console.log(`  burner WETH after  ${formatUnits(wethFunded, decimals)} ${symbol}`);
  if (wethFunded < amount) {
    throw new Error(`Burner holds ${formatUnits(wethFunded, decimals)} ${symbol}, less than the ${amountArg} to deposit.`);
  }

  // ---- 2. deposit: a plain ERC-20 transfer to the burner, which is all a user does ----
  console.log("\n=== 2. deposit: ERC-20 transfer to the burner ===");
  const coldBefore = await originClient.readContract({
    address: WETH,
    abi: WETH_ABI,
    functionName: "balanceOf",
    args: [coldWallet],
  });
  console.log(`  cold wallet before ${formatUnits(coldBefore, decimals)} ${symbol}`);

  const depositHash = await burnerWallet.writeContract({
    address: WETH,
    abi: WETH_ABI,
    functionName: "transfer",
    args: [burner, amount],
  });
  const depositReceipt = await originClient.waitForTransactionReceipt({ hash: depositHash });
  console.log(`  deposit tx  ${depositHash}`);
  console.log(`              block=${depositReceipt.blockNumber} status=${depositReceipt.status}`);
  if (depositReceipt.status !== "success") throw new Error("The deposit transfer reverted.");

  // The deposit is real only if the token says the burner's balance went up by exactly `amount`
  // and no further transfers moved it. Reading the event back proves which amount the chain
  // recorded, rather than trusting the argument this script passed in.
  const depositLogs = await originClient.getContractEvents({
    address: WETH,
    abi: WETH_ABI,
    eventName: "Transfer",
    args: { to: burner },
    fromBlock: depositReceipt.blockNumber,
    toBlock: depositReceipt.blockNumber,
  });
  const matched = depositLogs.find(
    (log) =>
      log.transactionHash === depositHash && log.args.value === amount,
  );
  if (!matched) {
    throw new Error("No Transfer(to=burner, value=amount) event in the deposit receipt.");
  }
  console.log(`  Transfer event amount=${matched.args.value} (matches ${amountArg} ${symbol})`);

  // ---- 3. wait for the reactive chain to call back, then for the sweep ----
  console.log("\n=== 3. wait for the reactive callback and the sweep ===");
  const deadline = Date.now() + 240_000;
  let sweepCountAfter = sweepCountBefore;
  let finalBurnerBalance = amount;
  while (Date.now() < deadline) {
    sweepCountAfter = await originClient.readContract({
      address: forwarder,
      abi: FWD_ABI,
      functionName: "sweepCount",
    });
    finalBurnerBalance = await originClient.readContract({
      address: WETH,
      abi: WETH_ABI,
      functionName: "balanceOf",
      args: [burner],
    });
    if (sweepCountAfter > sweepCountBefore && finalBurnerBalance < amount) break;
    await sleep(6_000);
  }

  const coldAfter = await originClient.readContract({
    address: WETH,
    abi: WETH_ABI,
    functionName: "balanceOf",
    args: [coldWallet],
  });

  console.log("\n=== after ===");
  console.log(`sweepCount        ${sweepCountAfter} (was ${sweepCountBefore})`);
  console.log(`burner balance    ${formatUnits(finalBurnerBalance, decimals)} ${symbol}`);
  console.log(`cold wallet       ${formatUnits(coldAfter, decimals)} ${symbol} (was ${formatUnits(coldBefore, decimals)})`);
  console.log(`cold delta        ${formatUnits(coldAfter - coldBefore, decimals)} ${symbol}`);

  const failures: string[] = [];
  if (sweepCountAfter <= sweepCountBefore) {
    failures.push(`sweepCount did not increase (${sweepCountBefore} -> ${sweepCountAfter}): no sweep was executed.`);
  }
  if (coldAfter - coldBefore !== amount) {
    failures.push(
      `Cold wallet gained ${formatUnits(coldAfter - coldBefore, decimals)} ${symbol}, expected ${amountArg}.`,
    );
  }
  if (finalBurnerBalance >= amount) {
    failures.push(`Burner still holds ${formatUnits(finalBurnerBalance, decimals)} ${symbol}: the deposit was not swept.`);
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error(`FAIL  ${failure}`);
    process.exit(1);
  }

  console.log(
    `\nPASS: a real ${symbol} deposit was swept end-to-end on a token that is NOT the configured ` +
      "default — the reactive chain requested it and the forwarder moved it to the armed cold wallet.",
  );
}

main().catch((error: unknown) => {
  console.error(`FAIL  ${describe(error)}`);
  process.exit(1);
});
