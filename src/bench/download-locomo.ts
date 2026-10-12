import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';

// Pinned upstream bytes; no moving-main downloads or implicit dataset changes.
const url = 'https://raw.githubusercontent.com/letslego/locomo/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/data/locomo10.json';
const expected = '79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4';
async function main() {
  const response = await fetch(url,{signal:AbortSignal.timeout(30000)});
  if (!response.ok) throw new Error(`Dataset download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('Dataset checksum mismatch');
  await mkdir('data',{recursive:true});
  await writeFile('data/locomo10.json',bytes);
  console.log(`Saved data/locomo10.json; sha256=${expected}`);
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
