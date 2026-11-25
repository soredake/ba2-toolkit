/**
 * Parallel extraction driver: splits the selected entries across worker
 * threads and merges their statistics.
 */
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { Ba2Archive } from './reader.js';
import { extractEntries, type EntryExtractionStats } from './extract-entries.js';
import type { Ba2Entry } from './format.js';

export interface ExtractOptions {
  outDir: string;
  /** Only extract paths matching this pattern. Supports `*` and `?`. */
  filter?: string;
  /** Worker threads; defaults to the available parallelism (capped at 8). */
  threads?: number;
  /** Extract only, without writing anything (validates payloads). */
  dryRun?: boolean;
  overwrite?: boolean;
  flat?: boolean;
  failFast?: boolean;
  onProgress?: (progress: ExtractProgress) => void;
}

export interface ExtractProgress {
  done: number;
  total: number;
  bytes: number;
}

export interface ExtractResult extends EntryExtractionStats {
  archive: string;
  total: number;
  selected: number;
  threads: number;
  durationMs: number;
}

/** Compiles a simple case-insensitive glob (`*` = any run of characters). */
export function compileFilter(pattern: string | undefined): (entry: Ba2Entry) => boolean {
  if (!pattern) return () => true;
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  const expression = new RegExp(`^${source}$`, 'i');
  return (entry) => expression.test(entry.path) || expression.test(entry.path.replace(/\//g, '\\'));
}

export async function extractArchive(
  archivePath: string,
  options: ExtractOptions,
): Promise<ExtractResult> {
  const started = Date.now();
  const archive = Ba2Archive.open(archivePath);
  let indices: number[];
  let total: number;
  try {
    const matches = compileFilter(options.filter);
    indices = archive.entries.filter(matches).map((entry) => entry.index);
    total = archive.entries.length;
  } finally {
    archive.close();
  }

  const threads = Math.min(
    Math.max(1, options.threads ?? Math.min(availableParallelism(), 8)),
    Math.max(1, indices.length),
  );
  const entryOptions = {
    outDir: options.outDir,
    flat: options.flat ?? false,
    overwrite: options.overwrite ?? false,
    failFast: options.failFast ?? false,
  };

  let stats: EntryExtractionStats;
  if (options.dryRun) {
    stats = dryRun(archivePath, indices, options.onProgress);
  } else if (threads === 1) {
    const single = Ba2Archive.open(archivePath);
    try {
      stats = extractEntries(single, indices, entryOptions, (done, bytes) => {
        options.onProgress?.({ done, total: indices.length, bytes });
      });
    } finally {
      single.close();
    }
  } else {
    stats = await runPool(archivePath, indices, entryOptions, threads, options.onProgress);
  }

  return {
    ...stats,
    archive: archivePath,
    total,
    selected: indices.length,
    threads: options.dryRun ? 0 : threads,
    durationMs: Date.now() - started,
  };
}

function dryRun(
  archivePath: string,
  indices: number[],
  onProgress: ExtractOptions['onProgress'],
): EntryExtractionStats {
  const archive = Ba2Archive.open(archivePath);
  const stats: EntryExtractionStats = { extracted: 0, skipped: 0, bytes: 0, errors: [] };
  try {
    indices.forEach((index, position) => {
      const entry = archive.entries[index];
      if (!entry) return;
      try {
        const { size } = archive.readEntryParts(entry);
        stats.extracted++;
        stats.bytes += size;
      } catch (error) {
        stats.errors.push({ path: entry.path, message: (error as Error).message });
      }
      if (position % 16 === 0 || position === indices.length - 1) {
        onProgress?.({ done: position + 1, total: indices.length, bytes: stats.bytes });
      }
    });
  } finally {
    archive.close();
  }
  return stats;
}

async function runPool(
  archivePath: string,
  indices: number[],
  entryOptions: ExtractOptions & { outDir: string },
  threads: number,
  onProgress: ExtractOptions['onProgress'],
): Promise<EntryExtractionStats> {
  const buckets: number[][] = Array.from({ length: threads }, () => []);
  // Interleave large and small files so workers finish at roughly the same time.
  indices.forEach((index, position) => buckets[position % threads]!.push(index));

  const totals: EntryExtractionStats = { extracted: 0, skipped: 0, bytes: 0, errors: [] };
  let done = 0;

  await Promise.all(
    buckets.map(
      (bucket, workerIndex) =>
        new Promise<void>((resolve, reject) => {
          const worker = new Worker(new URL('./worker.js', import.meta.url), {
            workerData: {
              archivePath,
              indices: bucket,
              options: {
                outDir: entryOptions.outDir,
                flat: entryOptions.flat ?? false,
                overwrite: entryOptions.overwrite ?? false,
                failFast: entryOptions.failFast ?? false,
              },
            },
          });
          let settled = false;
          worker.on('message', (message: { type: string; done?: number; bytes?: number; stats?: EntryExtractionStats; message?: string }) => {
            if (message.type === 'progress') {
              onProgress?.({
                done: Math.min(indices.length, done + (message.done ?? 0)),
                total: indices.length,
                bytes: totals.bytes + (message.bytes ?? 0),
              });
            } else if (message.type === 'done' && message.stats) {
              totals.extracted += message.stats.extracted;
              totals.skipped += message.stats.skipped;
              totals.bytes += message.stats.bytes;
              totals.errors.push(...message.stats.errors);
              done += bucket.length;
              settled = true;
              resolve();
            } else if (message.type === 'failed') {
              settled = true;
              reject(new Error(`worker ${workerIndex}: ${message.message}`));
            }
          });
          worker.on('error', (error) => {
            if (!settled) reject(error);
          });
          worker.on('exit', (code) => {
            if (!settled) {
              reject(new Error(`worker ${workerIndex} exited with code ${code}`));
            }
          });
        }),
    ),
  );

  return totals;
}
