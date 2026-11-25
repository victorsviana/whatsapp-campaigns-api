import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SPECS_DIR = 'specs';
const TESTS_DIR = 'tests';
const CRITERION_ROW = /^\|\s*([A-Z]{3}-\d{2})\s*\|/gm;
const CRITERION_ID = /\b[A-Z]{3}-\d{2}\b/g;

function listFiles(dir: string, suffix: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith(suffix))
    .map((file) => join(dir, file));
}

function specCriteria(): Map<string, string> {
  const criteria = new Map<string, string>();
  for (const file of listFiles(SPECS_DIR, '.md')) {
    for (const match of readFileSync(file, 'utf8').matchAll(CRITERION_ROW)) {
      criteria.set(match[1] as string, file);
    }
  }
  return criteria;
}

function testedCriteria(): Set<string> {
  const ids = new Set<string>();
  for (const file of listFiles(TESTS_DIR, '.test.ts')) {
    for (const match of readFileSync(file, 'utf8').matchAll(CRITERION_ID)) {
      ids.add(match[0]);
    }
  }
  return ids;
}

const prefixes = process.argv.slice(2).map((prefix) => prefix.toUpperCase());
const tested = testedCriteria();
const criteria = [...specCriteria()].filter(
  ([id]) => prefixes.length === 0 || prefixes.some((prefix) => id.startsWith(`${prefix}-`)),
);
const missing = criteria.filter(([id]) => !tested.has(id));

console.log(`${criteria.length - missing.length}/${criteria.length} critérios com teste`);
for (const [id, file] of missing) {
  console.log(`  sem teste: ${id} (${file})`);
}
process.exitCode = missing.length > 0 ? 1 : 0;
