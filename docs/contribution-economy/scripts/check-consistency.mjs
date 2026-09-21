import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const map = JSON.parse(await readFile(path.join(root, 'rename-map.json'), 'utf8'));
const files = (await readdir(path.join(root, 'bpmn'))).filter(f => f.endsWith('.bpmn'));

const FORBIDDEN = ['(', ')', 'P(a)', 'N_i', 'alpha_i', 'C_i(', 'Delta C', 'RCT =', '$RCT', 'Tier 0', 'Tier 1', 'Tier 2', 'Tier 3', 'bounty'];
let failed = 0;

for (const f of files) {
  const xml = await readFile(path.join(root, 'bpmn', f), 'utf8');
  const names = [...xml.matchAll(/name="([^"]*)"/g)].map(m => m[1]);
  for (const n of names) {
    for (const bad of FORBIDDEN) {
      if (n.includes(bad)) {
        console.error(`FAIL ${f}: forbidden token "${bad}" in label "${n}"`);
        failed++;
      }
    }
  }
  for (const [oldLabel, entry] of Object.entries(map[f] ?? {})) {
    const newLabel = typeof entry === 'string' ? entry : entry.new;
    if (oldLabel === newLabel) continue; // identity mapping: label intentionally unchanged
    if (xml.includes(`name="${oldLabel}"`)) {
      console.error(`FAIL ${f}: old label still present: "${oldLabel}"`);
      failed++;
    }
  }
  for (const entry of Object.values(map[f] ?? {})) {
    const newLabel = typeof entry === 'string' ? entry : entry.new;
    if (!xml.includes(`name="${newLabel}"`)) {
      console.error(`FAIL ${f}: new label missing: "${newLabel}"`);
      failed++;
    }
  }
}
if (failed === 0) console.log('Consistency check passed: all renames applied, no parentheses or jargon in labels.');
process.exit(failed ? 1 : 0);