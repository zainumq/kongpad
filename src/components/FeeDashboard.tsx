import { useCallback, useEffect, useState } from "react";
import { isAddress, zeroAddress, type Address, type Hash } from "viem";
import {
  claimLaunchFees,
  claimLpFees,
  classifyWalletError,
  describeError,
  fmt,
  getFeeVault,
  getLaunchFeeClaimable,
  getTokenMeta,
  getUserLpPositions,
  updateFeeDelegate,
  type ClassifiedWalletError,
  type LpPosition,
} from "../lib/ammora";
import { CORE, WETH, getFinalizedBlock, getPublicClient } from "../lib/giwa";
import { getWalletClient, type WalletState } from "../lib/wallet";
import { loadMyLaunches } from "../lib/store";
import { AddressLink, Card, EmptyState, ErrorBox, Spinner, TxLink, TxStatus, WalletErrorBox } from "./ui";

type FeeRow = {
  token: Address;
  symbol: string;
  decimals: number;
  claimable: bigint;
  label: string;
};

const PERMISSION_LABEL: Record<number, string> = {
  0: "None",
  8: "claim-fee (delegate may choose payout)",
  16: "claim-fee-to-owner (pays NFT owner only)",
};

export function FeeDashboard({ wallet }: { wallet: WalletState }) {
  const client = getPublicClient();
  const [feeVault, setFeeVault] = useState<Address | null>(null);
  const [rows, setRows] = useState<FeeRow[]>([]);
  const [loadingFees, setLoadingFees] = useState(false);
  const [feeError, setFeeError] = useState<string | null>(null);
  const [customToken, setCustomToken] = useState("");
  const [payout, setPayout] = useState("");

  const [positions, setPositions] = useState<LpPosition[]>([]);
  const [loadingPositions, setLoadingPositions] = useState(false);
  const [positionsError, setPositionsError] = useState<string | null>(null);
  const [positionsScanned, setPositionsScanned] = useState(false);

  const [delegateInputs, setDelegateInputs] = useState<Record<string, { delegate: string; mode: "claim-fee" | "claim-fee-to-owner" }>>({});
  const [busy, setBusy] = useState(false);
  const [txStatus, setTxStatus] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<Hash | null>(null);
  const [actionError, setActionError] = useState<ClassifiedWalletError | null>(null);
  // Last failed wallet action, so Retry re-runs it with current inputs.
  const [lastAction, setLastAction] = useState<
    | { kind: "claim-launch"; row: FeeRow }
    | { kind: "claim-lp"; pos: LpPosition }
    | { kind: "delegate"; pos: LpPosition; revoke: boolean }
    | null
  >(null);

  const loadLaunchFees = useCallback(async () => {
    if (!wallet.address) return;
    setLoadingFees(true);
    setFeeError(null);
    try {
      const block = await getFinalizedBlock(client);
      const vault = await getFeeVault(client, block);
      setFeeVault(vault);
      const myTokens = loadMyLaunches().map((l) => ({ token: l.token as Address, label: `Launched token ${l.symbol}` }));
      const tokens: { token: Address; label: string }[] = [
        { token: WETH, label: "Quote fees (WETH) — Creator + Partner share" },
        ...myTokens,
      ];
      const seen = new Set<string>();
      const next: FeeRow[] = [];
      for (const t of tokens) {
        const key = t.token.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const [meta, claimable] = await Promise.all([
          getTokenMeta(client, t.token),
          getLaunchFeeClaimable(client, vault, t.token, wallet.address, block),
        ]);
        next.push({ token: t.token, symbol: meta.symbol, decimals: meta.decimals, claimable, label: t.label });
      }
      setRows(next);
    } catch (e) {
      setFeeError(describeError(e));
    } finally {
      setLoadingFees(false);
    }
  }, [client, wallet.address]);

  useEffect(() => {
    void loadLaunchFees();
  }, [loadLaunchFees]);

  const loadPositions = useCallback(async () => {
    if (!wallet.address) return;
    setLoadingPositions(true);
    setPositionsError(null);
    try {
      const found = await getUserLpPositions(client, wallet.address);
      setPositions(found);
      setPositionsScanned(true);
    } catch (e) {
      setPositionsError(describeError(e));
    } finally {
      setLoadingPositions(false);
    }
  }, [client, wallet.address]);

  const addCustomToken = async () => {
    if (!wallet.address || !feeVault || !isAddress(customToken)) {
      setFeeError("Enter a valid token address to check");
      return;
    }
    setLoadingFees(true);
    try {
      const block = await getFinalizedBlock(client);
      const [meta, claimable] = await Promise.all([
        getTokenMeta(client, customToken as Address),
        getLaunchFeeClaimable(client, feeVault, customToken as Address, wallet.address, block),
      ]);
      setRows((prev) =>
        prev.some((r) => r.token.toLowerCase() === customToken.toLowerCase())
          ? prev.map((r) => (r.token.toLowerCase() === customToken.toLowerCase() ? { ...r, claimable } : r))
          : [...prev, { token: customToken as Address, symbol: meta.symbol, decimals: meta.decimals, claimable, label: "Custom fee token" }],
      );
      setCustomToken("");
    } catch (e) {
      setFeeError(describeError(e));
    } finally {
      setLoadingFees(false);
    }
  };

  const payoutOrSelf = (): Address => {
    if (payout.trim() === "") return wallet.address as Address;
    if (!isAddress(payout.trim())) throw new Error("Payout address is not valid");
    const p = payout.trim() as Address;
    if (p === zeroAddress) throw new Error("Payout must not be the zero address");
    return p;
  };

  const handleClaimLaunchFee = async (row: FeeRow) => {
    if (!wallet.address || !feeVault) return;
    setBusy(true);
    setActionError(null);
    setLastAction(null);
    setTxStatus("Claiming launch fees…");
    try {
      const wc = getWalletClient(wallet.address);
      const hash = await claimLaunchFees(wc, client, wallet.address, feeVault, row.token, payoutOrSelf());
      setLastTx(hash);
      setTxStatus(`Claimed ${fmt(row.claimable, row.decimals)} ${row.symbol}.`);
      await loadLaunchFees();
    } catch (e) {
      setActionError(classifyWalletError(e));
      setLastAction({ kind: "claim-launch", row });
      setTxStatus(null);
    } finally {
      setBusy(false);
    }
  };

  const handleClaimLpFees = async (pos: LpPosition) => {
    if (!wallet.address) return;
    setBusy(true);
    setActionError(null);
    setLastAction(null);
    setTxStatus("Claiming LP fees…");
    try {
      const wc = getWalletClient(wallet.address);
      const hash = await claimLpFees(wc, client, wallet.address, pos.pool, pos.tokenId, payoutOrSelf());
      setLastTx(hash);
      setTxStatus("LP fees claimed.");
      await loadPositions();
    } catch (e) {
      setActionError(classifyWalletError(e));
      setLastAction({ kind: "claim-lp", pos });
      setTxStatus(null);
    } finally {
      setBusy(false);
    }
  };

  const handleDelegate = async (pos: LpPosition, revoke: boolean) => {
    if (!wallet.address) return;
    const input = delegateInputs[pos.tokenId.toString()];
    const delegate = revoke ? zeroAddress : (input?.delegate as Address | undefined);
    if (!revoke && (!delegate || !isAddress(delegate))) {
      setActionError({ kind: "other", message: "Enter a valid delegate address" });
      return;
    }
    if (!revoke && delegate!.toLowerCase() === wallet.address.toLowerCase()) {
      setActionError({ kind: "other", message: "Fee delegate must differ from the NFT owner" });
      return;
    }
    const permission = revoke ? 0 : input?.mode === "claim-fee" ? 8 : 16;
    setBusy(true);
    setActionError(null);
    setLastAction(null);
    setTxStatus(revoke ? "Revoking fee delegation…" : "Granting fee delegation…");
    try {
      const wc = getWalletClient(wallet.address);
      const hash = await updateFeeDelegate(wc, client, wallet.address, pos.pool, pos.tokenId, delegate!, permission);
      setLastTx(hash);
      setTxStatus(revoke ? "Delegation revoked and confirmed on-chain." : "Delegation granted and confirmed on-chain.");
      await loadPositions();
    } catch (e) {
      setActionError(classifyWalletError(e));
      setLastAction({ kind: "delegate", pos, revoke });
      setTxStatus(null);
    } finally {
      setBusy(false);
    }
  };

  const retryAction = () => {
    if (lastAction?.kind === "claim-launch") void handleClaimLaunchFee(lastAction.row);
    else if (lastAction?.kind === "claim-lp") void handleClaimLpFees(lastAction.pos);
    else if (lastAction?.kind === "delegate") void handleDelegate(lastAction.pos, lastAction.revoke);
  };

  const totalClaimableWeth = rows.find((r) => r.token.toLowerCase() === WETH.toLowerCase())?.claimable ?? 0n;

  return (
    <div className="stack">
      <Card
        title="Fee dashboard — Creator & Partner launch fees"
        subtitle="Fees from every launch settle in the factory FeeVault, keyed by fee asset and beneficiary. Claimable balances aggregate all your launches per asset — the vault does not attribute fees per token."
        actions={
          <button type="button" className="btn btn-small" disabled={loadingFees || !wallet.address} onClick={() => void loadLaunchFees()}>
            Refresh
          </button>
        }
      >
        {!wallet.address ? (
          <EmptyState title="Connect your wallet" body="Fee entitlements belong to the connected wallet (Creator or Partner recipient)." />
        ) : (
          <>
            <p className="muted small">
              FeeVault: {feeVault ? <AddressLink address={feeVault} /> : "…"} · Beneficiary:{" "}
              <AddressLink address={wallet.address} />
            </p>
            {feeError ? <ErrorBox message={feeError} onRetry={() => void loadLaunchFees()} /> : null}
            {loadingFees ? <Spinner label="Reading claimable fees…" /> : null}
            <div className="form-grid">
              <label className="field">
                <span>Payout address (optional — defaults to your wallet)</span>
                <input
                  className="input mono"
                  value={payout}
                  onChange={(e) => setPayout(e.target.value)}
                  placeholder="0x… (leave empty to pay yourself)"
                />
                <span className="hint">A payout address receives funds but gains no claim authority.</span>
              </label>
              <label className="field">
                <span>Check another fee token</span>
                <div className="row">
                  <input
                    className="input mono"
                    value={customToken}
                    onChange={(e) => setCustomToken(e.target.value)}
                    placeholder="0x… token address"
                  />
                  <button type="button" className="btn" disabled={!customToken} onClick={() => void addCustomToken()}>
                    Check
                  </button>
                </div>
              </label>
            </div>

            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Fee asset</th>
                    <th>Source</th>
                    <th>Claimable</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.token}>
                      <td>
                        <strong>{r.symbol}</strong>
                        <div className="muted small mono">{r.token.slice(0, 10)}…</div>
                      </td>
                      <td className="muted small">{r.label}</td>
                      <td className="mono">
                        {fmt(r.claimable, r.decimals)} {r.symbol}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn btn-small btn-primary"
                          disabled={r.claimable === 0n || busy || !wallet.isCorrectChain}
                          onClick={() => void handleClaimLaunchFee(r)}
                        >
                          Claim
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {rows.length === 0 && !loadingFees ? (
              <EmptyState title="No fee rows yet" body="WETH fees appear once your launched tokens are traded. Issued-token fees accrue per launched token." />
            ) : null}
            <p className="muted small">
              Total WETH claimable: {fmt(totalClaimableWeth, 18)} WETH · Quote claims do not also claim issued-token fees —
              claim each asset separately. Zero-claimable rows send no transaction.
            </p>
          </>
        )}
      </Card>

      <Card
        title="LP positions & fee delegation"
        subtitle="Concentrated (ARL) LP positions are Manager NFTs. Claim their accrued base/quote fees, or delegate fee-only claiming to another wallet — delegation never moves principal or NFT ownership."
        actions={
          <button type="button" className="btn btn-small" disabled={loadingPositions || !wallet.address} onClick={() => void loadPositions()}>
            {loadingPositions ? "Scanning…" : positionsScanned ? "Rescan" : "Scan my positions"}
          </button>
        }
      >
        {!wallet.address ? (
          <EmptyState title="Connect your wallet" body="Positions are discovered from ERC-721 Transfer logs to your address, then ownership is re-read on-chain." />
        ) : (
          <>
            {positionsError ? <ErrorBox message={positionsError} onRetry={() => void loadPositions()} /> : null}
            {loadingPositions ? <Spinner label="Scanning Transfer logs from the deployment start block — this can take a minute…" /> : null}
            {positionsScanned && positions.length === 0 && !loadingPositions ? (
              <EmptyState
                title="No LP positions held"
                body="Graduate a token to receive LP NFTs, or add liquidity to a graduated pool. Positions that arrived by transfer are included."
              />
            ) : null}
            {positions.map((pos) => (
              <div className="position" key={pos.tokenId.toString()}>
                <div className="position-head">
                  <strong>Position NFT #{pos.tokenId.toString()}</strong>
                  <span className="muted small">
                    Pool <AddressLink address={pos.pool} /> · Manager{" "}
                    <AddressLink address={CORE.concentratedPositionManager} />
                  </span>
                </div>
                <dl className="kv kv-3">
                  <dt>Unlocked liquidity</dt>
                  <dd className="mono">{pos.unlockedLiquidity.toString()}</dd>
                  <dt>Permanently locked</dt>
                  <dd className="mono">{pos.permanentLockedLiquidity.toString()}</dd>
                  <dt>Vesting</dt>
                  <dd className="mono">{pos.vestedLiquidity.toString()}</dd>
                  <dt>Claimable base</dt>
                  <dd className="mono">
                    {pos.claimableBase !== null ? `${fmt(pos.claimableBase, pos.baseDecimals)} ${pos.baseSymbol}` : "unreadable"}
                  </dd>
                  <dt>Claimable quote</dt>
                  <dd className="mono">
                    {pos.claimableQuote !== null ? `${fmt(pos.claimableQuote, pos.quoteDecimals)} ${pos.quoteSymbol}` : "unreadable"}
                  </dd>
                  <dt>Fee delegate</dt>
                  <dd className="mono small">
                    {pos.delegate === zeroAddress ? "none" : `${pos.delegate.slice(0, 10)}… · ${PERMISSION_LABEL[pos.permission] ?? `permission ${pos.permission}`}`}
                  </dd>
                </dl>
                <div className="row">
                  <button
                    type="button"
                    className="btn btn-small btn-primary"
                    disabled={busy || !wallet.isCorrectChain || (pos.claimableBase === 0n && pos.claimableQuote === 0n)}
                    onClick={() => void handleClaimLpFees(pos)}
                  >
                    Claim LP fees
                  </button>
                </div>
                <div className="delegate-box">
                  <div className="form-grid">
                    <label className="field">
                      <span>Fee delegate address</span>
                      <input
                        className="input mono"
                        value={delegateInputs[pos.tokenId.toString()]?.delegate ?? ""}
                        onChange={(e) =>
                          setDelegateInputs((prev) => ({
                            ...prev,
                            [pos.tokenId.toString()]: {
                              delegate: e.target.value,
                              mode: prev[pos.tokenId.toString()]?.mode ?? "claim-fee-to-owner",
                            },
                          }))
                        }
                        placeholder="0x…"
                      />
                    </label>
                    <label className="field">
                      <span>Permission</span>
                      <select
                        className="input"
                        value={delegateInputs[pos.tokenId.toString()]?.mode ?? "claim-fee-to-owner"}
                        onChange={(e) =>
                          setDelegateInputs((prev) => ({
                            ...prev,
                            [pos.tokenId.toString()]: {
                              delegate: prev[pos.tokenId.toString()]?.delegate ?? "",
                              mode: e.target.value as "claim-fee" | "claim-fee-to-owner",
                            },
                          }))
                        }
                      >
                        <option value="claim-fee-to-owner">claim-fee-to-owner (16) — pays NFT owner only</option>
                        <option value="claim-fee">claim-fee (8) — delegate may choose payout</option>
                      </select>
                    </label>
                  </div>
                  <div className="row">
                    <button
                      type="button"
                      className="btn btn-small"
                      disabled={busy || !wallet.isCorrectChain}
                      onClick={() => void handleDelegate(pos, false)}
                    >
                      Grant delegation
                    </button>
                    <button
                      type="button"
                      className="btn btn-small btn-ghost"
                      disabled={busy || !wallet.isCorrectChain || pos.delegate === zeroAddress}
                      onClick={() => void handleDelegate(pos, true)}
                    >
                      Revoke
                    </button>
                  </div>
                  <p className="muted small">
                    Granting replaces the single delegate slot. Neither permission transfers NFT ownership or grants
                    withdrawal of locked principal.
                  </p>
                </div>
              </div>
            ))}
          </>
        )}
      </Card>

      <Card title="How Ammora fees work" subtitle="Roles are not interchangeable — each wallet claims its own entitlement.">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Role</th>
                <th>What they earn</th>
                <th>How they claim</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Creator</td>
                <td>Creator share of pre-graduation trading fees (per Config split)</td>
                <td>Signs their own FeeVault claim above</td>
              </tr>
              <tr>
                <td>Partner recipient</td>
                <td>Partner share of pre-graduation trading fees</td>
                <td>Signs their own FeeVault claim above</td>
              </tr>
              <tr>
                <td>LP owner / delegate</td>
                <td>Post-graduation pool fees on their Manager NFT position</td>
                <td>Owner claims, or grants a fee delegate (8 / 16)</td>
              </tr>
              <tr>
                <td>Config owner</td>
                <td>Nothing automatic — Config ownership alone confers no fee rights</td>
                <td>—</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="muted small">
          Creator percentage applies to fees after the Protocol share. Post-graduation distribution depends on LP positions
          and reinvestment settings — it does not reuse the pre-graduation split formula.
        </p>
      </Card>

      {actionError ? (
        <WalletErrorBox error={actionError} onRetry={lastAction ? retryAction : undefined} />
      ) : null}
      <TxStatus status={txStatus} hash={lastTx} />
      {lastTx ? (
        <p className="muted small">
          Last tx: <TxLink hash={lastTx} />
        </p>
      ) : null}
    </div>
  );
}
