import type { ReactNode } from "react";
import { explorerAddress, explorerTx, shortAddress } from "../lib/giwa";
import type { ClassifiedWalletError } from "../lib/walletError";

export function Card({ title, subtitle, children, actions }: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>{title}</h2>
          {subtitle ? <p className="muted">{subtitle}</p> : null}
        </div>
        {actions ? <div className="card-actions">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function AddressLink({ address, label }: { address: string; label?: string }) {
  return (
    <a href={explorerAddress(address)} target="_blank" rel="noreferrer" className="mono link">
      {label ?? shortAddress(address)}
    </a>
  );
}

export function TxLink({ hash, label }: { hash: string; label?: string }) {
  return (
    <a href={explorerTx(hash)} target="_blank" rel="noreferrer" className="mono link">
      {label ?? shortAddress(hash)}
    </a>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="spinner" role="status">
      <span className="spinner-dot" />
      {label ? <span className="muted">{label}</span> : null}
    </span>
  );
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="error-box" role="alert">
      <span>{message}</span>
      {onRetry ? (
        <button type="button" className="btn btn-small" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}

/**
 * Wallet-action failure box: the classified message, concrete recovery
 * steps for the failure kind, and a Retry button that re-triggers the
 * same action. The no-response steps matter most — a popup that never
 * appeared leaves a request queued in MetaMask, so the user must settle
 * it before retrying, or the same transaction can be sent twice.
 */
export function WalletErrorBox({ error, onRetry }: { error: ClassifiedWalletError; onRetry?: () => void }) {
  return (
    <div className="wallet-error" role="alert">
      <div className="error-box">
        <span>{error.message}</span>
      </div>
      {error.kind === "no-response" ? (
        <ol className="wallet-hint">
          <li>Click the MetaMask icon in your browser toolbar — a pending request may be waiting there.</li>
          <li>If a request is pending, confirm or reject it first, so retrying does not send the same transaction twice.</li>
          <li>If no popup appears at all, reload the page and try again.</li>
        </ol>
      ) : error.kind === "rejected" ? (
        <p className="wallet-hint">Nothing was sent. Retry whenever you are ready.</p>
      ) : (
        <p className="wallet-hint">If a transaction was submitted, check the explorer before retrying.</p>
      )}
      {onRetry ? (
        <button type="button" className="btn btn-small" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}

export function EmptyState({ title, body }: { title: string; body?: string }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {body ? <p className="muted">{body}</p> : null}
    </div>
  );
}

export function StatusBadge({ status }: { status: number }) {
  const map: Record<number, { label: string; cls: string }> = {
    0: { label: "Uninitialized", cls: "badge-gray" },
    1: { label: "Active", cls: "badge-green" },
    2: { label: "Ready to migrate", cls: "badge-amber" },
    3: { label: "Graduated", cls: "badge-blue" },
  };
  const s = map[status] ?? { label: `Status ${status}`, cls: "badge-gray" };
  return <span className={`badge ${s.cls}`}>{s.label}</span>;
}

export function ProgressBar({ value, max, label }: { value: bigint; max: bigint; label?: string }) {
  const pct = max > 0n ? Math.min(100, Number((value * 10_000n) / max) / 100) : 0;
  return (
    <div className="progress" title={label ?? `${pct.toFixed(1)}%`}>
      <div className="progress-fill" style={{ width: `${pct}%` }} />
      <span className="progress-label">{pct.toFixed(1)}%</span>
    </div>
  );
}

export function TxStatus({ status, hash }: { status: string | null; hash: string | null }) {
  if (!status && !hash) return null;
  return (
    <div className="tx-status">
      {status ? <p>{status}</p> : null}
      {hash ? (
        <p>
          Tx: <TxLink hash={hash} />
        </p>
      ) : null}
    </div>
  );
}

/**
 * Page controls for `usePagination` (see ../lib/pagination). Hidden when
 * everything fits on one page.
 */
export function Pagination({
  page,
  pageCount,
  total,
  pageSize,
  onPage,
}: {
  page: number;
  pageCount: number;
  total: number;
  pageSize: number;
  onPage: (page: number) => void;
}) {
  if (pageCount <= 1) return null;
  const start = (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);
  return (
    <div className="pagination">
      <button
        type="button"
        className="btn btn-small btn-ghost"
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
      >
        ← Prev
      </button>
      <span className="muted small">
        Showing {start}–{end} of {total} · Page {page} of {pageCount}
      </span>
      <button
        type="button"
        className="btn btn-small btn-ghost"
        disabled={page >= pageCount}
        onClick={() => onPage(page + 1)}
      >
        Next →
      </button>
    </div>
  );
}
