/**
 * Read-only verification against GIWA Sepolia (chain 91342).
 * No private key, no sends. Run: npx tsx scripts/verify-reads.ts
 *
 * 1. Lists all V4 Configs and evaluates graduation-qualification for use as a
 *    launch template (enabled, concentrated, WETH quote, budget reconciliation
 *    of a derived config, Config #6 blocklisted).
 * 2. Discovers launches from the V4 factory LaunchCreated logs.
 * 3. Verifies FeeVault reads and a sample curve quote.
 */
import {
  createPublicClient,
  custom,
  defineChain,
  http,
  type Transport,
} from "viem";
import {
  ammoraLaunchFactoryV4Abi,
  feeVaultAbi,
  getAmmoraV4ConfigAtBlock,
  getAmmoraV4NextConfigId,
  giwaSepoliaAutoRoute,
  giwaSepoliaAutoRouteDeployment,
  resolveAmmoraFinalizedHead,
  verifyAmmoraV4CoreAtBlock,
  AmmoraV4LaunchCurveClient,
  type AmmoraV4ConfigSnapshot,
} from "@ammora-protocol/sdk";
import {
  buildSingleSegmentCurve,
  concentratedDepositQuote,
} from "@ammora-protocol/math";

const DEPLOYMENT = giwaSepoliaAutoRouteDeployment;
const RPC_URL = "https://sepolia-rpc.giwa.io";
const BLOCKED_CONFIG_ID = 6n;

const pacedHttp = (url: string, intervalMs = 100): Transport => {
  let tail: Promise<unknown> = Promise.resolve();
  let nextStart = 0;
  return (parameters) => {
    const base = http(url, { retryCount: 0, timeout: 30_000 })(parameters);
    return custom({
      request: (args) => {
        const result = tail.then(async () => {
          await new Promise((r) => setTimeout(r, Math.max(0, nextStart - Date.now())));
          try {
            return await base.request(args);
          } finally {
            nextStart = Date.now() + intervalMs;
          }
        });
        tail = result.catch(() => undefined);
        return result;
      },
    }, { retryCount: 0 })(parameters);
  };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRetry<T>(fn: () => Promise<T>, label: string, attempts = 4): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await sleep(1000 * (i + 1));
    }
  }
  throw new Error(`${label} failed after ${attempts} attempts: ${String(last)}`);
}

async function main() {
  const chain = defineChain({
    id: DEPLOYMENT.chain.id,
    name: DEPLOYMENT.chain.name,
    nativeCurrency: DEPLOYMENT.chain.nativeCurrency,
    rpcUrls: { default: { http: [RPC_URL] } },
  });
  const client = createPublicClient({ chain, transport: pacedHttp(RPC_URL) });
  const chainId = await client.getChainId();
  console.log(`chainId=${chainId} slot=${DEPLOYMENT.slot} startBlock=${DEPLOYMENT.startBlock}`);
  const launch = DEPLOYMENT.contracts.launch;
  if (launch.protocolVersion !== 4) throw new Error("not V4");
  console.log(`factory=${launch.factory}`);
  console.log(`registry=${launch.configRegistry}`);
  console.log(`feePolicy=${launch.feePolicy}`);
  console.log(`concentratedFactory=${launch.concentratedFactory}`);
  console.log(`positionManager=${launch.concentratedPositionManager}`);
  console.log(`contracts keys: ${Object.keys(DEPLOYMENT.contracts).join(",")}`);

  const blockNumber = await resolveAmmoraFinalizedHead([client], giwaSepoliaAutoRoute.finality);
  console.log(`finalizedHead=${blockNumber}`);
  await verifyAmmoraV4CoreAtBlock(client, {
    configRegistry: launch.configRegistry,
    launchFactory: launch.factory,
    graduationAdapter: launch.graduationAdapter,
    feePolicy: launch.feePolicy,
  }, blockNumber);
  console.log("core verification: OK");

  const feeVault = await client.readContract({
    address: launch.factory,
    abi: ammoraLaunchFactoryV4Abi,
    functionName: "feeVault",
    blockNumber,
  });
  console.log(`feeVault=${feeVault}`);

  const weth = DEPLOYMENT.contracts.tokens.wrappedNative;
  console.log(`catalog weth=${weth}`);

  // ---- Configs ----
  const nextId = await getAmmoraV4NextConfigId(client, launch.configRegistry, blockNumber);
  console.log(`nextConfigId=${nextId}`);
  const configs: AmmoraV4ConfigSnapshot[] = [];
  for (let id = 1n; id < nextId; id++) {
    const entry = await withRetry(
      () => getAmmoraV4ConfigAtBlock(client, launch.configRegistry, id, blockNumber),
      `getConfig ${id}`,
    );
    configs.push(entry);
  }

  // Qualification: enabled, concentrated (mode 0), WETH quote, not #6, and a
  // derived config (standard inputs) reconciles its graduation budget.
  const SALE_TOKENS = 1_000_000n;
  const THRESHOLD_WETH = 50_000_000_000_000_000n; // 0.05 WETH
  console.log("\n--- configs ---");
  for (const c of configs) {
    const cfg = c.config;
    const lockedBase =
      cfg.lockedBaseVesting.cliffUnlockAmount +
      cfg.lockedBaseVesting.amountPerPeriod * BigInt(cfg.lockedBaseVesting.numberOfPeriods);
    const saleSupply = SALE_TOKENS * 10n ** BigInt(cfg.tokenDecimals);
    let derived: { ok: boolean; reason: string; totalSupply?: bigint; migrationBase?: bigint; surplus?: bigint } = { ok: false, reason: "n/a" };
    if (cfg.migrationMode === 0) {
      try {
        const curve = buildSingleSegmentCurve(cfg.startSqrtPrice, saleSupply, THRESHOLD_WETH);
        const seg = curve[0];
        if (!seg) throw new Error("no segment");
        const range = {
          sqrtPriceX64: seg.upperSqrtPrice,
          sqrtMinPriceX64: seg.lowerSqrtPrice,
          sqrtMaxPriceX64: seg.upperSqrtPrice * 2n,
        };
        const quoteFee = THRESHOLD_WETH * BigInt(cfg.migrationQuoteFeeBps) / 10_000n;
        const quoteAfterFee = THRESHOLD_WETH - quoteFee;
        const dest = concentratedDepositQuote(range, { quoteAmount: quoteAfterFee });
        const surplus = quoteAfterFee - dest.quoteAmount;
        const totalSupply = saleSupply + dest.baseAmount + lockedBase;
        derived = {
          ok: surplus >= 0n && dest.baseAmount > 0n,
          reason: surplus >= 0n ? "budget reconciles" : "negative quote surplus",
          totalSupply,
          migrationBase: dest.baseAmount,
          surplus,
        };
      } catch (e) {
        derived = { ok: false, reason: `derive failed: ${String(e).slice(0, 120)}` };
      }
    } else {
      derived = { ok: false, reason: `migrationMode=${cfg.migrationMode} (not concentrated)` };
    }
    const blocked = c.configId === BLOCKED_CONFIG_ID;
    const qualified =
      !blocked && c.enabled && cfg.migrationMode === 0 && derived.ok &&
      cfg.quoteToken.toLowerCase() === weth.toLowerCase();
    console.log(
      `#${c.configId} enabled=${c.enabled} mode=${cfg.migrationMode} decimals=${cfg.tokenDecimals} ` +
      `quote=${cfg.quoteToken.slice(0, 10)}… totalSupply=${cfg.totalSupply} ` +
      `migQuoteThr=${cfg.migrationQuoteThreshold} migBaseThr=${cfg.migrationBaseThreshold} ` +
      `poolFee=${cfg.poolCreationFee} creatorShare=${cfg.creatorShareOfNonProtocolBps} ` +
      `lockedBase=${lockedBase} hash=${c.configHash.slice(0, 18)}… ` +
      `derivedTotal=${derived.totalSupply ?? "-"} derivedMigBase=${derived.migrationBase ?? "-"} ` +
      `surplus=${derived.surplus ?? "-"} | ${blocked ? "BLOCKED #6" : qualified ? "QUALIFIED ✓" : `not qualified (${derived.reason})`}`,
    );
  }

  // ---- Launch discovery ----
  console.log("\n--- launch discovery ---");
  const head = await client.getBlockNumber();
  const logs: { token: string; curve: string; creator: string; configId: bigint; blockNumber: bigint }[] = [];
  const CHUNK = 10_000n; // GIWA public RPC caps eth_getLogs at 10,000 blocks
  const ranges: { from: bigint; to: bigint }[] = [];
  for (let from = DEPLOYMENT.startBlock; from <= head; from += CHUNK) {
    ranges.push({ from, to: from + CHUNK - 1n > head ? head : from + CHUNK - 1n });
  }
  const workers = Array.from({ length: 4 }, async () => {
    while (ranges.length > 0) {
      const range = ranges.shift();
      if (!range) break;
      const chunk = await withRetry(
        () =>
          client.getContractEvents({
            abi: ammoraLaunchFactoryV4Abi,
            address: launch.factory,
            eventName: "LaunchCreated",
            fromBlock: range.from,
            toBlock: range.to,
          }),
        `logs ${range.from}-${range.to}`,
      );
      for (const l of chunk) {
        const a = l.args as { token: string; curve: string; creator: string; configId: bigint };
        logs.push({ token: a.token, curve: a.curve, creator: a.creator, configId: a.configId, blockNumber: l.blockNumber });
      }
      if (chunk.length > 0) console.log(`blocks ${range.from}-${range.to}: ${chunk.length} launches`);
    }
  });
  await Promise.all(workers);
  console.log(`total launches discovered: ${logs.length}`);
  const byConfig = new Map<string, number>();
  for (const l of logs) byConfig.set(l.configId.toString(), (byConfig.get(l.configId.toString()) ?? 0) + 1);
  console.log(`by config: ${[...byConfig.entries()].map(([k, v]) => `#${k}:${v}`).join(" ")}`);

  // Sample curve states (first 6 + last 6, deduped)
  const sample = [...logs.slice(0, 6), ...logs.slice(-6)];
  const seen = new Set<string>();
  console.log("\n--- sample curves ---");
  for (const l of sample) {
    if (seen.has(l.curve)) continue;
    seen.add(l.curve);
    try {
      const sdk = new AmmoraV4LaunchCurveClient(client, l.curve as `0x${string}`, {
        launchFactory: launch.factory,
        feePolicy: launch.feePolicy,
      });
      const state = await sdk.getStateAtBlock(blockNumber);
      const progress =
        state.migrationQuoteThreshold > 0n
          ? Number((state.quoteReserve * 10_000n) / state.migrationQuoteThreshold) / 100
          : 0;
      console.log(
        `${l.token.slice(0, 10)}… curve=${l.curve.slice(0, 10)}… config=#${l.configId} ` +
        `status=${state.status} baseReserve=${state.baseReserve} quoteReserve=${state.quoteReserve} ` +
        `threshold=${state.migrationQuoteThreshold} progress=${progress}% pool=${state.canonicalPool.slice(0, 10)}…`,
      );
      if (state.status === 1) {
        const quote = await sdk.quoteExactInputAtBlock(1_000_000_000_000_000n, false, blockNumber);
        console.log(`   quote buy 0.001 WETH -> out=${quote.amountOut} fee=${quote.fee} left=${quote.amountLeft}`);
      }
    } catch (e) {
      console.log(`${l.curve.slice(0, 10)}… read failed: ${String(e).slice(0, 140)}`);
    }
  }

  // FeeVault claimable smoke read (zero address beneficiary -> expect 0, proves the read path)
  if (weth) {
    const owed = await client.readContract({
      address: feeVault,
      abi: feeVaultAbi,
      functionName: "claimable",
      args: [weth as `0x${string}`, "0x0000000000000000000000000000000000000000"],
      blockNumber,
    });
    console.log(`\nfeeVault claimable(WETH, zero-address) = ${owed} (smoke read OK)`);
  }
  console.log("\nverify-reads done");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
