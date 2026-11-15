// Agent Games endpoint — Proof Gatekeeper (+ Steal the VFY skeleton)
// Node >= 20, no framework. Secrets ONLY from env: AGENT_GAMES_HMAC_SECRET.
// Fail closed: any error/uncertainty on a Gatekeeper task -> REJECT, never approve by default.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as snarkjs from 'snarkjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(DIR, '..');
const PORT = process.env.PORT || 8790;
const SECRET = process.env.AGENT_GAMES_HMAC_SECRET || '';
const STATE_FILE = path.join(DIR, 'state.json');
const FIELD_P = BigInt('21888242871839275222246405745257275088548364400416034343698204186575808495617');

const GK_WASM = path.join(ROOT, 'circuits', 'gatekeeper.wasm');
const GK_ZKEY = path.join(ROOT, 'circuits', 'gatekeeper_final.zkey');

let state = { seenProofs: {}, taskCache: {} };
try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch {}
function persist() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state), { mode: 0o600 });
}

function hmacHex(data) {
  return crypto.createHmac('sha256', SECRET).update(data).digest('hex');
}
function signOk(rawBody, headerVal) {
  if (!SECRET) return true; // local dev only
  if (!headerVal) return false;
  const expected = hmacHex(rawBody);
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(headerVal)));
  } catch { return false; }
}
function sendSigned(res, obj) {
  const body = JSON.stringify(obj);
  const headers = { 'content-type': 'application/json' };
  if (SECRET) headers['x-agent-games-signature'] = hmacHex(body);
  res.writeHead(200, headers);
  res.end(body);
  return body;
}
// Deterministic field-element derivation for the circuit's taskId signal.
// ASSUMPTION (validate in practice mode): sha256(task_id) mod p.
function taskIdField(taskId) {
  const h = crypto.createHash('sha256').update(String(taskId)).digest('hex');
  return (BigInt('0x' + h) % FIELD_P).toString();
}
function randomSalt() {
  return (BigInt('0x' + crypto.randomBytes(31).toString('hex')) % FIELD_P).toString();
}

async function decideGatekeeper(task) {
  const inp = task.input || {};
  const taskId = String(task.task_id || '');
  if (taskId && state.taskCache[taskId]) return { cached: state.taskCache[taskId] };

  const registeredVk = String(inp.registered_vk || '').toLowerCase();
  const proofVk = String(inp.proof_vk || '').toLowerCase();
  const proofTx = String(inp.proof_tx || '');

  let decision, reason;
  if (proofVk !== registeredVk) {
    decision = 'REJECT'; reason = 'VK_SUBSTITUTION';
  } else if (proofTx && state.seenProofs[proofTx]) {
    decision = 'REJECT'; reason = 'PROOF_REUSED';
  } else if (BigInt(inp.public_balance) < BigInt(inp.minimum)) {
    decision = 'REJECT'; reason = 'THRESHOLD_MISMATCH';
  } else if (BigInt(inp.current_block) > BigInt(inp.expiry_block)) {
    decision = 'REJECT'; reason = 'EXPIRED_CONDITION';
  } else if (String(inp.recipient).toLowerCase() !== String(inp.condition_recipient).toLowerCase()) {
    decision = 'REJECT'; reason = 'RECIPIENT_MISMATCH';
  } else if (BigInt(inp.amount) > BigInt(inp.max_transfer)) {
    decision = 'REJECT'; reason = 'AMOUNT_OVERFLOW';
  } else {
    decision = 'APPROVE'; reason = 'VALID_CONDITION';
  }

  let response;
  if (reason === 'PROOF_REUSED') {
    // Scoring excludes reused-proof tasks from the proof bonus; return the decision alone.
    response = { decision, reason_code: reason, proof_tx: proofTx };
  } else {
    const circuitInput = {
      registeredVkHash: registeredVk,
      proofVkHash: proofVk,
      minimum: String(inp.minimum),
      publicBalance: String(inp.public_balance),
      expiryBlock: String(inp.expiry_block),
      currentBlock: String(inp.current_block),
      recipient: String(inp.recipient),
      conditionRecipient: String(inp.condition_recipient),
      amount: String(inp.amount),
      maxTransfer: String(inp.max_transfer),
      decision: decision === 'APPROVE' ? '1' : '0',
      taskId: taskIdField(taskId),
      salt: randomSalt(),
    };
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(circuitInput, GK_WASM, GK_ZKEY);
    response = { decision, reason_code: reason, proof, public_signals: publicSignals };
  }

  if (proofTx) state.seenProofs[proofTx] = taskId;
  if (taskId) state.taskCache[taskId] = response;
  persist();
  return { cached: response };
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const raw = Buffer.concat(chunks);
    try {
      if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, agent: 'kamala-07', events: ['proof-gatekeeper', 'steal-the-vfy'] }));
        return;
      }
      if (req.method !== 'POST') { res.writeHead(404); res.end('not found'); return; }
      if (!signOk(raw, req.headers['x-agent-games-signature'])) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'bad signature' }));
        return;
      }
      const body = JSON.parse(raw.toString('utf8'));
      const type = String(body.type || '');

      if (type.includes('preflight') || body.kind === 'preflight') {
        sendSigned(res, { ok: true, protocolVersion: 'v1' });
        return;
      }
      if (type === 'agent-games.proof-gatekeeper.v1' || body.input) {
        const { cached } = await decideGatekeeper(body);
        sendSigned(res, cached);
        return;
      }
      if (type.includes('steal') || type.includes('vfy')) {
        // Steal the VFY turn handling: proof/policy wiring lands after the
        // vfy-policy circuit signals are probed. Fail safe = HOLD, no amount.
        sendSigned(res, {
          matchId: body.matchId ?? body.match_id ?? null,
          turn: body.turn ?? null,
          action: { type: 'HOLD' },
          idempotencyKey: body.idempotencyKey ?? body.idempotency_key ?? null,
        });
        return;
      }
      // Unknown envelope: fail closed.
      sendSigned(res, { ok: false, error: 'unknown envelope type' });
    } catch (e) {
      console.error('handler error:', e && e.message);
      // Fail closed for task-like posts: REJECT without proof rather than crash.
      try {
        sendSigned(res, { decision: 'REJECT', reason_code: 'INTERNAL_ERROR' });
      } catch { res.writeHead(500); res.end('error'); }
    }
  });
});
server.listen(PORT, () => console.log(`agent endpoint listening on :${PORT} (hmac ${SECRET ? 'on' : 'OFF-dev'})`));
