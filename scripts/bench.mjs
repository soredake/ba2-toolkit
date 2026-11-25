/**
 * Throughput benchmark: extracts a slice of a shipping archive with 1 thread
 * and with the default worker pool, and reports MB/s.
 *
 *   node scripts/bench.mjs [archive.ba2] [filter]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractArchive } from '../dist/index.js';

const DATA_DIR =
  process.env.BA2_DATA ??
  process.env.FO76_DATA ??
  'C:/Program Files (x86)/Steam/steamapps/common/Fallout76/Data';
const archive = process.argv[2] ?? path.join(DATA_DIR, 'SeventySix - Meshes.ba2');
const filter = process.argv[3] ?? 'meshes/architecture/*';

if (!fs.existsSync(archive)) {
  console.error(`archive not found: ${archive}`);
  console.error('usage: node scripts/bench.mjs <archive.ba2> [filter]');
  process.exit(1);
}

const runs = [
  { label: '1 thread ', threads: 1 },
  { label: `${os.availableParallelism()} threads`, threads: os.availableParallelism() },
];

for (const run of runs) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ba2-bench-'));
  const result = await extractArchive(archive, {
    outDir: out,
    filter,
    threads: run.threads,
  });
  const seconds = result.durationMs / 1000;
  const mib = result.bytes / (1024 * 1024);
  console.log(
    `${run.label}: ${result.extracted} files, ${mib.toFixed(1)} MiB in ${seconds.toFixed(2)}s = ${(mib / seconds).toFixed(1)} MiB/s (${result.errors.length} errors)`,
  );
  fs.rmSync(out, { recursive: true, force: true });
}
