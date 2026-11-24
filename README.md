# KongPad — Ammora Launchpad + Fee Dashboard

An independent builder submission for the **Ammora Season 2 Builder mission**:
ship an exchange or launchpad with the Ammora SDK. KongPad is a launchpad with
a fee dashboard — the part no other builder has shipped.

**Testnet only (GIWA Sepolia, chain 91342).** Test ETH has $0 value. No mainnet,
no real funds. Never share a private key or seed phrase with any app.

## Features

- **Explore** — live launches discovered on-chain from the Ammora V4 factory
  `LaunchCreated` logs (no indexer, no API key), with token metadata, curve
  status, WETH reserve and graduation progress. Cached locally, refreshable.
- **Launch Studio** — create your own immutable Config from a
  graduation-qualified template (recipients, sale supply and threshold are
  yours; the rest is derived and budget-reconciled), then launch a token +
  bonding curve in one transaction. The signing wallet becomes the Creator.
- **Trade** — buy/sell on the bonding curve with live quotes, slippage control
  and exact approvals; wrap ETH → WETH in-app; final-fill + separate migration
  for graduating curves; post-graduation trading on the ARL pool.
- **Fee Dashboard** — the differentiator. Creator/Partner FeeVault claims per
  fee asset (WETH + launched tokens) with optional separate payout address; LP
  position (Manager NFT) discovery, fee claims, and fee-only delegation
  grant/revoke (permissions 8 / 16).
- **My Launches** — your launches and Configs with on-chain receipts.

## Config policy

Config #6 on this registry is **quarantined by Ammora** (it can sell all base
inventory and fail migration) and is blocked everywhere in this app. Templates
are qualified live against the graduation-readiness invariants from
[docs.ammora.org/ai/launchpad-graduation-safety.md](https://docs.ammora.org/ai/launchpad-graduation-safety.md):

- `totalSupply >= worstCaseCurveBaseSold + grossMigrationBaseRequired + lockedBaseTotal`
- `quoteReserveAfterSurplusAndMigrationFees >= grossMigrationQuoteRequired`

Default template is Config #10 when qualified (it has a historical testnet
graduation); otherwise the lowest qualified id. Derived Configs reserve the
sale allocation, the migration destination base and the locked base, so
invariant 1 holds by construction and is verified again before creation.

## Stack

- React 19 + TypeScript + Vite 6
- `@ammora-protocol/sdk@0.3.9` (exact) + `@ammora-protocol/math@0.3.0` + `viem`
- GIWA Sepolia: RPC `https://sepolia-rpc.giwa.io`, explorer
  `https://sepolia-explorer.giwa.io`

## Develop

```bash
npm install
npm run dev        # http://localhost:5173
npm run typecheck
npm run lint
npm run build      # production build in dist/
```

Read-only on-chain verification (no key, no sends):

```bash
npx tsx scripts/verify-reads.ts
```

It lists every V4 Config with its qualification verdict, discovers all launches
from factory logs, samples curve states/quotes, and smoke-reads the FeeVault.

## Deploy

Pushing to `main` deploys via GitHub Actions to GitHub Pages (see
`.github/workflows/pages.yml`). One-time setup: in the repo settings, enable
Pages with **Source: GitHub Actions**. The build uses a relative base (`./`),
so the same output also works at a domain root (e.g. Vercel).

## Safety notes

- Every write is simulated (`eth_call`) before the wallet signs, uses exact
  (never unlimited) ERC-20 approvals, and is reconciled against its confirmed
  receipt. Token/curve/pool addresses always come from receipts, never from
  predictions.
- The app never sees a private key: all signing happens in the user's injected
  wallet (MetaMask / Rabby).
- Zero-claimable fee rows send no transaction. A successful final fill is never
  re-sent if migration fails — resume with migration only.
