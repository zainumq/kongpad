import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Address } from "viem";
import {
  describeError,
  discoverLaunches,
  fmt,
  getCurveState,
  getTokenMeta,
  type LaunchRecord,
  type AmmoraV4LaunchCurveState,
  type TokenMeta,
} from "../lib/ammora";
import { CORE, DEPLOYMENT_START_BLOCK, WETH, getPublicClient } from "../lib/giwa";
import { clearLaunchCache, loadLaunchCache, saveLaunchCache } from "../lib/store";
import { AddressLink, Card, EmptyState, ErrorBox, ProgressBar, Spinner, StatusBadge } from "./ui";
import { TokenIcon } from "./TokenIcon";

export type EnrichedLaunch = LaunchRecord & {
  meta?: TokenMeta;
  state?: AmmoraV4LaunchCurveState;
  enrichError?: string;
};

const ENRICH_CONCURRENCY = 4;

/**
 * Numeric scan progress. `scannedTo` is the highest block confirmed scanned
 * (parallel workers finish ranges out of order, so the raw callback value
 * is not monotonic — the max is tracked). `found` counts launches found so
 * far including any loaded from cache.
 */
type ScanProgress = { start: bigint; scannedTo: bigint; head: bigint; found: number };

export function Explorer({ onTrade }: { onTrade: (launch: EnrichedLaunch) => void }) {
  const client = getPublicClient();
  const [launches, setLaunches] = useState<LaunchRecord[]>([]);
  const [enriched, setEnriched] = useState<Map<string, EnrichedLaunch>>(new Map());
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const [hasScanned, setHasScanned] = useState(false);
  const [enriching, setEnriching] = useState(false);
  const [enrichedCount, setEnrichedCount] = useState(0);
  // Total for the enrichment run in progress. The denominator must come
  // from the run itself, not launches.length: on Full rescan the list is
  // cleared (length 0) while the stale enriching flag and count from the
  // previous run were still set, which rendered "7/0".
  const [enrichTotal, setEnrichTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | 1 | 2 | 3>("all");
  const abortRef = useRef(false);

  const scan = useCallback(
    async (forceRescan: boolean) => {
      setScanning(true);
      setError(null);
      abortRef.current = false;
      try {
        const cached = forceRescan ? null : loadLaunchCache(CORE.launchFactory);
        const fromBlock = cached ? BigInt(cached.scannedTo) + 1n : DEPLOYMENT_START_BLOCK;
        const existing = cached ? cached.launches : [];
        if (cached) setHasScanned(true);
        setLaunches(existing);
        setScanProgress({ start: fromBlock, scannedTo: fromBlock, head: fromBlock, found: existing.length });
        const { launches: fresh, scannedTo } = await discoverLaunches(
          client,
          fromBlock,
          (to, head, found) =>
            setScanProgress((prev) => {
              const base = prev ?? { start: fromBlock, scannedTo: fromBlock, head, found: existing.length };
              return {
                start: base.start,
                scannedTo: to > base.scannedTo ? to : base.scannedTo,
                head,
                found: existing.length + found,
              };
            }),
        );
        if (abortRef.current) return;
        const byCurve = new Map<string, LaunchRecord>();
        for (const l of [...existing, ...fresh]) byCurve.set(l.curve.toLowerCase(), l);
        const merged = [...byCurve.values()].sort((a, b) => (a.blockNumber < b.blockNumber ? 1 : -1));
        setLaunches(merged);
        saveLaunchCache({ launches: merged, scannedTo: scannedTo.toString(), factory: CORE.launchFactory, savedAt: Date.now() });
        setHasScanned(true);
      } catch (e) {
        setError(describeError(e));
      } finally {
        setScanning(false);
      }
    },
    [client],
  );

  useEffect(() => {
    void scan(false);
    return () => {
      abortRef.current = true;
    };
  }, [scan]);

  // Progressive enrichment: token metadata + live curve state, newest first.
  useEffect(() => {
    if (launches.length === 0) {
      // A rescan clears the list first: drop the stale enrichment counter
      // and spinner, or the label reads e.g. "7/0" against an empty list.
      setEnrichedCount(0);
      setEnriching(false);
      return;
    }
    let cancelled = false;
    const queue = launches.filter((l) => !enriched.has(l.curve.toLowerCase()));
    if (queue.length === 0) return;
    setEnrichTotal(queue.length);
    setEnriching(true);
    setEnrichedCount(0);
    let done = 0;
    const run = async () => {
      const block = await client.getBlockNumber().catch(() => null);
      if (block === null || cancelled) {
        setEnriching(false);
        return;
      }
      const workers = Array.from({ length: ENRICH_CONCURRENCY }, async () => {
        while (queue.length > 0 && !cancelled) {
          const launch = queue.shift();
          if (!launch) break;
          try {
            const [meta, state] = await Promise.all([
              getTokenMeta(client, launch.token),
              getCurveState(client, launch.curve, block).catch((e) => {
                throw new Error(`curve read failed: ${describeError(e)}`);
              }),
            ]);
            if (cancelled) break;
            setEnriched((prev) => {
              const next = new Map(prev);
              next.set(launch.curve.toLowerCase(), { ...launch, meta, state });
              return next;
            });
          } catch (e) {
            if (cancelled) break;
            setEnriched((prev) => {
              const next = new Map(prev);
              next.set(launch.curve.toLowerCase(), { ...launch, enrichError: describeError(e) });
              return next;
            });
          }
          done += 1;
          setEnrichedCount(done);
        }
      });
      await Promise.all(workers);
      if (!cancelled) setEnriching(false);
    };
    void run();
    return () => {
      cancelled = true;
      // The run is dead when the list changes (e.g. Full rescan clears it):
      // drop the spinner immediately instead of leaving a stale
      // "enriching" flag and count behind until the next run finishes.
      setEnriching(false);
    };
  }, [launches]);

  const rows: EnrichedLaunch[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    return launches
      .map((l): EnrichedLaunch => ({ ...l, ...enriched.get(l.curve.toLowerCase()) }))
      .filter((l) => {
        if (statusFilter !== "all" && l.state?.status !== statusFilter) return false;
        if (!q) return true;
        return (
          l.meta?.name.toLowerCase().includes(q) ||
          l.meta?.symbol.toLowerCase().includes(q) ||
          l.token.toLowerCase().includes(q) ||
          l.curve.toLowerCase().includes(q) ||
          l.creator.toLowerCase().includes(q)
        );
      });
  }, [launches, enriched, query, statusFilter]);

  const activeCount = useMemo(
    () => [...enriched.values()].filter((l) => l.state?.status === 1).length,
    [enriched],
  );
  const graduatedCount = useMemo(
    () => [...enriched.values()].filter((l) => l.state?.status === 3).length,
    [enriched],
  );

  // While the first scan is still running with nothing loaded yet, never
  // report "0 found" — a new visitor reads that as "no launches exist".
  const subtitle =
    scanning && launches.length === 0
      ? "Still scanning the chain for launches — results appear below as they're found."
      : `Live launches discovered on-chain from the Ammora V4 factory. ${launches.length} found · ${activeCount} active · ${graduatedCount} graduated`;

  return (
    <Card
      title="Explore launches"
      subtitle={subtitle}
      actions={
        <>
          <button type="button" className="btn btn-small" disabled={scanning} onClick={() => void scan(false)}>
            {scanning ? "Scanning…" : "Refresh"}
          </button>
          <button
            type="button"
            className="btn btn-small btn-ghost"
            disabled={scanning}
            onClick={() => {
              clearLaunchCache();
              setEnriched(new Map());
              void scan(true);
            }}
          >
            Full rescan
          </button>
        </>
      }
    >
      {error ? <ErrorBox message={error} onRetry={() => void scan(false)} /> : null}
      {scanning && launches.length > 0 ? (
        <p className="muted">
          <Spinner
            label={
              scanProgress
                ? `Scanning blocks … ${scanProgress.scannedTo.toLocaleString()} / ${scanProgress.head.toLocaleString()} · ${scanProgress.found} found`
                : "Scanning factory logs…"
            }
          />
        </p>
      ) : null}
      {enriching && enrichTotal > 0 ? (
        <p className="muted">
          <Spinner label={`Loading token + curve details… ${enrichedCount}/${enrichTotal}`} />
        </p>
      ) : null}

      <div className="filters">
        <input
          className="input"
          placeholder="Search name, symbol, token, curve or creator…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          className="input"
          value={String(statusFilter)}
          onChange={(e) => setStatusFilter(e.target.value === "all" ? "all" : (Number(e.target.value) as 1 | 2 | 3))}
        >
          <option value="all">All statuses</option>
          <option value="1">Active</option>
          <option value="2">Ready to migrate</option>
          <option value="3">Graduated</option>
        </select>
      </div>

      {scanning && launches.length === 0 ? (
        <div className="preview">
          <p>
            <Spinner label="Still scanning — launches appear here as they're found." />
          </p>
          {scanProgress && scanProgress.head > scanProgress.start ? (
            <>
              <ProgressBar
                value={scanProgress.scannedTo - scanProgress.start}
                max={scanProgress.head - scanProgress.start}
                label={`Block ${scanProgress.scannedTo.toLocaleString()} of ${scanProgress.head.toLocaleString()}`}
              />
              <p className="muted small">
                Block {scanProgress.scannedTo.toLocaleString()} / {scanProgress.head.toLocaleString()} ·{" "}
                {scanProgress.found} launch{scanProgress.found === 1 ? "" : "es"} found so far
              </p>
            </>
          ) : (
            <p className="muted small">Reading the chain head…</p>
          )}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          title={launches.length === 0 && hasScanned ? "No launches found yet" : "No launches match"}
          body={
            launches.length === 0 && hasScanned
              ? "The scan finished and no tokens have been launched on this factory yet. Launch the first one with the Launch Studio."
              : "Try a different search, or launch the first token with the Launch Studio."
          }
        />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Token</th>
                <th>Curve</th>
                <th>Config</th>
                <th>Status</th>
                <th>WETH reserve</th>
                <th>Graduation</th>
                <th>Creator</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((l) => (
                <tr key={l.curve}>
                  <td>
                    <span className="token-cell">
                      <TokenIcon address={l.token} size={26} />
                      <span>
                        {l.meta ? (
                          <span>
                            <strong>{l.meta.name}</strong> <span className="muted">${l.meta.symbol}</span>
                          </span>
                        ) : (
                          <AddressLink address={l.token} />
                        )}
                        <div className="muted small mono">{l.token.slice(0, 10)}…</div>
                      </span>
                    </span>
                  </td>
                  <td>
                    <AddressLink address={l.curve} />
                  </td>
                  <td className="mono">#{l.configId.toString()}</td>
                  <td>
                    {l.state ? (
                      <StatusBadge status={l.state.status} />
                    ) : l.enrichError ? (
                      <span className="muted small">unreadable</span>
                    ) : (
                      <Spinner />
                    )}
                  </td>
                  <td className="mono">
                    {l.state ? `${fmt(l.state.quoteReserve, 18, 4)} WETH` : "—"}
                  </td>
                  <td style={{ minWidth: 140 }}>
                    {l.state ? (
                      <ProgressBar value={l.state.quoteReserve} max={l.state.migrationQuoteThreshold} />
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>
                    <AddressLink address={l.creator} />
                  </td>
                  <td>
                    <button type="button" className="btn btn-small" onClick={() => onTrade(l)}>
                      Trade
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted small">
        WETH: <AddressLink address={WETH as Address} /> · Discovery reads LaunchCreated logs from the
        factory — no indexer, no API key. Cached locally; use Full rescan to rebuild.
      </p>
    </Card>
  );
}
