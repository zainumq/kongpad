import { useCallback, useEffect, useMemo, useState } from "react";
import { formatUnits, isAddress, parseUnits, type Address, type Hash } from "viem";
import {
  buildLaunchTx,
  describeError,
  executeCreateLaunch,
  fmt,
  getConfig,
  type AmmoraV4ConfigSnapshot,
} from "../lib/ammora";
import { getFinalizedBlock, getPublicClient } from "../lib/giwa";
import { getWalletClient, type WalletState } from "../lib/wallet";
import {
  STANDARD_SALE_TOKENS,
  STANDARD_THRESHOLD_WETH,
  executeCreateConfig,
  planTeamConfig,
  qualifyTemplate,
  type TeamConfigPlan,
  type TeamRecipients,
} from "../lib/launchpad";
import { getAmmoraV4NextConfigId } from "@ammora-protocol/sdk";
import { CORE } from "../lib/giwa";
import { saveMyConfig, saveMyLaunch } from "../lib/store";
import { Card, EmptyState, ErrorBox, Spinner, TxLink, TxStatus } from "./ui";
import type { EnrichedLaunch } from "./Explorer";

type StudioProps = {
  wallet: WalletState;
  onLaunched: (launch: EnrichedLaunch) => void;
  refreshKey: number;
};

const CONFIG_CONCURRENCY = 6;

export function LaunchStudio({ wallet, onLaunched }: StudioProps) {
  const client = getPublicClient();
  const [configs, setConfigs] = useState<AmmoraV4ConfigSnapshot[]>([]);
  const [loadingConfigs, setLoadingConfigs] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [loadProgress, setLoadProgress] = useState("");

  // Step 1 — Config
  const [templateId, setTemplateId] = useState<string>("");
  const [saleTokens, setSaleTokens] = useState("1000000");
  const [thresholdWeth, setThresholdWeth] = useState("0.05");
  const [recipients, setRecipients] = useState<TeamRecipients | null>(null);
  const [plan, setPlan] = useState<TeamConfigPlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [creatingConfig, setCreatingConfig] = useState(false);
  const [configTx, setConfigTx] = useState<Hash | null>(null);
  const [createdConfig, setCreatedConfig] = useState<{ id: bigint; hash: string } | null>(null);
  const [txStatus, setTxStatus] = useState<string | null>(null);

  // Step 2 — Token
  const [launchConfigId, setLaunchConfigId] = useState("");
  const [tokenName, setTokenName] = useState("");
  const [tokenSymbol, setTokenSymbol] = useState("");
  const [metadataUri, setMetadataUri] = useState("");
  const [launching, setLaunching] = useState(false);
  const [launchTx, setLaunchTx] = useState<Hash | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [launchConfigSnapshot, setLaunchConfigSnapshot] = useState<AmmoraV4ConfigSnapshot | null>(null);
  const [launchConfigError, setLaunchConfigError] = useState<string | null>(null);

  const loadConfigs = useCallback(async () => {
    setLoadingConfigs(true);
    setConfigError(null);
    try {
      const block = await getFinalizedBlock(client);
      const nextId = await getAmmoraV4NextConfigId(client, CORE.configRegistry, block);
      const ids = Array.from({ length: Number(nextId - 1n) }, (_, i) => BigInt(i + 1));
      const found: AmmoraV4ConfigSnapshot[] = [];
      let done = 0;
      const workers = Array.from({ length: CONFIG_CONCURRENCY }, async () => {
        while (ids.length > 0) {
          const id = ids.shift();
          if (id === undefined) break;
          try {
            found.push(await getConfig(client, id, block));
          } catch {
            // A single unreadable Config must not block the whole list.
          }
          done += 1;
          setLoadProgress(`Reading Configs… ${done}/${Number(nextId - 1n)}`);
        }
      });
      await Promise.all(workers);
      found.sort((a, b) => (a.configId < b.configId ? -1 : 1));
      setConfigs(found);
      setLoadProgress("");
    } catch (e) {
      setConfigError(describeError(e));
    } finally {
      setLoadingConfigs(false);
    }
  }, [client]);

  useEffect(() => {
    void loadConfigs();
  }, [loadConfigs]);

  const qualified = useMemo(
    () =>
      configs
        .map((c) => ({ snapshot: c, q: qualifyTemplate(c) }))
        .filter((x) => x.q.qualified),
    [configs],
  );

  // Default template: prefer #10 when qualified (it has a historical testnet
  // graduation), otherwise the lowest qualified id. Never #6 (blocked).
  useEffect(() => {
    if (templateId || qualified.length === 0) return;
    const ten = qualified.find((x) => x.snapshot.configId === 10n);
    setTemplateId((ten ?? qualified[0])!.snapshot.configId.toString());
  }, [qualified, templateId]);

  const template = useMemo(
    () => configs.find((c) => c.configId.toString() === templateId) ?? null,
    [configs, templateId],
  );

  useEffect(() => {
    if (wallet.address && !recipients) {
      setRecipients({
        configOwner: wallet.address,
        partnerRecipient: wallet.address,
        liquidityPartner: wallet.address,
        leftoverReceiver: wallet.address,
      });
    }
  }, [wallet.address, recipients]);

  // Re-plan whenever inputs change.
  useEffect(() => {
    setPlan(null);
    setPlanError(null);
    if (!template || !recipients || !wallet.address) return;
    try {
      const saleSupply = parseUnits(saleTokens || "0", template.config.tokenDecimals);
      const threshold = parseUnits(thresholdWeth || "0", 18);
      if (saleSupply <= 0n) throw new Error("Sale supply must be positive");
      if (threshold <= 0n) throw new Error("Graduation threshold must be positive");
      const p = planTeamConfig(
        template,
        { ...recipients, configOwner: wallet.address },
        saleSupply,
        threshold,
      );
      setPlan(p);
    } catch (e) {
      setPlanError(describeError(e));
    }
  }, [template, recipients, saleTokens, thresholdWeth, wallet.address]);

  const handleCreateConfig = async () => {
    if (!wallet.address || !plan) return;
    setCreatingConfig(true);
    setTxStatus("Simulating, then waiting for your wallet signature…");
    try {
      const wc = getWalletClient(wallet.address);
      const created = await executeCreateConfig(wc, client, wallet.address, plan);
      setConfigTx(created.hash);
      setCreatedConfig({ id: created.configId, hash: created.configHash });
      setLaunchConfigId(created.configId.toString());
      saveMyConfig({
        configId: created.configId.toString(),
        configHash: created.configHash,
        templateId: template?.configId.toString() ?? "",
        txHash: created.hash,
        blockNumber: "",
        createdAt: Date.now(),
        owner: wallet.address,
      });
      setTxStatus("Config created and confirmed.");
      void loadConfigs();
    } catch (e) {
      setTxStatus(null);
      setPlanError(describeError(e));
    } finally {
      setCreatingConfig(false);
    }
  };

  const loadLaunchConfig = useCallback(async () => {
    setLaunchConfigSnapshot(null);
    setLaunchConfigError(null);
    const id = launchConfigId.trim();
    if (!/^\d+$/.test(id)) {
      setLaunchConfigError("Enter a numeric Config id");
      return;
    }
    try {
      const block = await getFinalizedBlock(client);
      const snap = await getConfig(client, BigInt(id), block);
      if (snap.configId === 6n) {
        setLaunchConfigError("Config #6 is quarantined by Ammora — it can sell all base inventory and fail migration. Pick another Config.");
        return;
      }
      if (!snap.enabled) {
        setLaunchConfigError(`Config #${id} is disabled and cannot be launched on.`);
        return;
      }
      setLaunchConfigSnapshot(snap);
    } catch (e) {
      setLaunchConfigError(describeError(e));
    }
  }, [client, launchConfigId]);

  useEffect(() => {
    if (launchConfigId.trim()) void loadLaunchConfig();
  }, [launchConfigId, loadLaunchConfig]);

  const handleCreateLaunch = async () => {
    if (!wallet.address || !launchConfigSnapshot) return;
    if (!tokenName.trim() || !tokenSymbol.trim()) {
      setLaunchError("Token name and symbol are required");
      return;
    }
    setLaunching(true);
    setLaunchError(null);
    setTxStatus("Simulating, then waiting for your wallet signature…");
    try {
      const wc = getWalletClient(wallet.address);
      const tx = buildLaunchTx({
        name: tokenName.trim(),
        symbol: tokenSymbol.trim().toUpperCase(),
        metadataURI: metadataUri.trim() || `https://example.com/${tokenSymbol.trim().toUpperCase()}.json`,
        tokenDecimals: launchConfigSnapshot.config.tokenDecimals,
        configId: launchConfigSnapshot.configId,
        poolCreationFee: launchConfigSnapshot.config.poolCreationFee,
      });
      const created = await executeCreateLaunch(
        wc,
        client,
        wallet.address,
        tx,
        launchConfigSnapshot.configId,
        launchConfigSnapshot.configHash,
      );
      setLaunchTx(created.hash);
      setTxStatus("Token launched and confirmed.");
      saveMyLaunch({
        token: created.token,
        curve: created.curve,
        configId: launchConfigSnapshot.configId.toString(),
        name: tokenName.trim(),
        symbol: tokenSymbol.trim().toUpperCase(),
        txHash: created.hash,
        blockNumber: "",
        createdAt: Date.now(),
        creator: wallet.address,
      });
      onLaunched({
        token: created.token,
        curve: created.curve,
        creator: wallet.address,
        configId: launchConfigSnapshot.configId,
        configHash: launchConfigSnapshot.configHash,
        metadataURI: metadataUri.trim(),
        blockNumber: 0n,
        txHash: created.hash,
        meta: { name: tokenName.trim(), symbol: tokenSymbol.trim().toUpperCase(), decimals: launchConfigSnapshot.config.tokenDecimals },
      });
    } catch (e) {
      setLaunchError(describeError(e));
      setTxStatus(null);
    } finally {
      setLaunching(false);
    }
  };

  const setRecipient = (field: keyof TeamRecipients, value: string) => {
    setRecipients((r) => (r ? { ...r, [field]: value as Address } : r));
  };

  const recipientsValid = recipients
    ? (Object.values(recipients) as string[]).every((a) => isAddress(a))
    : false;

  return (
    <div className="stack">
      <Card
        title="Step 1 — Create your Config"
        subtitle="A Config fixes curve economics, fees and recipients for every token launched on it. It is derived from a graduation-qualified template and is immutable once created."
        actions={
          <button type="button" className="btn btn-small" disabled={loadingConfigs} onClick={() => void loadConfigs()}>
            {loadingConfigs ? "Loading…" : "Reload Configs"}
          </button>
        }
      >
        {configError ? <ErrorBox message={configError} onRetry={() => void loadConfigs()} /> : null}
        {loadingConfigs ? <Spinner label={loadProgress || "Reading Configs from the Registry…"} /> : null}
        {!loadingConfigs && qualified.length === 0 && !configError ? (
          <EmptyState title="No qualified template found" body="No on-chain Config passed the graduation-readiness checks. Reload, or check back after the Registry updates." />
        ) : null}

        <div className="form-grid">
          <label className="field">
            <span>Template Config (graduation-qualified only)</span>
            <select className="input" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              {qualified.map(({ snapshot }) => (
                <option key={snapshot.configId.toString()} value={snapshot.configId.toString()}>
                  #{snapshot.configId.toString()} — {snapshot.config.tokenDecimals} decimals, creator share{" "}
                  {snapshot.config.creatorShareOfNonProtocolBps / 100}%{snapshot.configId === 10n ? " · historical graduation ✓" : ""}
                </option>
              ))}
            </select>
            <span className="hint">
              {configs.length} Configs on-chain · {qualified.length} qualified · Config #6 is blocked (quarantined by Ammora).
            </span>
          </label>
          <label className="field">
            <span>Sale supply (tokens on the curve)</span>
            <input className="input" value={saleTokens} onChange={(e) => setSaleTokens(e.target.value.replace(/[^0-9]/g, ""))} inputMode="numeric" />
          </label>
          <label className="field">
            <span>Graduation threshold (WETH)</span>
            <input className="input" value={thresholdWeth} onChange={(e) => setThresholdWeth(e.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal" />
            <span className="hint">Quote that must be raised before the token can graduate.</span>
          </label>
        </div>

        <h3 className="subhead">Recipients — all four are set explicitly (nothing is inherited from the template)</h3>
        <div className="form-grid">
          {(["configOwner", "partnerRecipient", "liquidityPartner", "leftoverReceiver"] as const).map((field) => (
            <label className="field" key={field}>
              <span>
                {field === "configOwner"
                  ? "Config owner (must be the signing wallet)"
                  : field === "partnerRecipient"
                    ? "Partner fee recipient"
                    : field === "liquidityPartner"
                      ? "Partner LP recipient"
                      : "Leftover receiver"}
              </span>
              <input
                className="input mono"
                value={recipients ? recipients[field] : ""}
                disabled={field === "configOwner"}
                onChange={(e) => setRecipient(field, e.target.value)}
                placeholder="0x…"
              />
            </label>
          ))}
        </div>
        {!recipientsValid ? <p className="error-text">All recipient addresses must be valid.</p> : null}

        {plan ? (
          <div className="preview">
            <h3 className="subhead">Derived economics — budget reconciliation</h3>
            <dl className="kv">
              <dt>Sale allocation</dt>
              <dd>{fmt(plan.economics.saleAllocationRaw, template?.config.tokenDecimals ?? 9)} tokens</dd>
              <dt>Migration base reserved</dt>
              <dd>{fmt(plan.economics.grossMigrationBaseRaw, template?.config.tokenDecimals ?? 9)} tokens</dd>
              <dt>Locked base (vesting)</dt>
              <dd>{fmt(plan.economics.lockedBaseRaw, template?.config.tokenDecimals ?? 9)} tokens</dd>
              <dt>Total supply</dt>
              <dd>{fmt(plan.economics.totalSupplyRaw, template?.config.tokenDecimals ?? 9)} tokens</dd>
              <dt>Migration quote (after fee)</dt>
              <dd>{formatUnits(plan.economics.grossMigrationQuoteRaw, 18)} WETH</dd>
              <dt>Quote surplus to protocol</dt>
              <dd>{formatUnits(plan.economics.quoteSurplusToProtocolRaw, 18)} WETH</dd>
              <dt>Review hash</dt>
              <dd className="mono small">{plan.reviewHash.slice(0, 34)}…</dd>
            </dl>
            <p className="muted small">
              Invariants verified: totalSupply = sale + migration base + locked base; post-fee quote covers the migration
              destination (surplus ≥ 0). Standard probe uses {STANDARD_SALE_TOKENS.toString()} tokens /{" "}
              {formatUnits(STANDARD_THRESHOLD_WETH, 18)} WETH.
            </p>
          </div>
        ) : null}
        {planError ? <ErrorBox message={planError} /> : null}

        <div className="row">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!wallet.isConnected || !wallet.isCorrectChain || !plan || !recipientsValid || creatingConfig}
            onClick={() => void handleCreateConfig()}
          >
            {creatingConfig ? "Creating Config…" : "Create Config (sign in wallet)"}
          </button>
          {createdConfig ? (
            <span className="muted">
              Created Config #{createdConfig.id.toString()} · <TxLink hash={configTx ?? ""} />
            </span>
          ) : null}
        </div>
        {!wallet.isConnected ? <p className="hint">Connect your wallet to create a Config.</p> : null}
      </Card>

      <Card title="Step 2 — Launch a token" subtitle="Creates a new token + bonding curve in one transaction to the launch factory. The signing wallet becomes the Creator.">
        <div className="form-grid">
          <label className="field">
            <span>Config id</span>
            <input
              className="input mono"
              value={launchConfigId}
              onChange={(e) => setLaunchConfigId(e.target.value.replace(/[^0-9]/g, ""))}
              placeholder="e.g. the Config you just created"
              inputMode="numeric"
            />
            <span className="hint">Config #6 is blocked. Your own Config from Step 1 is pre-filled after creation.</span>
          </label>
          <label className="field">
            <span>Token name</span>
            <input className="input" value={tokenName} onChange={(e) => setTokenName(e.target.value)} placeholder="Kong Coin" maxLength={64} />
          </label>
          <label className="field">
            <span>Symbol</span>
            <input className="input" value={tokenSymbol} onChange={(e) => setTokenSymbol(e.target.value.toUpperCase())} placeholder="KONG" maxLength={16} />
          </label>
          <label className="field">
            <span>Metadata URI (optional)</span>
            <input className="input mono" value={metadataUri} onChange={(e) => setMetadataUri(e.target.value)} placeholder="https://…/metadata.json" />
          </label>
        </div>

        {launchConfigError ? <ErrorBox message={launchConfigError} onRetry={() => void loadLaunchConfig()} /> : null}
        {launchConfigSnapshot ? (
          <div className="preview">
            <dl className="kv">
              <dt>Config</dt>
              <dd>
                #{launchConfigSnapshot.configId.toString()} · {launchConfigSnapshot.config.tokenDecimals} decimals ·{" "}
                {launchConfigSnapshot.config.migrationMode === 0 ? "concentrated graduation" : `migration mode ${launchConfigSnapshot.config.migrationMode}`}
              </dd>
              <dt>Pool creation fee</dt>
              <dd>{formatUnits(launchConfigSnapshot.config.poolCreationFee, 18)} ETH (paid in native ETH with the creation tx)</dd>
              <dt>Creator share of fees</dt>
              <dd>{launchConfigSnapshot.config.creatorShareOfNonProtocolBps / 100}% of non-protocol fees</dd>
              <dt>Graduation threshold</dt>
              <dd>{formatUnits(launchConfigSnapshot.config.migrationQuoteThreshold, 18)} WETH</dd>
            </dl>
          </div>
        ) : null}
        {launchError ? <ErrorBox message={launchError} /> : null}

        <div className="row">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!wallet.isConnected || !wallet.isCorrectChain || !launchConfigSnapshot || launching}
            onClick={() => void handleCreateLaunch()}
          >
            {launching ? "Launching…" : "Launch token (sign in wallet)"}
          </button>
          {launchTx ? (
            <span className="muted">
              Launched · <TxLink hash={launchTx} />
            </span>
          ) : null}
        </div>
        <p className="muted small">
          After launch you are taken to the Trade tab, where you can make the first buy. Token + curve addresses come from
          the confirmed receipt — never from a prediction.
        </p>
      </Card>

      <TxStatus status={txStatus} hash={null} />
    </div>
  );
}
