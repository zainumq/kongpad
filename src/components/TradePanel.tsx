import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { encodeFunctionData, formatEther, formatUnits, isAddress, parseUnits, type Address, type Hash } from "viem";
import {
  describeError,
  executeCurveSwap,
  executeMigration,
  executePoolSwap,
  fmt,
  getBalance,
  getCurveState,
  getTokenMeta,
  planCurveSwap,
  quoteCurve,
  sendTx,
  type AmmoraV4LaunchCurveState,
  type TokenMeta,
} from "../lib/ammora";
import { CORE, WETH, explorerAddress, getFinalizedBlock, getPublicClient } from "../lib/giwa";
import { getWalletClient, type WalletState } from "../lib/wallet";
import { Card, ErrorBox, ProgressBar, Spinner, StatusBadge, TxLink, TxStatus } from "./ui";
import type { EnrichedLaunch } from "./Explorer";

const WETH_ABI = [
  { type: "function", name: "deposit", stateMutability: "payable", inputs: [], outputs: [] },
  { type: "function", name: "withdraw", stateMutability: "nonpayable", inputs: [{ name: "wad", type: "uint256" }], outputs: [] },
] as const;

type TradeProps = {
  launch: EnrichedLaunch | null;
  wallet: WalletState;
  onLaunchChange: (launch: EnrichedLaunch | null) => void;
};

export function TradePanel({ launch, wallet, onLaunchChange }: TradeProps) {
  const client = getPublicClient();
  const [curveInput, setCurveInput] = useState("");
  const [curve, setCurve] = useState<Address | null>(launch?.curve ?? null);
  const [state, setState] = useState<AmmoraV4LaunchCurveState | null>(launch?.state ?? null);
  const [meta, setMeta] = useState<TokenMeta | null>(launch?.meta ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  const [slippageBps, setSlippageBps] = useState(50);
  const [quote, setQuote] = useState<{
    out: bigint;
    minOut: bigint;
    fee: bigint;
    left: bigint;
    kind: string;
  } | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [quoting, setQuoting] = useState(false);

  const [wethBalance, setWethBalance] = useState<bigint | null>(null);
  const [tokenBalance, setTokenBalance] = useState<bigint | null>(null);
  const [ethBalance, setEthBalance] = useState<bigint | null>(null);

  const [busy, setBusy] = useState(false);
  const [txStatus, setTxStatus] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<Hash | null>(null);
  const [tradeError, setTradeError] = useState<string | null>(null);
  const [wrapAmount, setWrapAmount] = useState("");

  const quoteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (launch) {
      setCurve(launch.curve);
      setCurveInput(launch.curve);
      setState(launch.state ?? null);
      setMeta(launch.meta ?? null);
    }
  }, [launch]);

  const refresh = useCallback(async () => {
    if (!curve) return;
    setLoading(true);
    setError(null);
    try {
      const block = await getFinalizedBlock(client);
      const s = await getCurveState(client, curve, block);
      setState(s);
      const m = await getTokenMeta(client, s.baseToken);
      setMeta(m);
      if (wallet.address) {
        const [w, t, e] = await Promise.all([
          getBalance(client, WETH, wallet.address),
          getBalance(client, s.baseToken, wallet.address),
          client.getBalance({ address: wallet.address }),
        ]);
        setWethBalance(w);
        setTokenBalance(t);
        setEthBalance(e);
      }
    } catch (e) {
      setError(describeError(e));
    } finally {
      setLoading(false);
    }
  }, [client, curve, wallet.address]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const loadCurve = () => {
    if (!isAddress(curveInput)) {
      setError("Enter a valid curve address");
      return;
    }
    setCurve(curveInput as Address);
    setState(null);
    setMeta(null);
    onLaunchChange(null);
  };

  // Debounced quote.
  useEffect(() => {
    setQuote(null);
    setQuoteError(null);
    if (!curve || !state || state.status !== 1 || !amount) return;
    if (quoteTimer.current) clearTimeout(quoteTimer.current);
    quoteTimer.current = setTimeout(() => {
      void (async () => {
        setQuoting(true);
        try {
          const decimals = side === "buy" ? 18 : (meta?.decimals ?? 9);
          const amountIn = parseUnits(amount, decimals);
          if (amountIn <= 0n) {
            setQuoting(false);
            return;
          }
          const block = await getFinalizedBlock(client);
          const q = await quoteCurve(client, curve, amountIn, side === "sell", block);
          const minOut = (q.quote.amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
          setQuote({ out: q.quote.amountOut, minOut, fee: q.quote.fee, left: q.quote.amountLeft, kind: q.fill.kind });
        } catch (e) {
          setQuoteError(describeError(e));
        } finally {
          setQuoting(false);
        }
      })();
    }, 500);
    return () => {
      if (quoteTimer.current) clearTimeout(quoteTimer.current);
    };
  }, [amount, side, curve, state, meta, slippageBps, client]);

  const tokenIn = useMemo(() => {
    if (!state) return null;
    return side === "buy" ? state.quoteToken : state.baseToken;
  }, [state, side]);

  const insufficient = useMemo(() => {
    if (!amount || !state) return false;
    try {
      const decimals = side === "buy" ? 18 : (meta?.decimals ?? 9);
      const amountIn = parseUnits(amount, decimals);
      const bal = side === "buy" ? wethBalance : tokenBalance;
      return bal !== null && amountIn > bal;
    } catch {
      return false;
    }
  }, [amount, side, state, meta, wethBalance, tokenBalance]);

  const handleSwap = async () => {
    if (!wallet.address || !curve || !state || !tokenIn || !amount) return;
    setBusy(true);
    setTradeError(null);
    setTxStatus("Planning the swap…");
    try {
      const decimals = side === "buy" ? 18 : (meta?.decimals ?? 9);
      const amountIn = parseUnits(amount, decimals);
      const plan = await planCurveSwap(client, curve, tokenIn, amountIn, wallet.address, slippageBps, false);
      const wc = getWalletClient(wallet.address);
      const res = await executeCurveSwap(wc, client, wallet.address, plan, amountIn, setTxStatus);
      setLastTx(res.hash);
      setTxStatus(
        `Swap confirmed — received ${fmt(res.amountReceived, side === "buy" ? (meta?.decimals ?? 9) : 18)} ${side === "buy" ? (meta?.symbol ?? "") : "WETH"}.`,
      );
      setAmount("");
      await refresh();
    } catch (e) {
      setTradeError(describeError(e));
      setTxStatus(null);
    } finally {
      setBusy(false);
    }
  };

  const handleWrap = async () => {
    if (!wallet.address || !wrapAmount) return;
    setBusy(true);
    setTradeError(null);
    setTxStatus("Wrapping ETH → WETH…");
    try {
      const value = parseUnits(wrapAmount, 18);
      if (value <= 0n) throw new Error("Wrap amount must be positive");
      const wc = getWalletClient(wallet.address);
      const hash = await sendTx(
        wc,
        client,
        wallet.address,
        { to: WETH, data: encodeFunctionData({ abi: WETH_ABI, functionName: "deposit" }), value },
        "Wrap ETH",
      );
      setLastTx(hash);
      setTxStatus("Wrapped. WETH balance updated.");
      setWrapAmount("");
      await refresh();
    } catch (e) {
      setTradeError(describeError(e));
      setTxStatus(null);
    } finally {
      setBusy(false);
    }
  };

  const remainingToGraduate = state
    ? state.migrationQuoteThreshold > state.quoteReserve
      ? state.migrationQuoteThreshold - state.quoteReserve
      : 0n
    : 0n;

  const handleFinalFill = async () => {
    if (!wallet.address || !curve || !state) return;
    setBusy(true);
    setTradeError(null);
    setTxStatus("Planning the final fill…");
    try {
      // Max input = remaining threshold + 10% headroom, capped by WETH balance.
      // The curve consumes only what the boundary needs; unused input stays in the wallet.
      const headroom = (remainingToGraduate * 110n) / 100n;
      const maxInput = wethBalance !== null && headroom > wethBalance ? wethBalance : headroom;
      if (maxInput <= 0n) throw new Error("Nothing left to fill, or no WETH balance");
      const plan = await planCurveSwap(client, curve, state.quoteToken, maxInput, wallet.address, 100, true);
      const wc = getWalletClient(wallet.address);
      const res = await executeCurveSwap(wc, client, wallet.address, plan, maxInput, setTxStatus);
      setLastTx(res.hash);
      setTxStatus(
        `Final fill confirmed — consumed ${formatUnits(res.consumedAmountIn, 18)} WETH, unused ${formatUnits(res.amountLeft, 18)} WETH stayed in your wallet. Now migrate.`,
      );
      await refresh();
    } catch (e) {
      setTradeError(describeError(e));
      setTxStatus(null);
    } finally {
      setBusy(false);
    }
  };

  const handleMigrate = async () => {
    if (!wallet.address || !curve) return;
    setBusy(true);
    setTradeError(null);
    setTxStatus("Simulating migration, then waiting for your signature…");
    try {
      const wc = getWalletClient(wallet.address);
      const res = await executeMigration(wc, client, wallet.address, curve);
      setLastTx(res.hash);
      setTxStatus(`Graduated! ARL pool: ${res.canonicalPool}`);
      await refresh();
    } catch (e) {
      setTradeError(describeError(e));
      setTxStatus(null);
    } finally {
      setBusy(false);
    }
  };

  const handlePoolSwap = async () => {
    if (!wallet.address || !state || state.status !== 3 || !tokenIn || !amount) return;
    setBusy(true);
    setTradeError(null);
    setTxStatus("Planning the pool swap…");
    try {
      const decimals = side === "buy" ? 18 : (meta?.decimals ?? 9);
      const amountIn = parseUnits(amount, decimals);
      const wc = getWalletClient(wallet.address);
      const res = await executePoolSwap(wc, client, wallet.address, state.canonicalPool, tokenIn, amountIn, slippageBps, setTxStatus);
      setLastTx(res.hash);
      setTxStatus(`Pool swap confirmed — received ${fmt(res.amountReceived, side === "buy" ? (meta?.decimals ?? 9) : 18)}.`);
      setAmount("");
      await refresh();
    } catch (e) {
      setTradeError(describeError(e));
      setTxStatus(null);
    } finally {
      setBusy(false);
    }
  };

  const isGraduated = state?.status === 3;
  const canTrade = state?.status === 1 || isGraduated;

  return (
    <div className="stack">
      <Card
        title="Trade"
        subtitle="Buy and sell on the bonding curve (pre-graduation) or the ARL pool (after graduation). Quotes are live, from the finalized head."
        actions={
          <button type="button" className="btn btn-small" disabled={loading || !curve} onClick={() => void refresh()}>
            Refresh
          </button>
        }
      >
        <div className="form-grid">
          <label className="field field-wide">
            <span>Curve address</span>
            <div className="row">
              <input
                className="input mono"
                value={curveInput}
                onChange={(e) => setCurveInput(e.target.value)}
                placeholder="0x… (or pick a launch in Explore)"
              />
              <button type="button" className="btn" onClick={loadCurve}>
                Load
              </button>
            </div>
          </label>
        </div>

        {error ? <ErrorBox message={error} onRetry={() => void refresh()} /> : null}
        {loading && !state ? <Spinner label="Loading curve state…" /> : null}

        {state && meta ? (
          <>
            <div className="token-head">
              <div>
                <h3>
                  {meta.name} <span className="muted">${meta.symbol}</span>
                </h3>
                <p className="muted small mono">
                  Token{" "}
                  <a href={explorerAddress(state.baseToken)} target="_blank" rel="noreferrer" className="link">
                    {state.baseToken}
                  </a>
                </p>
              </div>
              <StatusBadge status={state.status} />
            </div>

            <dl className="kv kv-3">
              <dt>Quote reserve</dt>
              <dd>{fmt(state.quoteReserve, 18, 4)} WETH</dd>
              <dt>Base reserve</dt>
              <dd>{fmt(state.baseReserve, meta.decimals, 2)} ${meta.symbol}</dd>
              <dt>Graduation threshold</dt>
              <dd>{fmt(state.migrationQuoteThreshold, 18, 4)} WETH</dd>
              <dt>Current fee</dt>
              <dd>{state.currentFeeBps / 100}%</dd>
              <dt>Creator</dt>
              <dd className="mono small">{state.creator.slice(0, 10)}…</dd>
              <dt>Config</dt>
              <dd className="mono">#{state.configId.toString()}</dd>
            </dl>
            <ProgressBar value={state.quoteReserve} max={state.migrationQuoteThreshold} label="Graduation progress" />
            {isGraduated ? (
              <p className="muted small">
                Graduated pool:{" "}
                <a href={explorerAddress(state.canonicalPool)} target="_blank" rel="noreferrer" className="link mono">
                  {state.canonicalPool}
                </a>
              </p>
            ) : null}

            {wallet.address ? (
              <p className="muted small">
                Your balances — ETH {ethBalance !== null ? formatEther(ethBalance) : "…"} · WETH{" "}
                {wethBalance !== null ? fmt(wethBalance, 18, 4) : "…"} · ${meta.symbol}{" "}
                {tokenBalance !== null ? fmt(tokenBalance, meta.decimals, 2) : "…"}
              </p>
            ) : null}

            {state.status === 2 ? (
              <div className="notice">
                <strong>Ready to migrate.</strong> The final fill is done — do not buy again. Run the separate,
                permissionless migration to create the ARL pool.
                <div className="row">
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={!wallet.isConnected || !wallet.isCorrectChain || busy}
                    onClick={() => void handleMigrate()}
                  >
                    {busy ? "Migrating…" : "Migrate to ARL pool"}
                  </button>
                </div>
              </div>
            ) : null}

            {state.status === 1 && remainingToGraduate > 0n && remainingToGraduate < state.migrationQuoteThreshold / 10n ? (
              <div className="notice">
                <strong>Near graduation</strong> — {formatUnits(remainingToGraduate, 18)} WETH left to the threshold. The
                final fill consumes only what the boundary needs; unused input stays in your wallet.
                <div className="row">
                  <button
                    type="button"
                    className="btn"
                    disabled={!wallet.isConnected || !wallet.isCorrectChain || busy}
                    onClick={() => void handleFinalFill()}
                  >
                    {busy ? "Filling…" : "Final fill (graduate)"}
                  </button>
                </div>
              </div>
            ) : null}

            {canTrade ? (
              <div className="trade-box">
                <div className="tabs tabs-small">
                  <button type="button" className={side === "buy" ? "tab active" : "tab"} onClick={() => setSide("buy")}>
                    Buy
                  </button>
                  <button type="button" className={side === "sell" ? "tab active" : "tab"} onClick={() => setSide("sell")}>
                    Sell
                  </button>
                </div>
                <div className="form-grid">
                  <label className="field">
                    <span>{side === "buy" ? "Pay (WETH)" : `Pay (${meta.symbol})`}</span>
                    <input
                      className="input mono"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
                      placeholder="0.0"
                      inputMode="decimal"
                    />
                    {insufficient ? <span className="error-text">Amount exceeds your balance.</span> : null}
                  </label>
                  <label className="field">
                    <span>Slippage (bps)</span>
                    <input
                      className="input mono"
                      value={String(slippageBps)}
                      onChange={(e) => {
                        const v = Number(e.target.value.replace(/[^0-9]/g, ""));
                        if (Number.isSafeInteger(v) && v <= 1000) setSlippageBps(v);
                      }}
                      inputMode="numeric"
                    />
                    <span className="hint">50 bps = 0.5%</span>
                  </label>
                </div>
                {quoting ? <Spinner label="Quoting…" /> : null}
                {quoteError ? <ErrorBox message={quoteError} /> : null}
                {quote && !quoteError ? (
                  <dl className="kv">
                    <dt>Expected out</dt>
                    <dd>
                      {fmt(quote.out, side === "buy" ? meta.decimals : 18)} {side === "buy" ? meta.symbol : "WETH"}
                    </dd>
                    <dt>Minimum out</dt>
                    <dd>
                      {fmt(quote.minOut, side === "buy" ? meta.decimals : 18)} {side === "buy" ? meta.symbol : "WETH"}
                    </dd>
                    <dt>Fee</dt>
                    <dd>
                      {fmt(quote.fee, side === "buy" ? 18 : meta.decimals)} {side === "buy" ? "WETH" : meta.symbol}
                    </dd>
                    <dt>Fill</dt>
                    <dd>{quote.kind}</dd>
                  </dl>
                ) : null}
                {tradeError ? <ErrorBox message={tradeError} /> : null}
                <div className="row">
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={!wallet.isConnected || !wallet.isCorrectChain || !amount || insufficient || busy || (state.status === 1 && !quote)}
                    onClick={() => void (isGraduated ? handlePoolSwap() : handleSwap())}
                  >
                    {busy ? "Working…" : `${side === "buy" ? "Buy" : "Sell"} ${isGraduated ? "on ARL pool" : "on curve"}`}
                  </button>
                </div>
                {!wallet.isConnected ? <p className="hint">Connect your wallet to trade.</p> : null}
              </div>
            ) : null}

            {side === "buy" && wallet.address ? (
              <div className="wrap-box">
                <strong>Need WETH?</strong> Buys pay in WETH (ERC-20), not native ETH. Wrap only what you need.
                <div className="row">
                  <input
                    className="input mono"
                    value={wrapAmount}
                    onChange={(e) => setWrapAmount(e.target.value.replace(/[^0-9.]/g, ""))}
                    placeholder="ETH amount"
                    inputMode="decimal"
                  />
                  <button
                    type="button"
                    className="btn"
                    disabled={!wrapAmount || busy || !wallet.isCorrectChain}
                    onClick={() => void handleWrap()}
                  >
                    {busy ? "Wrapping…" : "Wrap ETH → WETH"}
                  </button>
                </div>
              </div>
            ) : null}
          </>
        ) : null}
        {!curve && !loading ? (
          <p className="muted">Pick a launch in Explore, or paste a curve address above.</p>
        ) : null}
      </Card>

      <TxStatus status={txStatus} hash={lastTx} />
      {lastTx ? (
        <p className="muted small">
          Last tx: <TxLink hash={lastTx} /> · Factory:{" "}
          <a href={explorerAddress(CORE.launchFactory)} target="_blank" rel="noreferrer" className="link mono">
            {CORE.launchFactory.slice(0, 10)}…
          </a>
        </p>
      ) : null}
    </div>
  );
}
