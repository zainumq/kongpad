/**
 * GIWA Sepolia (chain 91342) + Ammora auto-route V4 deployment wiring.
 * All addresses come from the SDK's reviewed deployment catalog — nothing is
 * hardcoded from memory. Testnet only.
 *
 * RPC: GIWA Sepolia has two public RPC endpoints — the official one and
 * the Flashblocks one (published in GIWA's docs; verified live 24 Nov
 * 2026: answers chain 91342, eth_call and eth_getLogs all work, head in
 * sync with the official RPC). The app tries them in order and retries
 * each read, and lets the visitor enter their own GIWA Sepolia RPC
 * (validated as chain 91342 before use) — so a blocked or down official
 * RPC never leaves the app with no way to read the chain.
 */
import { createPublicClient, defineChain, fallback, http, type PublicClient } from "viem";
import {
  giwaSepoliaAutoRoute,
  giwaSepoliaAutoRouteDeployment,
  resolveAmmoraFinalizedHead,
} from "@ammora-protocol/sdk";

/** The primary public GIWA Sepolia RPC. */
export const DEFAULT_RPC_URL = "https://sepolia-rpc.giwa.io";
/**
 * Second public GIWA Sepolia RPC (GIWA's Flashblocks endpoint, published in
 * GIWA's docs). Verified live 24 Nov 2026: eth_chainId 91342, eth_call and
 * eth_getLogs work, head in sync with the official RPC. Tried only after
 * the official endpoint fails, so normal reads stay on the canonical RPC.
 */
export const FALLBACK_RPC_URL = "https://sepolia-rpc-flashblocks.giwa.io";
/** Kept for existing imports; the effective list lives in getRpcUrls(). */
export const RPC_URL = DEFAULT_RPC_URL;
export const EXPLORER_URL = "https://sepolia-explorer.giwa.io";
export const CHAIN_ID = 91342;

export const DEPLOYMENT = giwaSepoliaAutoRouteDeployment;

export const GIWA_SEPOLIA = defineChain({
  id: DEPLOYMENT.chain.id,
  name: DEPLOYMENT.chain.name,
  nativeCurrency: DEPLOYMENT.chain.nativeCurrency,
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: {
    default: { name: "GIWA Sepolia Explorer", url: EXPLORER_URL },
  },
});

const launch = DEPLOYMENT.contracts.launch;
if (launch.protocolVersion !== 4) {
  throw new Error("Expected Ammora V4 launch deployment");
}

export const CORE = {
  configRegistry: launch.configRegistry,
  launchFactory: launch.factory,
  graduationAdapter: launch.graduationAdapter,
  feePolicy: launch.feePolicy,
  concentratedFactory: launch.concentratedFactory,
  concentratedPositionManager: launch.concentratedPositionManager,
} as const;

export const DEPLOYMENT_START_BLOCK = DEPLOYMENT.startBlock;

/** Wrapped native (WETH) on GIWA Sepolia, from the SDK deployment catalog. */
export const WETH = DEPLOYMENT.contracts.tokens.wrappedNative;

/**
 * Config #6 on this registry is quarantined by Ammora (see
 * docs.ammora.org/ai/launchpad-graduation-safety.md): it can sell all base
 * inventory and fail migration. It is blocked everywhere in this app — as a
 * template, as a direct launch Config, and in saved drafts.
 */
export const BLOCKED_CONFIG = {
  id: 6n,
  hash: "0x6048908774397e0691bb0e19f72dabb790eb0d892d6081d3622b39e7f738e667",
} as const;

export const isBlockedConfig = (configId: bigint, configHash?: string): boolean =>
  configId === BLOCKED_CONFIG.id ||
  (configHash !== undefined && configHash.toLowerCase() === BLOCKED_CONFIG.hash.toLowerCase());

// ---------------------------------------------------------------------------
// RPC configuration (custom endpoint support)
// ---------------------------------------------------------------------------

const CUSTOM_RPC_KEY = "kongpad:custom-rpc-url";

/** Visitor-supplied RPC endpoint, if one was saved and still looks valid. */
export function getCustomRpcUrl(): string | null {
  try {
    const raw = localStorage.getItem(CUSTOM_RPC_KEY);
    if (!raw) return null;
    const url = new URL(raw);
    if (url.protocol !== "https:") return null;
    return raw;
  } catch {
    return null;
  }
}

/** Effective RPC list: a validated custom endpoint first, then the two public endpoints in order. */
export function getRpcUrls(): string[] {
  const custom = getCustomRpcUrl();
  const urls = [DEFAULT_RPC_URL, FALLBACK_RPC_URL];
  if (custom && !urls.includes(custom)) return [custom, ...urls];
  return urls;
}

export function setCustomRpcUrl(url: string): void {
  try {
    localStorage.setItem(CUSTOM_RPC_KEY, url);
  } catch {
    // Storage unavailable — the setting is lost on reload.
  }
}

export function clearCustomRpcUrl(): void {
  try {
    localStorage.removeItem(CUSTOM_RPC_KEY);
  } catch {
    // ignore
  }
}

/** Check a candidate RPC answers as GIWA Sepolia (chain 91342) before trusting it. */
export async function validateRpcUrl(
  url: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: "Not a valid URL." };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, error: "Only https:// RPC URLs are accepted." };
  }
  try {
    const probe = createPublicClient({
      chain: GIWA_SEPOLIA,
      transport: http(url, { timeout: 15_000, retryCount: 0 }),
    });
    const chainId = await probe.getChainId();
    if (chainId !== CHAIN_ID) {
      return { ok: false, error: `This endpoint reports chain ${chainId}, not GIWA Sepolia (${CHAIN_ID}).` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message.split("\n")[0] : "RPC did not respond." };
  }
}

let publicClient: PublicClient | null = null;

/** Shared read-only client. Reads only — signing always goes through the user's wallet. */
export function getPublicClient(): PublicClient {
  if (!publicClient) {
    publicClient = createPublicClient({
      chain: GIWA_SEPOLIA,
      transport: fallback(
        getRpcUrls().map((url) => http(url, { retryCount: 3, retryDelay: 1000, timeout: 15_000 })),
        { rank: false },
      ),
    });
  }
  return publicClient;
}

/** Drop the cached client (e.g. after the RPC setting changes). Callers reload the page. */
export function resetPublicClient(): void {
  publicClient = null;
}

/** Reviewed confirmation-depth snapshot for quotes and tx planning. */
export async function getFinalizedBlock(client: PublicClient): Promise<bigint> {
  return resolveAmmoraFinalizedHead([client], giwaSepoliaAutoRoute.finality);
}

export const explorerTx = (hash: string): string => `${EXPLORER_URL}/tx/${hash}`;
export const explorerAddress = (address: string): string => `${EXPLORER_URL}/address/${address}`;

export const shortAddress = (address: string): string =>
  address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
