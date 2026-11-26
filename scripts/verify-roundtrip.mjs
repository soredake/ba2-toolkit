// Round-trip a real archive: extract -> recreate -> compare every entry.
//
// Usage: node scripts/verify-roundtrip.mjs <archive.ba2> [--compression zlib|none|lz4] [--version 1|2|3|7|8]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Ba2Archive, createArchive, extractArchive } from '../dist/index.js';

const source = process.argv[2];
const argument = (flag, fallback) => {
  const index = process.argv.indexOf(flag);
  return index === -1 ? fallback : process.argv[index + 1];
};
const compression = argument('--compression', 'zlib');
const version = argument('--version', undefined);
if (!source) {
  console.error('usage: node scripts/verify-roundtrip.mjs <archive.ba2> [--compression zlib|none|lz4] [--version n]');
  process.exit(2);
}

const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ba2-roundtrip-'));
const extractDir = path.join(workRoot, 'extracted');
const rebuiltPath = path.join(workRoot, 'rebuilt.ba2');

const started = Date.now();
const original = Ba2Archive.open(source);
const summary = original.summary();
console.log(
  `${path.basename(source)}: ${summary.header.kind} v${summary.header.version} ` +
    `${summary.fileCount} entries, ${(summary.storedBytes / 1048576).toFixed(1)} MB stored, ` +
    `${(summary.unpackedBytes / 1048576).toFixed(1)} MB unpacked, ` +
    `method ${summary.header.compressionMethod}, ${summary.compressedFiles} compressed`
);
if (summary.nonPcTiling) console.log(`  warning: ${summary.nonPcTiling} Xbox tiled textures cannot be written as DDS`);

const extraction = await extractArchive(source, { outDir: extractDir });
console.log(
  `  extracted ${extraction.extracted} files (${extraction.errors.length} errors, ${extraction.skipped} skipped) in ${Date.now() - started} ms`
);

await createArchive(rebuiltPath, extractDir, {
  compression,
  version: version === undefined ? undefined : Number(version),
});
const rebuiltStat = fs.statSync(rebuiltPath);
console.log(`  rebuilt ${(rebuiltStat.size / 1048576).toFixed(1)} MB with ${compression}`);

const rebuilt = Ba2Archive.open(rebuiltPath);
const mismatches = [];
let compared = 0;
let bytes = 0;
for (const entry of rebuilt.entries) {
  const diskPath = path.join(extractDir, entry.path);
  if (!fs.existsSync(diskPath)) {
    mismatches.push(`${entry.path}: missing on disk`);
    continue;
  }
  const fromDisk = fs.readFileSync(diskPath);
  const fromArchive = rebuilt.readEntry(entry);
  compared++;
  bytes += fromArchive.length;
  if (!fromDisk.equals(fromArchive)) {
    mismatches.push(`${entry.path}: ${fromDisk.length} vs ${fromArchive.length} bytes differ`);
  }
}
rebuilt.close();
original.close();

console.log(`  compared ${compared} entries, ${(bytes / 1048576).toFixed(1)} MB`);
if (mismatches.length > 0) {
  console.error(`FAIL: ${mismatches.length} mismatch(es)`);
  for (const line of mismatches.slice(0, 20)) console.error(`  ${line}`);
  process.exitCode = 1;
} else {
  console.log(`  OK: ${path.basename(source)} round-trips byte-for-byte (${Date.now() - started} ms)`);
  fs.rmSync(workRoot, { recursive: true, force: true });
}
