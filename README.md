# KAMALA-07 — zkVerify Agent Games agent

Public endpoint agent for the zkVerify **Agent Games** (Season 01), entered by
@kamala-07 (X: @kamala_07). One service, two events:

- **Proof Gatekeeper** — receives signed payment-decision tasks, runs a
  deterministic checklist (VK match, threshold, recipient, amount cap, expiry,
  proof reuse), and returns the decision with a locally generated Groth16
  proof (official gatekeeper circuit, snarkjs). The circuit enforces the
  decision: a wrong APPROVE or a wrong REJECT cannot even produce a witness.
  Fails closed — errors and uncertainty are REJECT, never a default approval.
- **Steal the VFY** — head-to-head strategy matches with per-turn policy
  proofs against a pre-committed strategy (Poseidon commitment).
  (Entries for the current tournament are locked; the Gatekeeper is live.)

Protocol: HMAC-SHA256 over the raw body (`x-agent-games-signature`) is
verified before parsing; every response is signed the same way. Preflight
answers `{ ok: true, protocolVersion: "v1" }`. Secrets come from environment
variables only (`AGENT_GAMES_HMAC_SECRET`) — never committed.

## Layout

- `agent/server.mjs` — the endpoint (Node, no framework). Live code is here;
  any older top-level copies are stale snapshots.
- `agent/test-local.mjs` — end-to-end local test, 13/13 checks pass:
  preflight, valid APPROVE with a verifying proof, all five reject traps with
  verifying proofs, PROOF_REUSED without a proof, idempotent task retries,
  and 401 on a bad signature.
- `scripts/fetch-circuits.mjs` — downloads the official circuit artifacts
  (`gatekeeper.wasm`, `gatekeeper_final.zkey`) from
  https://agentgames.zkverify.io/circuits into `circuits/` and verifies their
  sizes. They are binary, so they are not committed. `npm start` runs this
  first, then the server. Registered gatekeeper VK hash:
  `0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0`.

## Run / deploy

```text
npm install
AGENT_GAMES_HMAC_SECRET=<secret from the Agent Games dashboard> npm start
# listens on $PORT (default 8790), tasks are POSTed to /agent, GET /health
```

Works as-is on any Node host (Render, Railway, a VPS): set the
`AGENT_GAMES_HMAC_SECRET` environment variable and use `npm start` as the
start command.
