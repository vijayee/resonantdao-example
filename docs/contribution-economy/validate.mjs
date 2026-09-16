import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BpmnModdle } from 'bpmn-moddle';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bpmn');
const files = (await readdir(dir)).filter(f => f.endsWith('.bpmn')).sort();

if (files.length === 0) {
  console.error('No .bpmn files found in', dir);
  process.exit(1);
}

const moddle = new BpmnModdle();

function formatWarning(w) {
  if (w && typeof w.message === 'string' && w.message) return w.message;
  try {
    return JSON.stringify(w);
  } catch {
    return String(w);
  }
}

let failed = 0;
for (const f of files) {
  try {
    const xml = await readFile(path.join(dir, f), 'utf8');
    const { rootElement, warnings } = await moddle.fromXML(xml);
    if (!rootElement || rootElement.$type !== 'bpmn:Definitions') {
      throw new Error(`root is ${rootElement && rootElement.$type}, expected bpmn:Definitions`);
    }
    if (warnings && warnings.length) {
      throw new Error(warnings.map(formatWarning).join('; '));
    }
    console.log(`OK   ${f}`);
  } catch (e) {
    console.error(`FAIL ${f}: ${e.message}`);
    failed++;
  }
}
process.exit(failed ? 1 : 0);
