/** Syntax-check every source file without running it. */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = ['src', 'bin', 'tools', 'scripts', 'public'];
const EXT = new Set(['.js', '.mjs']);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (EXT.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

let failed = 0;
const files = DIRS.flatMap((dir) => {
  const full = path.join(ROOT, dir);
  return fs.existsSync(full) ? walk(full) : [];
});

for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${path.relative(ROOT, file)}`);
    console.error(String(error.stderr || error.message));
  }
}

if (failed) {
  console.error(`\n${failed} file(s) failed`);
  process.exit(1);
}
console.log(`syntax OK: ${files.length} file(s)`);
