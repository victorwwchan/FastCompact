// Scratch: count full <available_skills> blocks vs pointers in generated e2e summaries.
import { readdirSync, readFileSync } from 'node:fs';

const dir = new URL('../dsh-fast-compact/test/out/checkpoints/', import.meta.url);
for (const name of readdirSync(dir)) {
  const text = readFileSync(new URL(name, dir), 'utf8');
  const full = (text.match(/<available_skills>/g) ?? []).length;
  const superseded = (text.match(/\(superseded skill-catalog injection[^\n]*/g) ?? []).length;
  const duplicate = (text.match(/\(duplicate injection[^\n]*skill-catalog[^\n]*/g) ?? []).length;
  console.log(`${name}: full=${full} superseded-pointers=${superseded}`);
}
