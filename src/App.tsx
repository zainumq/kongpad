import { useState } from "react";
import { useWallet } from "./lib/wallet";
import { getWcProjectId } from "./lib/walletconnect";
import { shortAddress } from "./lib/giwa";
import { Explorer, type EnrichedLaunch } from "./components/Explorer";
import { LaunchStudio } from "./components/LaunchStudio";
import { TradePanel } from "./components/TradePanel";
import { FeeDashboard } from "./components/FeeDashboard";
import { MyLaunches } from "./components/MyLaunches";
import { RpcSettings } from "./components/RpcSettings";
import { RpcStatusBanner } from "./components/RpcStatusBanner";
import { WalletConnectSettings } from "./components/WalletConnectSettings";

type Tab = "explore" | "launch" | "trade" | "fees" | "mine";

const TABS: { id: Tab; label: string }[] = [
  { id: "explore", label: "Explore" },
  { id: "launch", label: "Launch Studio" },
  { id: "trade", label: "Trade" },
  { id: "fees", label: "Fee Dashboard" },
  { id: "mine", label: "My Launches" },
];

export default function App() {
  const wallet = useWallet();
  const [tab, setTab] = useState<Tab>("explore");
  const [selected, setSelected] = useState<EnrichedLaunch | null>(null);
  const [studioKey, setStudioKey] = useState(0);

  const goTrade = (launch: EnrichedLaunch) => {
    setSelected(launch);
    setTab("trade");
  };

  return (
    <div className="app">
      <div className="testnet-banner" role="note">
        <strong>GIWA Sepolia testnet only</strong> — test ETH has $0 value. No mainnet, no real funds. Never share a
        private key or seed phrase with any app.
      </div>

      <header className="header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <img src="./kong-mascot.webp" alt="" width={48} height={48} />
          </span>
          <div>
            <span className="season-pill">Season 2</span>
            <h1>
              <span className="brand-name">KongPad</span>{" "}
              <span className="brand-tag">Ammora Launchpad + Fee Dashboard</span>
            </h1>
            <p className="muted">Launch on GIWA. Claim every fee.</p>
          </div>
        </div>
        <div className="wallet-box">
          {wallet.isConnected ? (
            <>
              <span className={`chain-dot ${wallet.isCorrectChain ? "ok" : "bad"}`} />
              <span className="mono">{shortAddress(wallet.address ?? "")}</span>
              {wallet.connectionType === "walletconnect" ? (
                <span className="muted small">via WalletConnect</span>
              ) : null}
              {!wallet.isCorrectChain ? (
                <button type="button" className="btn btn-small btn-primary" onClick={() => void wallet.switchChain()}>
                  Switch to GIWA Sepolia
                </button>
              ) : null}
              <button type="button" className="btn btn-small btn-ghost" onClick={wallet.disconnect}>
                Disconnect
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn btn-primary" disabled={wallet.connecting} onClick={() => void wallet.connect()}>
                {wallet.connecting ? "Connecting…" : "Connect wallet"}
              </button>
              {getWcProjectId() ? (
                <button type="button" className="btn btn-ghost" disabled={wallet.connecting} onClick={() => void wallet.connectWalletConnect()}>
                  {wallet.connecting ? "Connecting…" : "WalletConnect"}
                </button>
              ) : null}
            </>
          )}
        </div>
      </header>
      {wallet.error ? <div className="error-box" role="alert">{wallet.error}</div> : null}
      {!wallet.hasProvider ? (
        <div className="notice">
          No injected wallet detected. Install MetaMask or Rabby, then reload this page — or connect
          a mobile wallet with WalletConnect (set it up in the WalletConnect panel below). Reads work
          without a wallet; trading, launching and claiming need one.
        </div>
      ) : null}

      <RpcStatusBanner />

      <RpcSettings />

      <WalletConnectSettings />

      <nav className="tabs" aria-label="Sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={tab === t.id ? "tab active" : "tab"}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <main>
        {tab === "explore" ? <Explorer onTrade={goTrade} /> : null}
        {tab === "launch" ? (
          <LaunchStudio
            key={studioKey}
            wallet={wallet}
            refreshKey={studioKey}
            onLaunched={(launch) => {
              setSelected(launch);
              setStudioKey((k) => k + 1);
              setTab("trade");
            }}
          />
        ) : null}
        {tab === "trade" ? (
          <TradePanel launch={selected} wallet={wallet} onLaunchChange={setSelected} />
        ) : null}
        {tab === "fees" ? <FeeDashboard wallet={wallet} /> : null}
        {tab === "mine" ? (
          <MyLaunches
            onTrade={(token, curve, configId, name, symbol) =>
              goTrade({
                token: token as `0x${string}`,
                curve: curve as `0x${string}`,
                creator: wallet.address ?? ("0x0000000000000000000000000000000000000000" as `0x${string}`),
                configId: BigInt(configId),
                configHash: "0x",
                metadataURI: "",
                blockNumber: 0n,
                txHash: "0x",
                meta: { name, symbol, decimals: 9 },
              })
            }
          />
        ) : null}
      </main>

      <footer className="footer">
        <p className="muted small">
          KongPad is an independent builder submission for the Ammora Season 2 Builder mission. Built with{" "}
          <code>@ammora-protocol/sdk@0.3.9</code> + <code>viem</code> on GIWA Sepolia (chain 91342). All state is read
          live on-chain; transactions are signed only in your wallet. Docs:{" "}
          <a href="https://ammora-docs.vercel.app" target="_blank" rel="noreferrer" className="link">
            ammora-docs.vercel.app
          </a>{" "}
          · Ammora:{" "}
          <a href="https://ammora.org" target="_blank" rel="noreferrer" className="link">
            ammora.org
          </a>
        </p>
        <p className="muted small">
          Testnet only — $0 value. Config #6 is blocked in this app per Ammora&apos;s graduation-safety notice.
        </p>
      </footer>
    </div>
  );
}
