import { useState } from "react";
import { loadMyConfigs, loadMyLaunches } from "../lib/store";
import { AddressLink, Card, EmptyState, TxLink } from "./ui";

export function MyLaunches({ onTrade }: { onTrade: (token: string, curve: string, configId: string, name: string, symbol: string) => void }) {
  const [launches] = useState(loadMyLaunches);
  const [configs] = useState(loadMyConfigs);

  return (
    <div className="stack">
      <Card
        title="My launches"
        subtitle="Tokens you launched from this browser, with their on-chain receipts. Records are stored locally — clearing browser data removes them (the tokens stay on-chain)."
      >
        {launches.length === 0 ? (
          <EmptyState title="No launches yet" body="Launch your first token in the Launch Studio — it will appear here with its receipt." />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Token</th>
                  <th>Curve</th>
                  <th>Config</th>
                  <th>Receipt</th>
                  <th>Launched</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {launches.map((l) => (
                  <tr key={l.curve}>
                    <td>
                      <strong>{l.name}</strong> <span className="muted">${l.symbol}</span>
                      <div className="muted small mono">{l.token.slice(0, 10)}…</div>
                    </td>
                    <td>
                      <AddressLink address={l.curve} />
                    </td>
                    <td className="mono">#{l.configId}</td>
                    <td>
                      <TxLink hash={l.txHash} />
                    </td>
                    <td className="muted small">{new Date(l.createdAt).toLocaleString()}</td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-small"
                        onClick={() => onTrade(l.token, l.curve, l.configId, l.name, l.symbol)}
                      >
                        Trade
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="My Configs" subtitle="Configs you created from this browser. Reuse them for more tokens in the Launch Studio.">
        {configs.length === 0 ? (
          <EmptyState title="No Configs yet" body="Create one in Step 1 of the Launch Studio." />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Config</th>
                  <th>Template</th>
                  <th>Hash</th>
                  <th>Receipt</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {configs.map((c) => (
                  <tr key={c.configId}>
                    <td className="mono">#{c.configId}</td>
                    <td className="mono">#{c.templateId}</td>
                    <td className="mono small">{c.configHash.slice(0, 18)}…</td>
                    <td>
                      <TxLink hash={c.txHash} />
                    </td>
                    <td className="muted small">{new Date(c.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
