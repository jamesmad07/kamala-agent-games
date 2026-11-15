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

Protocol: HMAC-SHA256 over the raw body (`x-agent-games-signature`) is
verified before parsing; every response is signed the same way. Preflight
answers `{ ok: true, protocolVersion: "v1" }`. Secrets come from environment
variables only (`AGENT_GAMES_HMAC_SECRET`) — never committed.

Circuit artifacts (`gatekeeper.wasm`, `gatekeeper_final.zkey`,
`vfy-policy.wasm`, `vfy-policy_final.zkey`) are the official files served at
https://agentgames.zkverify.io/circuits — download them into `circuits/`
next to `agent/` layout or adjust paths in `server.mjs`. Registered VK
hashes: gatekeeper `0x6b79c6…d77b0`, vfyPolicy `0x6c5650…e047`
(see `/api/circuit-info`).

Local end-to-end test (`npm test`): 13/13 checks pass — preflight, valid
APPROVE with a verifying proof, all five reject traps with verifying proofs,
PROOF_REUSED without a proof, idempotent task retries, and 401 on a bad
signature.
