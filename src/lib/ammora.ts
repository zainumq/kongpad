/**
 * Ammora SDK operations for KongPad: reads, quotes, plans and wallet sends.
 * Every write is simulated before signing, uses exact (not unlimited)
 * approvals, and is reconciled against its confirmed receipt.
 */
import {
  ammConcentratedPoolV3Abi,
  ammConcentratedPositionManagerV3Abi,
  AmmoraSwapClient,
  AmmoraV4LaunchCurveClient,
  ammoraLaunchFactoryV4Abi,
  ammoraLaunchPoolV4Abi,
  AMMORA_FEE_POLICY_VERSION,
  buildClaimFeeVaultFor,
  buildCreateAmmoraV4Launch,
  classifyAmmoraV4ExactInputFill,
  createAmmoraDeploymentSource,
  DammV2Client,
  feeVaultAbi,
  getAmmoraV4ConfigAtBlock,
  getAmmoraV4NextConfigId,
  giwaSepoliaAutoRoutePoolProfiles,
  parseAmmoraV4LaunchCreatedReceipt,
  parseAmmoraV4MigratedReceipt,
  parseAmmoraV4SwapReceipt,
  planERC20Approvals,
  PreparedExactInputSwap,
  verifyAmmoraV4CoreAtBlock,
  type AmmoraV4ConfigSnapshot,
  type AmmoraV4ExactInputQuote,
  type AmmoraV4LaunchCurveState,
} from "@ammora-protocol/sdk";
import {
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  zeroAddress,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import {
  CORE,
  DEPLOYMENT,
  DEPLOYMENT_START_BLOCK,
  WETH,
  getFinalizedBlock,
} from "./giwa";
import {
  WALLET_FLOW_TIMEOUT_MS,
  WALLET_REQUEST_TIMEOUT_MS,
  classifyWalletError,
  withWalletTimeout,
} from "./walletError";

export type { AmmoraV4ConfigSnapshot, AmmoraV4LaunchCurveState, AmmoraV4ExactInputQuote };
// Re-exported so components keep a single import site for wallet errors.
export {
  WALLET_FLOW_TIMEOUT_MS,
  WALLET_REQUEST_TIMEOUT_MS,
  WalletTimeoutError,
  classifyWalletError,
  describeWalletError,
  withWalletTimeout,
} from "./walletError";
export type { ClassifiedWalletError, WalletErrorKind } from "./walletError";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Plain-message form of {@link classifyWalletError}, for read paths and
 * components without a retry UI. A rejection is only reported as one when
 * the EIP-1193 code 4001 is present — a hung request that never showed a
 * popup must not be relabelled as a rejection.
 */
export function describeError(error: unknown): string {
  return classifyWalletError(error).message;
}

/** Retry a read through transient RPC trouble. Reverts are answers, not retried here. */
export async function readWithRetry<T>(read: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await read();
    } catch (e) {
      last = e;
      if (i < attempts - 1) await sleep(600 * (i + 1));
    }
  }
  throw last;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getFeeVault(client: PublicClient, blockNumber?: bigint): Promise<Address> {
  return readWithRetry(() =>
    client.readContract({
      address: CORE.launchFactory,
      abi: ammoraLaunchFactoryV4Abi,
      functionName: "feeVault",
      blockNumber,
    }),
  );
}

export async function listConfigs(
  client: PublicClient,
  blockNumber: bigint,
): Promise<{ configs: AmmoraV4ConfigSnapshot[]; nextId: bigint }> {
  const nextId = await getAmmoraV4NextConfigId(client, CORE.configRegistry, blockNumber);
  const configs: AmmoraV4ConfigSnapshot[] = [];
  for (let id = 1n; id < nextId; id++) {
    configs.push(
      await readWithRetry(() =>
        getAmmoraV4ConfigAtBlock(client, CORE.configRegistry, id, blockNumber),
      ),
    );
  }
  return { configs, nextId };
}

export async function getConfig(
  client: PublicClient,
  configId: bigint,
  blockNumber: bigint,
): Promise<AmmoraV4ConfigSnapshot> {
  return getAmmoraV4ConfigAtBlock(client, CORE.configRegistry, configId, blockNumber);
}

export type LaunchRecord = {
  token: Address;
  curve: Address;
  creator: Address;
  configId: bigint;
  configHash: Hex;
  metadataURI: string;
  blockNumber: bigint;
  txHash: Hash;
};

/** GIWA public RPC caps eth_getLogs at 10,000 blocks per request (verified live). */
const LOG_CHUNK = 10_000n;
const LOG_WORKERS = 4;

/** Discover all launches from factory LaunchCreated logs, chunked for public RPCs. */
export async function discoverLaunches(
  client: PublicClient,
  fromBlock: bigint,
  onProgress?: (scannedTo: bigint, head: bigint, found: number) => void,
): Promise<{ launches: LaunchRecord[]; scannedTo: bigint }> {
  const head = await client.getBlockNumber();
  const launches: LaunchRecord[] = [];
  const ranges: { from: bigint; to: bigint }[] = [];
  for (let from = fromBlock; from <= head; from += LOG_CHUNK) {
    ranges.push({ from, to: from + LOG_CHUNK - 1n > head ? head : from + LOG_CHUNK - 1n });
  }
  let scanned = 0;
  const workers = Array.from({ length: LOG_WORKERS }, async () => {
    while (ranges.length > 0) {
      const range = ranges.shift();
      if (!range) break;
      const events = await readWithRetry(() =>
        client.getContractEvents({
          abi: ammoraLaunchFactoryV4Abi,
          address: CORE.launchFactory,
          eventName: "LaunchCreated",
          fromBlock: range.from,
          toBlock: range.to,
        }),
      );
      for (const e of events) {
        const a = e.args as {
          token: Address;
          curve: Address;
          creator: Address;
          configId: bigint;
          configHash: Hex;
          metadataURI: string;
        };
        launches.push({
          token: a.token,
          curve: a.curve,
          creator: a.creator,
          configId: a.configId,
          configHash: a.configHash,
          metadataURI: a.metadataURI,
          blockNumber: e.blockNumber,
          txHash: e.transactionHash,
        });
      }
      scanned += 1;
      onProgress?.(range.to, head, launches.length);
    }
  });
  await Promise.all(workers);
  void scanned;
  return { launches, scannedTo: head };
}

export function curveClient(client: PublicClient, curve: Address): AmmoraV4LaunchCurveClient {
  return new AmmoraV4LaunchCurveClient(client, curve, {
    launchFactory: CORE.launchFactory,
    feePolicy: CORE.feePolicy,
  });
}

export async function getCurveState(
  client: PublicClient,
  curve: Address,
  blockNumber: bigint,
): Promise<AmmoraV4LaunchCurveState> {
  const sdk = curveClient(client, curve);
  const state = await sdk.getStateAtBlock(blockNumber);
  // Bind the curve to the reviewed factory before displaying it.
  const factoryToken = await client.readContract({
    address: CORE.launchFactory,
    abi: ammoraLaunchFactoryV4Abi,
    functionName: "tokenForCurve",
    args: [curve],
    blockNumber,
  });
  if (
    factoryToken === zeroAddress ||
    factoryToken.toLowerCase() !== state.baseToken.toLowerCase() ||
    state.feePolicy.toLowerCase() !== CORE.feePolicy.toLowerCase() ||
    state.feePolicyVersion !== AMMORA_FEE_POLICY_VERSION
  ) {
    throw new Error("Curve is not bound to the reviewed V4 factory and fee policy");
  }
  return state;
}

export type TokenMeta = { name: string; symbol: string; decimals: number };

export async function getTokenMeta(client: PublicClient, token: Address): Promise<TokenMeta> {
  const [name, symbol, decimals] = await Promise.all([
    client.readContract({ address: token, abi: erc20Abi, functionName: "name" }).catch(() => "Unknown"),
    client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }).catch(() => "???"),
    client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }).catch(() => 18),
  ]);
  return { name: String(name), symbol: String(symbol), decimals: Number(decimals) };
}

export async function getBalance(
  client: PublicClient,
  token: Address,
  owner: Address,
): Promise<bigint> {
  return client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
}

export async function quoteCurve(
  client: PublicClient,
  curve: Address,
  amountIn: bigint,
  baseForQuote: boolean,
  blockNumber: bigint,
): Promise<{
  state: AmmoraV4LaunchCurveState;
  quote: AmmoraV4ExactInputQuote;
  fill: ReturnType<typeof classifyAmmoraV4ExactInputFill>;
}> {
  const sdk = curveClient(client, curve);
  const state = await sdk.getStateAtBlock(blockNumber);
  if (state.status !== 1) throw new Error(`Curve status ${state.status} is not active`);
  const quote = await sdk.quoteExactInputAtBlock(amountIn, baseForQuote, blockNumber);
  return { state, quote, fill: classifyAmmoraV4ExactInputFill(quote, baseForQuote) };
}

// ---------------------------------------------------------------------------
// Sends (simulate -> sign -> confirm -> reconcile)
// ---------------------------------------------------------------------------

export type TxRequest = { to: Address; data: Hex; value?: bigint };

export async function simulateTx(
  client: PublicClient,
  account: Address,
  tx: TxRequest,
): Promise<void> {
  await client.call({ account, to: tx.to, data: tx.data, value: tx.value });
}

export async function sendTx(
  wallet: WalletClient,
  client: PublicClient,
  account: Address,
  tx: TxRequest,
  label: string,
): Promise<Hash> {
  const latestNonce = await client.getTransactionCount({ address: account, blockTag: "latest" });
  const pendingNonce = await client.getTransactionCount({ address: account, blockTag: "pending" });
  if (latestNonce !== pendingNonce) {
    throw new Error(`You have a pending transaction (nonce ${latestNonce}). Wait for it to confirm before sending ${label}.`);
  }
  await simulateTx(client, account, tx);
  // The wallet signature request is the hang-prone step (a popup that never
  // appears used to hang forever). Fail visibly after the timeout instead;
  // the retry hint tells the user to check MetaMask's queue first, because
  // timing out cannot cancel a request already queued in the wallet.
  const hash = await withWalletTimeout(
    wallet.sendTransaction({
      account,
      chain: wallet.chain,
      to: tx.to,
      data: tx.data,
      ...(tx.value !== undefined ? { value: tx.value } : {}),
    }),
    WALLET_REQUEST_TIMEOUT_MS,
  );
  let receipt;
  try {
    receipt = await client.waitForTransactionReceipt({
      hash,
      timeout: 120_000,
      pollingInterval: 4_000,
    });
  } catch {
    // Keep the hash: the transaction may still confirm, and retrying
    // blindly could double-send. The nonce guard above also protects the
    // next send while this one is pending.
    throw new Error(
      `Submitted (tx ${hash}) but no confirmation within 120s. Check the explorer before retrying — the transaction may still confirm.`,
    );
  }
  if (receipt.status !== "success") throw new Error(`${label} reverted (tx ${hash})`);
  return hash;
}

/** Grant exactly the approval a plan needs, verified at the receipt block. */
export async function ensureApprovals(
  wallet: WalletClient,
  client: PublicClient,
  account: Address,
  requirements: { token: Address; spender: Address; amount: bigint }[],
  onApproval?: (token: Address, hash: Hash) => void,
): Promise<void> {
  const plans = await planERC20Approvals(client, account, requirements);
  for (const plan of plans) {
    for (const tx of plan.transactions) {
      const hash = await sendTx(wallet, client, account, { to: tx.to, data: tx.data }, "ERC-20 approval");
      onApproval?.(plan.requirement.token, hash);
    }
    if (plan.transactions.length > 0) {
      const allowance = await client.readContract({
        address: plan.requirement.token,
        abi: erc20Abi,
        functionName: "allowance",
        args: [account, plan.requirement.spender],
      });
      if (allowance < plan.requirement.amount) {
        throw new Error("Approval confirmed but allowance is still below the required amount");
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Curve swaps (pre-graduation, model `dbc`)
// ---------------------------------------------------------------------------

export type CurveSwapPlan = {
  state: AmmoraV4LaunchCurveState;
  quote: AmmoraV4ExactInputQuote & { minimumAmountOut: bigint };
  fill: ReturnType<typeof classifyAmmoraV4ExactInputFill>;
  baseForQuote: boolean;
  tokenOut: Address;
  transaction: TxRequest;
  approvalRequirements: { token: Address; spender: Address; amount: bigint }[];
  quoteBlockNumber: bigint;
};

export async function planCurveSwap(
  client: PublicClient,
  curve: Address,
  tokenIn: Address,
  amountIn: bigint,
  recipient: Address,
  slippageBps: number,
  graduationBoundary = false,
): Promise<CurveSwapPlan> {
  if (amountIn <= 0n || slippageBps < 0 || slippageBps > 1000) {
    throw new Error("Positive input and slippage 0–1000 bps required");
  }
  const blockNumber = await getFinalizedBlock(client);
  await verifyAmmoraV4CoreAtBlock(client, CORE, blockNumber);
  const sdk = curveClient(client, curve);
  const state = await sdk.getStateAtBlock(blockNumber);
  const factoryToken = await client.readContract({
    address: CORE.launchFactory,
    abi: ammoraLaunchFactoryV4Abi,
    functionName: "tokenForCurve",
    args: [curve],
    blockNumber,
  });
  if (
    factoryToken === zeroAddress ||
    factoryToken.toLowerCase() !== state.baseToken.toLowerCase() ||
    state.feePolicy.toLowerCase() !== CORE.feePolicy.toLowerCase() ||
    state.feePolicyVersion !== AMMORA_FEE_POLICY_VERSION
  ) {
    throw new Error("Curve is not bound to the reviewed V4 factory and fee policy");
  }
  if (state.status !== 1) throw new Error(`Curve status ${state.status} is not active`);
  const baseForQuote = tokenIn.toLowerCase() === state.baseToken.toLowerCase();
  if (!baseForQuote && tokenIn.toLowerCase() !== state.quoteToken.toLowerCase()) {
    throw new Error("tokenIn is not a curve asset");
  }
  const quote = await sdk.quoteExactInputAtBlock(amountIn, baseForQuote, blockNumber);
  const fill = classifyAmmoraV4ExactInputFill(quote, baseForQuote);
  if (graduationBoundary ? fill.kind !== "graduation-boundary" : fill.kind !== "full") {
    throw new Error(
      `Unexpected ${fill.kind}; ordinary orders must fill in full and graduation buys must reach the boundary`,
    );
  }
  const minimumAmountOut = (quote.amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
  if (minimumAmountOut === 0n) throw new Error("Minimum output rounds to zero");
  const block = await client.getBlock({ blockNumber });
  const deadline = block.timestamp + 20n * 60n;
  return {
    state,
    quote: { ...quote, minimumAmountOut },
    fill,
    baseForQuote,
    tokenOut: baseForQuote ? state.quoteToken : state.baseToken,
    transaction: {
      to: curve,
      data: encodeFunctionData({
        abi: ammoraLaunchPoolV4Abi,
        functionName: "swapExactInput",
        args: [amountIn, minimumAmountOut, baseForQuote, graduationBoundary, recipient, deadline],
      }),
    },
    approvalRequirements: [{ token: tokenIn, spender: curve, amount: amountIn }],
    quoteBlockNumber: blockNumber,
  };
}

export async function executeCurveSwap(
  wallet: WalletClient,
  client: PublicClient,
  account: Address,
  plan: CurveSwapPlan,
  amountIn: bigint,
  onStatus?: (status: string) => void,
): Promise<{ hash: Hash; amountReceived: bigint; consumedAmountIn: bigint; amountLeft: bigint }> {
  onStatus?.("Checking approval…");
  await ensureApprovals(wallet, client, account, plan.approvalRequirements);
  onStatus?.("Waiting for wallet signature…");
  const hash = await sendTx(wallet, client, account, plan.transaction, "Curve swap");
  const receipt = await client.getTransactionReceipt({ hash });
  const confirmed = parseAmmoraV4SwapReceipt(receipt, plan.transaction.to, {
    trader: account,
    recipient: account,
    baseForQuote: plan.baseForQuote,
    requestedAmountIn: amountIn,
    minimumAmountOut: plan.quote.minimumAmountOut,
  });
  return {
    hash,
    amountReceived: confirmed.amountOut,
    consumedAmountIn: confirmed.consumedAmountIn,
    amountLeft: confirmed.amountLeft,
  };
}

// ---------------------------------------------------------------------------
// Post-graduation pool swaps (model `concentrated`)
// ---------------------------------------------------------------------------

export async function executePoolSwap(
  wallet: WalletClient,
  client: PublicClient,
  account: Address,
  pool: Address,
  tokenIn: Address,
  amountIn: bigint,
  slippageBps: number,
  onStatus?: (status: string) => void,
): Promise<{ hash: Hash; amountReceived: bigint }> {
  const swaps = await AmmoraSwapClient.create(client, {
    deploymentCatalog: { [DEPLOYMENT.chain.id]: DEPLOYMENT },
    factoryProfiles: giwaSepoliaAutoRoutePoolProfiles,
  });
  const prepared = await PreparedExactInputSwap.create({
    client,
    chainId: DEPLOYMENT.chain.id,
    payer: account,
    quoteTtlMs: 30_000,
    createPlan: async () => {
      const quoteBlockNumber = await getFinalizedBlock(client);
      const planned = await swaps.prepareExactIn({
        model: "concentrated",
        pool,
        tokenIn,
        inputAsset: "erc20",
        amountIn,
        payer: account,
        recipient: account,
        slippageBps,
        executionMode: "direct-wallet",
        quoteBlockNumber,
      });
      return {
        transaction: planned.transaction,
        approvalRequirements: planned.approvalRequirements,
        quoteBlockNumber: planned.quote.quoteBlockNumber,
        quote: planned.quote,
      };
    },
  });
  onStatus?.("Waiting for wallet signature…");
  // The SDK's execute runs approvals + swap + receipt waits as one flow;
  // give the whole flow a generous budget so a hung wallet request still
  // fails visibly instead of hanging forever.
  const result = await withWalletTimeout(
    prepared.execute(wallet, {
      onStatus: (s) => onStatus?.(String((s as { type?: string }).type ?? "working")),
    }),
    WALLET_FLOW_TIMEOUT_MS,
  );
  if (result.amountReceived === null) {
    throw new Error("Swap succeeded but receipt-block output reconciliation was unavailable");
  }
  return { hash: result.hash, amountReceived: result.amountReceived };
}

// ---------------------------------------------------------------------------
// Token creation
// ---------------------------------------------------------------------------

export function buildLaunchTx(args: {
  name: string;
  symbol: string;
  metadataURI: string;
  tokenDecimals: number;
  configId: bigint;
  poolCreationFee: bigint;
}): TxRequest {
  const built = buildCreateAmmoraV4Launch(
    {
      name: args.name,
      symbol: args.symbol,
      metadataURI: args.metadataURI,
      creatorMetadataURI: args.metadataURI,
      tokenDecimals: args.tokenDecimals,
    },
    args.configId,
    args.poolCreationFee,
  );
  return { to: CORE.launchFactory, data: built.data, value: built.value };
}

export async function executeCreateLaunch(
  wallet: WalletClient,
  client: PublicClient,
  account: Address,
  tx: TxRequest,
  configId: bigint,
  configHash: Hex,
): Promise<{ hash: Hash; token: Address; curve: Address }> {
  const hash = await sendTx(wallet, client, account, tx, "Create token");
  const receipt = await client.getTransactionReceipt({ hash });
  const created = parseAmmoraV4LaunchCreatedReceipt(receipt, CORE.launchFactory);
  if (created.configId !== configId || created.configHash !== configHash) {
    throw new Error("Launch receipt does not match the selected Config");
  }
  return { hash, token: created.token, curve: created.curve };
}

// ---------------------------------------------------------------------------
// Graduation (final fill + separate migration)
// ---------------------------------------------------------------------------

export async function planMigration(
  client: PublicClient,
  curve: Address,
): Promise<{ transaction: TxRequest; blockNumber: bigint }> {
  const blockNumber = await getFinalizedBlock(client);
  const sdk = curveClient(client, curve);
  const state = await sdk.getStateAtBlock(blockNumber);
  if (state.status === 3) throw new Error(`Already graduated to ${state.canonicalPool}`);
  if (state.status !== 2) throw new Error(`Curve status ${state.status} is not ReadyToMigrate`);
  const migration = await sdk.planMigrateAtBlock(blockNumber);
  return { transaction: migration.transaction as TxRequest, blockNumber };
}

export async function executeMigration(
  wallet: WalletClient,
  client: PublicClient,
  account: Address,
  curve: Address,
): Promise<{ hash: Hash; canonicalPool: Address }> {
  const { transaction } = await planMigration(client, curve);
  await simulateTx(client, account, transaction);
  const hash = await sendTx(wallet, client, account, transaction, "Migrate to ARL pool");
  const receipt = await client.getTransactionReceipt({ hash });
  const graduated = parseAmmoraV4MigratedReceipt(receipt, curve);
  return { hash, canonicalPool: graduated.canonicalPool };
}

// ---------------------------------------------------------------------------
// FeeVault (Creator / Partner launch fees)
// ---------------------------------------------------------------------------

export async function getLaunchFeeClaimable(
  client: PublicClient,
  feeVault: Address,
  feeToken: Address,
  beneficiary: Address,
  blockNumber?: bigint,
): Promise<bigint> {
  return client.readContract({
    address: feeVault,
    abi: feeVaultAbi,
    functionName: "claimable",
    args: [feeToken, beneficiary],
    blockNumber,
  });
}

export async function claimLaunchFees(
  wallet: WalletClient,
  client: PublicClient,
  account: Address,
  feeVault: Address,
  feeToken: Address,
  payout: Address,
): Promise<Hash> {
  const owed = await getLaunchFeeClaimable(client, feeVault, feeToken, account);
  if (owed === 0n) throw new Error("Nothing owed for this fee token — no transaction sent.");
  const built = buildClaimFeeVaultFor(feeToken, account, payout);
  return sendTx(wallet, client, account, { to: feeVault, data: built.data }, "Claim launch fees");
}

// ---------------------------------------------------------------------------
// LP positions (ARL concentrated NFTs) + fee delegation
// ---------------------------------------------------------------------------

const erc721TransferAbi = [
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { indexed: true, name: "from", type: "address" },
      { indexed: true, name: "to", type: "address" },
      { indexed: true, name: "tokenId", type: "uint256" },
    ],
  },
] as const;

export type LpPosition = {
  tokenId: bigint;
  pool: Address;
  baseToken: Address;
  quoteToken: Address;
  baseSymbol: string;
  quoteSymbol: string;
  baseDecimals: number;
  quoteDecimals: number;
  unlockedLiquidity: bigint;
  permanentLockedLiquidity: bigint;
  vestedLiquidity: bigint;
  claimableBase: bigint | null;
  claimableQuote: bigint | null;
  delegate: Address;
  permission: number;
};

function dammClient(client: PublicClient, pool: Address): DammV2Client {
  return new DammV2Client(client, pool, "concentrated", CORE.concentratedFactory, CORE.concentratedPositionManager, {
    deploymentSource: createAmmoraDeploymentSource([DEPLOYMENT]),
    factoryProfiles: giwaSepoliaAutoRoutePoolProfiles,
  });
}

export async function getUserLpPositions(
  client: PublicClient,
  owner: Address,
): Promise<LpPosition[]> {
  const manager = CORE.concentratedPositionManager;
  const head = await client.getBlockNumber();
  const received = new Set<bigint>();
  const ranges: { from: bigint; to: bigint }[] = [];
  for (let from = DEPLOYMENT_START_BLOCK; from <= head; from += LOG_CHUNK) {
    ranges.push({ from, to: from + LOG_CHUNK - 1n > head ? head : from + LOG_CHUNK - 1n });
  }
  const workers = Array.from({ length: LOG_WORKERS }, async () => {
    while (ranges.length > 0) {
      const range = ranges.shift();
      if (!range) break;
      const logs = await readWithRetry(() =>
        client.getContractEvents({
          abi: erc721TransferAbi,
          address: manager,
          eventName: "Transfer",
          args: { to: owner },
          fromBlock: range.from,
          toBlock: range.to,
        }),
      );
      for (const log of logs) {
        const tokenId = (log.args as { tokenId?: bigint }).tokenId;
        if (tokenId !== undefined) received.add(tokenId);
      }
    }
  });
  await Promise.all(workers);
  const positions: LpPosition[] = [];
  for (const tokenId of [...received].sort((a, b) => (a < b ? -1 : 1))) {
    const current = await client
      .readContract({
        abi: ammConcentratedPositionManagerV3Abi,
        address: manager,
        functionName: "ownerOf",
        args: [tokenId],
        blockNumber: head,
      })
      .catch(() => null);
    if (current === null || (current as string).toLowerCase() !== owner.toLowerCase()) continue;
    const position = (await client.readContract({
      abi: ammConcentratedPositionManagerV3Abi,
      address: manager,
      functionName: "getPosition",
      args: [tokenId],
      blockNumber: head,
    })) as {
      pool: Address;
      unlockedLiquidity: bigint;
      permanentLockedLiquidity: bigint;
      vestedLiquidity: bigint;
    };
    const [baseToken, quoteToken] = (await Promise.all([
      client.readContract({ abi: ammConcentratedPoolV3Abi, address: position.pool, functionName: "baseToken", blockNumber: head }),
      client.readContract({ abi: ammConcentratedPoolV3Abi, address: position.pool, functionName: "quoteToken", blockNumber: head }),
    ])) as [Address, Address];
    const [baseMeta, quoteMeta] = await Promise.all([
      getTokenMeta(client, baseToken),
      getTokenMeta(client, quoteToken),
    ]);
    const owed = await client
      .simulateContract({
        abi: ammConcentratedPositionManagerV3Abi,
        account: owner,
        address: manager,
        functionName: "claimPositionFees",
        args: [tokenId, owner],
        blockNumber: head,
      })
      .then(({ result }) => result as readonly [bigint, bigint])
      .catch(() => null);
    const [delegate, permission] = await Promise.all([
      client.readContract({
        abi: ammConcentratedPositionManagerV3Abi,
        address: manager,
        functionName: "positionDelegate",
        args: [tokenId],
        blockNumber: head,
      }),
      client.readContract({
        abi: ammConcentratedPositionManagerV3Abi,
        address: manager,
        functionName: "delegatePermission",
        args: [tokenId],
        blockNumber: head,
      }),
    ]);
    positions.push({
      tokenId,
      pool: position.pool,
      baseToken,
      quoteToken,
      baseSymbol: baseMeta.symbol,
      quoteSymbol: quoteMeta.symbol,
      baseDecimals: baseMeta.decimals,
      quoteDecimals: quoteMeta.decimals,
      unlockedLiquidity: position.unlockedLiquidity,
      permanentLockedLiquidity: position.permanentLockedLiquidity,
      vestedLiquidity: position.vestedLiquidity,
      claimableBase: owed ? owed[0] : null,
      claimableQuote: owed ? owed[1] : null,
      delegate: delegate as Address,
      permission: Number(permission),
    });
  }
  return positions;
}

export async function claimLpFees(
  wallet: WalletClient,
  client: PublicClient,
  account: Address,
  pool: Address,
  tokenId: bigint,
  payout: Address,
): Promise<Hash> {
  const sdk = dammClient(client, pool);
  const tx = await sdk.planClaimManagedConcentratedFees(tokenId, payout, account);
  return sendTx(wallet, client, account, tx as TxRequest, "Claim LP fees");
}

/** permission: 8 = claim-fee (delegate may choose payout), 16 = claim-fee-to-owner, 0 = revoke. */
export async function updateFeeDelegate(
  wallet: WalletClient,
  client: PublicClient,
  account: Address,
  pool: Address,
  tokenId: bigint,
  delegate: Address,
  permission: number,
): Promise<Hash> {
  const sdk = dammClient(client, pool);
  const tx = await sdk.planUpdateDelegatePermission(tokenId, delegate, permission, account);
  const hash = await sendTx(wallet, client, account, tx as TxRequest, "Update fee delegate");
  const receipt = await client.getTransactionReceipt({ hash });
  const manager = CORE.concentratedPositionManager;
  const actualDelegate = await client.readContract({
    address: manager,
    abi: ammConcentratedPositionManagerV3Abi,
    functionName: "positionDelegate",
    args: [tokenId],
    blockNumber: receipt.blockNumber,
  });
  const actualPermission = await client.readContract({
    address: manager,
    abi: ammConcentratedPositionManagerV3Abi,
    functionName: "delegatePermission",
    args: [tokenId],
    blockNumber: receipt.blockNumber,
  });
  if (
    (actualDelegate as string).toLowerCase() !== delegate.toLowerCase() ||
    Number(actualPermission) !== permission
  ) {
    throw new Error("Confirmed delegation differs from the requested state — reconcile the receipt before continuing");
  }
  return hash;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

export const fmt = (value: bigint, decimals: number, maxDp = 6): string => {
  const s = formatUnits(value, decimals);
  const [int, frac = ""] = s.split(".");
  if (frac.length === 0) return int ?? "0";
  return `${int}.${frac.slice(0, maxDp)}`.replace(/\.?0+$/, "") || "0";
};

export const WETH_ADDRESS: Address = WETH;
