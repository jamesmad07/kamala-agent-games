// Downloads the official gatekeeper circuit artifacts from agentgames.zkverify.io
// into circuits/ (they are binary, so they are not committed to this repo).
// Skips files that are already present with the expected size.
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'circuits');
const BASE = 'https://agentgames.zkverify.io/circuits';
const FILES = [
  ['gatekeeper.wasm', 1755820],
  ['gatekeeper_final.zkey', 309750],
];

await mkdir(DIR, { recursive: true });
for (const [name, size] of FILES) {
  const dest = path.join(DIR, name);
  try {
    const st = await stat(dest);
    if (st.size === size) { console.log(`circuits/${name}: present (${size})`); continue; }
  } catch {}
  const res = await fetch(`${BASE}/${name}`);
  if (!res.ok) throw new Error(`download ${name}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length !== size) throw new Error(`download ${name}: size ${buf.length} != expected ${size}`);
  await writeFile(dest, buf);
  console.log(`circuits/${name}: downloaded (${size})`);
}
