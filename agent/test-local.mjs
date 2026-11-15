// Local end-to-end harness: replays signed sample envelopes against server.mjs.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import * as snarkjs from 'snarkjs';

const PORT = 8791;
const SECRET = 'test-secret-local';
const BASE = `http://127.0.0.1:${PORT}`;
const VK = JSON.parse(fs.readFileSync(new URL('../circuits/gatekeeper-vk.json', import.meta.url), 'utf8'));
const REG_VK = '0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0';
const ADDR = '0xDe42aBcDe42aBcDe42aBcDe42aBcDe42aBc9f01';

try { fs.unlinkSync(new URL('./state.json', import.meta.url)); } catch {}

const srv = spawn('node', ['server.mjs'], {
  cwd: new URL('.', import.meta.url).pathname,
  env: { ...process.env, PORT: String(PORT), AGENT_GAMES_HMAC_SECRET: SECRET },
  stdio: 'pipe',
});
await new Promise((r) => setTimeout(r, 1200));

function sign(obj) {
  const body = JSON.stringify(obj);
  return { body, sig: crypto.createHmac('sha256', SECRET).update(body).digest('hex') };
}
async function post(obj, sigOverride) {
  const { body, sig } = sign(obj);
  const res = await fetch(`${BASE}/agent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-agent-games-signature': sigOverride ?? sig },
    body,
  });
  const text = await res.text();
  const respSig = res.headers.get('x-agent-games-signature');
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, respSig, rawBody: text };
}
function checkRespSig(r) {
  if (!r.respSig) return false;
  const expected = crypto.createHmac('sha256', SECRET).update(r.rawBody).digest('hex');
  return expected === r.respSig;
}
let pass = 0, fail = 0;
function expect(name, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  cond ? pass++ : fail++;
}

const baseInput = {
  registered_vk: REG_VK, proof_vk: REG_VK, minimum: '1000', public_balance: '1460',
  expiry_block: 8430000, current_block: 8420000, recipient: ADDR, condition_recipient: ADDR,
  amount: '500', max_transfer: '1000', proof_tx: '0xproof0001',
};
function task(id, over = {}) {
  return { type: 'agent-games.proof-gatekeeper.v1', task_id: id, mode: 'practice',
    issued_at: new Date().toISOString(), deadline_at: new Date(Date.now() + 60000).toISOString(),
    input: { ...baseInput, ...over } };
}

// health
{
  const r = await fetch(`${BASE}/health`);
  expect('health 200', r.status === 200);
}
// preflight
{
  const r = await post({ type: 'agent-games.preflight.v1' });
  expect('preflight ok:true + signed', r.json?.ok === true && r.json?.protocolVersion === 'v1' && checkRespSig(r));
}
// valid approve + proof verifies
{
  const r = await post(task('gk_t1'));
  expect('valid -> APPROVE', r.json?.decision === 'APPROVE' && r.json?.reason_code === 'VALID_CONDITION');
  expect('valid response signed', checkRespSig(r));
  const ok = await snarkjs.groth16.verify(VK, r.json.public_signals, r.json.proof);
  expect('valid proof verifies', ok === true);
}
// traps
const traps = [
  ['vk', { proof_vk: '0x1111111111111111111111111111111111111111111111111111111111111111' }, 'VK_SUBSTITUTION'],
  ['threshold', { public_balance: '900' }, 'THRESHOLD_MISMATCH'],
  ['expired', { current_block: 8440000 }, 'EXPIRED_CONDITION'],
  ['recipient', { recipient: '0x1111111111111111111111111111111111111111' }, 'RECIPIENT_MISMATCH'],
  ['overflow', { amount: '1500' }, 'AMOUNT_OVERFLOW'],
];
for (const [name, over, reason] of traps) {
  const r = await post(task(`gk_${name}`, { ...over, proof_tx: `0xproof_${name}` }));
  let okProof = false;
  if (r.json?.proof) okProof = await snarkjs.groth16.verify(VK, r.json.public_signals, r.json.proof);
  expect(`trap ${name} -> REJECT ${reason} + proof verifies`, r.json?.decision === 'REJECT' && r.json?.reason_code === reason && okProof);
}
// proof reused: same proof_tx as gk_t1, new task id
{
  const r = await post(task('gk_t2', {}));
  expect('reused proof_tx -> PROOF_REUSED, no proof', r.json?.reason_code === 'PROOF_REUSED' && !r.json?.proof);
}
// idempotent retry: same task_id returns identical body
{
  const a = await post(task('gk_t1'));
  const b = await post(task('gk_t1'));
  expect('same task_id -> identical response', a.text === b.text);
}
// bad HMAC
{
  const r = await post(task('gk_bad'), 'deadbeef');
  expect('bad HMAC -> 401', r.status === 401);
}

console.log(`\n${pass} passed, ${fail} failed`);
srv.kill();
process.exit(fail ? 1 : 0);
