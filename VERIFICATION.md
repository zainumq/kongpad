# Verification record — KongPad

Read-only on-chain verification, GIWA Sepolia (chain 91342), 24 Nov 2026.
Script: `scripts/verify-reads.ts` (no private key, no sends).

## Run 2 — 24 Nov 2026 (~08:00 WIB), exit 0

- Slot `v4-auto-route-20260917`, startBlock 36220000, finalized head 42134193.
- Core verification (`verifyAmmoraV4CoreAtBlock`): OK.
- Factory `0x35353a2Dab7426EcCAe6f5FB267702a542ab68fA`,
  FeeVault `0x414Be4a093fDFd7292dCa95C4D6fdD3905Ee6800`,
  WETH `0x4200000000000000000000000000000000000006`.

### Configs (88 total, nextConfigId=89)

- **80 QUALIFIED** (enabled, concentrated mode 0, WETH quote, derived-budget
  surplus 0 on the 1,000,000-token / 0.05-WETH probe).
- 7 not qualified: #7, #8, #9 disabled on-chain; #5, #11, #16, #77 compounding
  (migrationMode=1).
- **#6 BLOCKED** — quarantined by Ammora and now `enabled=false` on-chain.
- Default template **#10 QUALIFIED** (creatorShare 8000 = 80%, same hash family
  as #4); a #10 launch in the sample set is already Migrated (status 3) with a
  live pool — the historical graduation example.

### Launch discovery (factory `LaunchCreated` logs, 10k-block chunks)

- **172 launches** discovered, configs #1–#87. Largest: #6 (23, historical),
  #30 (18), #1 (17), #67 (17), #10 (5).

### Sample curves (12 sampled)

- 7 Active (status 1), 5 Migrated (status 3) with live pools.
- Live buy quotes (0.001 WETH) returned for all 7 active curves
  (e.g. #1 curve → out 987,499,855,646,210 base, fee 0.0000125 WETH, left 0).

### FeeVault

- `claimable(WETH, 0x000…000)` = 0 — smoke read OK.

## Build / quality gates (24 Nov 2026)

- `npm run typecheck` — clean.
- `npm run lint` — clean.
- `npm run build` — passes (Vite 6.4.6; main bundle 1,110.85 kB / 274.73 kB
  gzip; chunk-size warning only).
- `vite preview` smoke test — index, JS and CSS all HTTP 200.

## Not yet verified — needs a live funded testnet wallet

All sends: create Config, createLaunch (+ optional first buy), curve buy/sell,
wrap ETH→WETH, final-fill + migrate, FeeVault claims (Creator/Partner, optional
payout address), LP fee claims, fee-delegate grant/revoke. The app simulates
every send before signing, but the full flow has not been executed end-to-end.
