/**
 * In-process extraction of a list of archive entries. Shared by the single
 * threaded path and by the worker threads.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Ba2Archive } from './reader.js';
import type { Ba2Entry } from './format.js';
import { normalizeEntryPath } from './reader.js';

export interface EntryExtractionOptions {
  outDir: string;
  /** Flatten directory structure, writing only `basename`. */
  flat: boolean;
  /** Overwrite files that already exist. */
  overwrite: boolean;
  /** Stop at the first failure instead of collecting errors. */
  failFast: boolean;
}

export interface EntryExtractionStats {
  extracted: number;
  skipped: number;
  bytes: number;
  errors: { path: string; message: string }[];
}

export function targetPath(entry: Ba2Entry, options: EntryExtractionOptions): string {
  const relative = options.flat
    ? path.basename(entry.path)
    : normalizeEntryPath(entry.path);
  const resolved = path.resolve(options.outDir, relative);
  const root = path.resolve(options.outDir);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`refusing to write outside the output directory: ${entry.path}`);
  }
  return resolved;
}

export function extractEntries(
  archive: Ba2Archive,
  indices: number[],
  options: EntryExtractionOptions,
  onProgress?: (done: number, bytes: number) => void,
): EntryExtractionStats {
  const stats: EntryExtractionStats = { extracted: 0, skipped: 0, bytes: 0, errors: [] };
  const madeDirs = new Set<string>();
  let processed = 0;

  for (const index of indices) {
    const entry = archive.entries[index];
    if (!entry) continue;
    try {
      const target = targetPath(entry, options);
      const dir = path.dirname(target);
      if (!madeDirs.has(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        madeDirs.add(dir);
      }
      // 'wx' fails on an existing file, so no extra stat is needed when the
      // caller does not want overwrites.
      let fd: number;
      try {
        fd = fs.openSync(target, options.overwrite ? 'w' : 'wx');
      } catch (error) {
        if (!options.overwrite && (error as NodeJS.ErrnoException).code === 'EEXIST') {
          stats.skipped++;
          processed++;
          onProgress?.(processed, stats.bytes);
          continue;
        }
        throw error;
      }
      try {
        const { parts, size } = archive.readEntryParts(entry);
        if (parts.length === 1) {
          fs.writeFileSync(fd, parts[0]!);
        } else {
          fs.writevSync(fd, parts);
        }
        stats.extracted++;
        stats.bytes += size;
      } catch (error) {
        fs.closeSync(fd);
        fd = -1;
        fs.rmSync(target, { force: true });
        throw error;
      } finally {
        if (fd !== -1) fs.closeSync(fd);
      }
    } catch (error) {
      if (options.failFast) throw error;
      stats.errors.push({ path: entry.path, message: (error as Error).message });
    }
    processed++;
    onProgress?.(processed, stats.bytes);
  }

  return stats;
}
