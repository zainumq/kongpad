/**
 * Launchpad Config authoring: derive a new immutable Config from a reviewed
 * template, qualify it against the graduation-readiness invariants, and create
 * it on-chain. Follows the documented team path (recipients + supply +
 * threshold); the remaining economics are derived, never hand-typed.
 *
 * Readiness invariants (docs.ammora.org/ai/launchpad-graduation-safety.md):
 *   totalSupply >= worstCaseCurveBaseSold + grossMigrationBaseRequired + lockedBaseTotal
 *   quoteReserveAfterSurplusAndMigrationFees >= grossMigrationQuoteRequired
 * For migrationBaseThreshold = 0, grossMigrationBaseRequired is the DERIVED
 * destination amount, never zero.
 */
import {
  AmmoraV4MigrationMode,
  assertAmmoraV4Config,
  buildCreateAmmoraV4Config,
  parseAmmoraV4ConfigCreatedReceipt,
  type AmmoraV4Config,
  type AmmoraV4ConfigSnapshot,
  type AmmoraV4Segment,
} from "@ammora-protocol/sdk";
import { buildSingleSegmentCurve, concentratedDepositQuote } from "@ammora-protocol/math";
import { encodeAbiParameters, keccak256, type Address, type Hash, type Hex, type PublicClient, type WalletClient } from "viem";
import { BLOCKED_CONFIG, CORE, WETH, isBlockedConfig } from "./giwa";
import { sendTx, type TxRequest } from "./ammora";

export type TeamRecipients = {
  configOwner: Address;
  partnerRecipient: Address;
  liquidityPartner: Address;
  leftoverReceiver: Address;
};

export type DerivedConfig = {
  config: AmmoraV4Config;
  curve: readonly AmmoraV4Segment[];
  economics: {
    saleAllocationRaw: bigint;
    grossMigrationBaseRaw: bigint;
    grossMigrationQuoteRaw: bigint;
    migrationQuoteFeeRaw: bigint;
    quoteSurplusToProtocolRaw: bigint;
    lockedBaseRaw: bigint;
    totalSupplyRaw: bigint;
  };
};

export const lockedBaseOf = (config: AmmoraV4Config): bigint =>
  config.lockedBaseVesting.cliffUnlockAmount +
  config.lockedBaseVesting.amountPerPeriod * BigInt(config.lockedBaseVesting.numberOfPeriods);

/**
 * Derive a complete Config from a template. The derived totalSupply reserves
 * the sale allocation, the migration destination base and the locked base, so
 * invariant 1 holds by construction — verified again by qualifyDerived().
 */
export function deriveConfigFromTemplate(
  template: Pick<AmmoraV4ConfigSnapshot, "config">,
  saleSupply: bigint,
  migrationQuoteThreshold: bigint,
): DerivedConfig {
  if (saleSupply <= 0n || migrationQuoteThreshold <= 0n) {
    throw new RangeError("Sale supply and quote threshold must be positive");
  }
  if (template.config.migrationMode !== AmmoraV4MigrationMode.Concentrated) {
    throw new RangeError("Only concentrated graduation is supported by this derivation");
  }
  const curve = buildSingleSegmentCurve(template.config.startSqrtPrice, saleSupply, migrationQuoteThreshold);
  const segment = curve[0];
  if (!segment) throw new Error("Single-segment curve construction returned no segment");
  const range = {
    sqrtPriceX64: segment.upperSqrtPrice,
    sqrtMinPriceX64: segment.lowerSqrtPrice,
    sqrtMaxPriceX64: segment.upperSqrtPrice * 2n,
  };
  const quoteFee = (migrationQuoteThreshold * BigInt(template.config.migrationQuoteFeeBps)) / 10_000n;
  const quoteAfterFee = migrationQuoteThreshold - quoteFee;
  const destination = concentratedDepositQuote(range, { quoteAmount: quoteAfterFee });
  const lockedBase = lockedBaseOf(template.config);
  const config: AmmoraV4Config = {
    ...template.config,
    totalSupply: saleSupply + destination.baseAmount + lockedBase,
    migrationQuoteThreshold,
    migrationBaseThreshold: destination.baseAmount,
    postMigrationSqrtMinPrice: range.sqrtMinPriceX64,
    postMigrationSqrtMaxPrice: range.sqrtMaxPriceX64,
    postMigrationLiquidity: destination.liquidity,
  };
  assertAmmoraV4Config(config, curve);
  return {
    config,
    curve,
    economics: {
      saleAllocationRaw: saleSupply,
      grossMigrationBaseRaw: destination.baseAmount,
      grossMigrationQuoteRaw: destination.quoteAmount,
      migrationQuoteFeeRaw: quoteFee,
      quoteSurplusToProtocolRaw: quoteAfterFee - destination.quoteAmount,
      lockedBaseRaw: lockedBase,
      totalSupplyRaw: config.totalSupply,
    },
  };
}

export type Qualification = {
  qualified: boolean;
  reasons: string[];
  derived: DerivedConfig | null;
};

/** Standard testnet economics used for the qualification probe. */
export const STANDARD_SALE_TOKENS = 1_000_000n;
export const STANDARD_THRESHOLD_WETH = 50_000_000_000_000_000n; // 0.05 WETH

/** Qualify a template Config for deriving new launchpad Configs. */
export function qualifyTemplate(snapshot: AmmoraV4ConfigSnapshot): Qualification {
  const reasons: string[] = [];
  const cfg = snapshot.config;
  if (isBlockedConfig(snapshot.configId, snapshot.configHash)) {
    reasons.push(`Config #${snapshot.configId} is quarantined by Ammora (Config #6 incident)`);
    return { qualified: false, reasons, derived: null };
  }
  if (!snapshot.enabled) reasons.push("Template Config is disabled");
  if (cfg.migrationMode !== AmmoraV4MigrationMode.Concentrated) {
    reasons.push(`Migration mode is ${cfg.migrationMode}, not concentrated`);
  }
  if (cfg.quoteToken.toLowerCase() !== WETH.toLowerCase()) {
    reasons.push("Quote token is not WETH");
  }
  if (cfg.tokenDecimals < 6 || cfg.tokenDecimals > 9) {
    reasons.push(`Token decimals ${cfg.tokenDecimals} outside 6–9`);
  }
  let derived: DerivedConfig | null = null;
  if (reasons.length === 0) {
    try {
      const saleSupply = STANDARD_SALE_TOKENS * 10n ** BigInt(cfg.tokenDecimals);
      derived = deriveConfigFromTemplate(snapshot, saleSupply, STANDARD_THRESHOLD_WETH);
      const e = derived.economics;
      // Invariant 1: totalSupply covers sale + migration base + locked base.
      if (e.totalSupplyRaw < e.saleAllocationRaw + e.grossMigrationBaseRaw + e.lockedBaseRaw) {
        reasons.push("Derived totalSupply does not reserve migration + locked base");
      }
      // Invariant 2: post-fee quote covers the migration destination quote.
      if (e.quoteSurplusToProtocolRaw < 0n) {
        reasons.push("Derived quote surplus is negative — migration quote is underfunded");
      }
      if (e.grossMigrationBaseRaw <= 0n) {
        reasons.push("Derived migration base requirement is zero");
      }
    } catch (e) {
      reasons.push(`Derivation failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { qualified: reasons.length === 0, reasons, derived };
}

export type TeamConfigPlan = DerivedConfig & {
  transaction: TxRequest;
  reviewHash: Hex;
  recipients: TeamRecipients;
};

/** Build the create-Config transaction for a derived config with chosen recipients. */
export function planTeamConfig(
  template: AmmoraV4ConfigSnapshot,
  recipients: TeamRecipients,
  saleSupply: bigint,
  quoteThreshold: bigint,
): TeamConfigPlan {
  if (isBlockedConfig(template.configId, template.configHash)) {
    throw new Error(`Config #${template.configId} is quarantined — select a qualified template`);
  }
  if (!template.enabled) throw new Error("Template Config is disabled");
  const derived = deriveConfigFromTemplate(template, saleSupply, quoteThreshold);
  const config: AmmoraV4Config = {
    ...derived.config,
    partnerRecipient: recipients.partnerRecipient,
    leftoverReceiver: recipients.leftoverReceiver,
    liquidityDistribution: {
      ...derived.config.liquidityDistribution,
      partner: recipients.liquidityPartner,
    },
  };
  assertAmmoraV4Config(config, derived.curve);
  const built = buildCreateAmmoraV4Config(config, derived.curve, recipients.configOwner);
  const transaction: TxRequest = { to: CORE.configRegistry, data: built.data };
  const reviewHash = keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "bytes" }],
      [91342n, transaction.to, 0n, transaction.data],
    ),
  );
  return { ...derived, config, transaction, reviewHash, recipients };
}

export async function executeCreateConfig(
  wallet: WalletClient,
  client: PublicClient,
  account: Address,
  plan: TeamConfigPlan,
): Promise<{ hash: Hash; configId: bigint; configHash: Hex }> {
  const hash = await sendTx(wallet, client, account, plan.transaction, "Create Config");
  const receipt = await client.getTransactionReceipt({ hash });
  const created = parseAmmoraV4ConfigCreatedReceipt(receipt, CORE.configRegistry);
  if (created.owner.toLowerCase() !== plan.recipients.configOwner.toLowerCase()) {
    throw new Error("Config receipt owner does not match the planned Config owner");
  }
  return { hash, configId: created.configId, configHash: created.configHash };
}

export { BLOCKED_CONFIG };
