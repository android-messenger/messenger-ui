# Phase 2a spike — Signal library feasibility (findings)

**Goal:** de-risk full X3DH + Double Ratchet on a PWA before committing to Phase 2. Isolated
spike (scratchpad, node 22 + WebCrypto), not wired into the app.

## Result: protocol is FEASIBLE on pure JS — 7/7

Tested `@privacyresearch/libsignal-protocol-typescript` (pure TS, no WASM) end-to-end between two
in-memory "devices":

| Check | Result |
|---|---|
| Provision identity + signed prekey + OPK pool (the `POST /v1/keys` shape) | ✅ |
| X3DH session from a fetched prekey **bundle** (offline handshake) | ✅ |
| Double Ratchet — initial (prekey) message + bidirectional steady state | ✅ |
| **Out-of-order** (deliver 5,3,4) — aligned via skipped-message-keys | ✅ |
| **Duplicate/replay** rejected (consumed message key is gone) | ✅ |
| Safety-number fingerprint (Phase 4 verification) | ✅ |

Confirms the design answers to the user's questions:
- Ordering/gaps/dups are handled by the ratchet's built-in `(dh,pn,n)` header + skipped-keys; our
  job is dedup-before-ratchet + a placeholder for gaps beyond `MAX_SKIP`. **No custom sequence numbers.**
- Pure-JS ⇒ **CSP-clean** (no `wasm-unsafe-eval` needed for the crypto).

## Footprint

- Shipped code: ~388 KB raw JS → **~111 KB gz** estimate (roughly doubles our current ~210 KB total).
  Mitigation: the secret-chat feature is opt-in ⇒ **lazy-load** the crypto chunk (`React.lazy` /
  dynamic import) so it never hits the baseline bundle.
- Runtime deps: `curve25519-typescript`, `libsignal-protocol-protobuf-ts`, `base64-js`. 0 npm vulns.

## ⚠️ BLOCKER — license conflict (decision needed before Phase 2b)

`@privacyresearch/libsignal-protocol-typescript` is **GPL-3.0-only**. Bundling it into our app would
force the **whole app under GPL-3.0**, which is **incompatible with our PolyForm Noncommercial 1.0.0**
license. Nearly all Signal implementations are (A)GPL (derivatives of Signal's own GPL code:
`@signalapp/libsignal-client` is AGPL-3.0).

Options (needs the author's call):
1. **Relicense** the app (or a separately-distributed E2EE module) to GPL-3.0 — simplest technically,
   changes the project's license.
2. **License-clean alternative** — e.g. `@matrix-org/olm` (**Apache-2.0**, WASM Double Ratchet). Olm's
   prekey handshake is triple-DH (X3DH-like) but NOT byte-compatible with the key directory's
   X3DH bundle shape → would need an adapter or a directory tweak. Or build X3DH + Double Ratchet on
   `libsodium` (ISC) ourselves — most work, fully license-clean, matches the directory as-is.
3. **Optional separately-distributed module** — ship the GPL crypto as a distinct downloadable unit.

**Recommendation:** option 2 with `libsodium` if we must keep PolyForm Noncommercial and match the
directory's X3DH shape; option 1 if GPL is acceptable (fastest path, reuses this validated library).

Spike script: `scratchpad/signal-spike/spike.mjs` (run: `node spike.mjs`).
