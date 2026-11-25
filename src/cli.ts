#!/usr/bin/env node
/**
 * Command line interface: info / list / extract.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { Ba2Archive } from './ba2/reader.js';
import { compileFilter, extractArchive } from './ba2/extract.js';
import { dxgiFormatName } from './ba2/dxgi.js';
import { entryCompression, entryUnpackedSize } from './ba2/format.js';

const HELP = `ba2 - Fallout 76 / Fallout 4 BA2 (BTDX) archive tool

Usage:
  ba2 info <archive.ba2...>
  ba2 list <archive.ba2...> [--filter <glob>] [--json] [--limit <n>]
  ba2 extract <archive.ba2...> --out <dir> [options]

Options:
  -o, --out <dir>     Output directory (required for extract).
      --filter <g>    Only entries whose path matches the glob (case-insensitive,
                      '*' matches across directories). Quote it in your shell.
      --threads <n>   Worker threads (default: available parallelism, max 8).
      --flat          Write only file names, ignoring directory structure.
      --force         Overwrite existing files.
      --dry-run       Read and decompress everything, write nothing.
      --json          Machine readable output (list/info).
      --limit <n>     Limit listed entries.
  -h, --help          Show this help.
  -v, --version       Show the version.

When several archives are given, each is extracted into its own subdirectory
named after the archive. A single archive is extracted straight into --out.

Examples:
  ba2 info "C:/Program Files (x86)/Steam/steamapps/common/Fallout76/Data/SeventySix - Textures01.ba2"
  ba2 extract "SeventySix - Meshes.ba2" -o out --filter "*.nif" --threads 8
  ba2 list "SeventySix - Materials.ba2" --filter "*.bgsm" --limit 20
`;

function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(2)} ${units[unit]}`;
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function archiveName(file: string): string {
  return path.basename(file).replace(/\.ba2$/i, '');
}

function main(): void {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (!command || command === '-h' || command === '--help') {
    process.stdout.write(HELP);
    return;
  }
  if (command === '-v' || command === '--version') {
    process.stdout.write(`${version()}\n`);
    return;
  }

  const { values, positionals } = parseArgs({
    args: argv.slice(1),
    allowPositionals: true,
    options: {
      out: { type: 'string', short: 'o' },
      filter: { type: 'string' },
      threads: { type: 'string' },
      flat: { type: 'boolean' },
      force: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      json: { type: 'boolean' },
      limit: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  const archives = positionals;
  if (archives.length === 0) fail('error: no archive given (see ba2 --help)');

  switch (command) {
    case 'info':
      info(archives, Boolean(values.json));
      return;
    case 'list':
      list(archives, {
        filter: values.filter,
        json: Boolean(values.json),
        limit: values.limit ? Number(values.limit) : undefined,
      });
      return;
    case 'extract':
      void extract(archives, {
        out: values.out,
        filter: values.filter,
        threads: values.threads ? Number(values.threads) : undefined,
        flat: Boolean(values.flat),
        force: Boolean(values.force),
        dryRun: Boolean(values['dry-run']),
      });
      return;
    default:
      fail(`error: unknown command ${JSON.stringify(command)} (see ba2 --help)`);
  }
}

function version(): string {
  return '0.1.0';
}

function info(archives: string[], json: boolean): void {
  const summaries = archives.map((file) => {
    const archive = Ba2Archive.open(file);
    try {
      return archive.summary();
    } finally {
      archive.close();
    }
  });

  if (json) {
    process.stdout.write(`${JSON.stringify(summaries, null, 2)}\n`);
    return;
  }

  summaries.forEach((summary, index) => {
    if (index > 0) process.stdout.write('\n');
    const h = summary.header;
    process.stdout.write(`${summary.path}\n`);
    process.stdout.write(`  format     : ${h.kind}, version ${h.version}\n`);
    process.stdout.write(`  files      : ${summary.fileCount}\n`);
    process.stdout.write(
      `  payload    : ${formatBytes(summary.unpackedBytes)} unpacked, ${formatBytes(summary.storedBytes)} stored\n`,
    );
    process.stdout.write(
      `  compressed : ${summary.compressedFiles} payload block(s) zlib\n`,
    );
    if (summary.extensions.length > 0) {
      const list = summary.extensions
        .slice(0, 8)
        .map((item) => `${item.extension || '(none)'} ${item.count}`)
        .join(', ');
      process.stdout.write(`  extensions : ${list}\n`);
    }
    if (summary.formats.length > 0) {
      const list = summary.formats
        .slice(0, 8)
        .map((item) => `${item.name} ${item.count}`)
        .join(', ');
      process.stdout.write(`  textures   : ${list}\n`);
      if (summary.cubemaps > 0) process.stdout.write(`  cubemaps   : ${summary.cubemaps}\n`);
      if (summary.nonPcTiling > 0) {
        process.stdout.write(
          `  warning    : ${summary.nonPcTiling} Xbox tiled texture(s) cannot be written as DDS\n`,
        );
      }
    }
  });
}

function list(
  archives: string[],
  options: { filter?: string; json: boolean; limit?: number },
): void {
  const matches = compileFilter(options.filter);
  const rows: Record<string, unknown>[] = [];
  for (const file of archives) {
    const archive = Ba2Archive.open(file);
    try {
      let printed = 0;
      for (const entry of archive.entries) {
        if (!matches(entry)) continue;
        if (options.limit !== undefined && printed >= options.limit) break;
        printed++;
        const compressed = entryCompression(entry) === 'zlib';
        if (options.json) {
          rows.push({
            archive: file,
            path: entry.path,
            kind: entry.kind,
            size: entryUnpackedSize(entry),
            compressed,
            ...(entry.kind === 'DX10'
              ? {
                  width: entry.width,
                  height: entry.height,
                  mips: entry.mipCount,
                  format: dxgiFormatName(entry.dxgiFormat),
                  cubemap: entry.isCubemap,
                  chunks: entry.chunks.length,
                }
              : {}),
          });
        } else {
          const size = entryUnpackedSize(entry).toString().padStart(12);
          const kind = entry.kind === 'DX10' ? 'DX10' : compressed ? 'zlib' : 'raw ';
          process.stdout.write(`${size}  ${kind}  ${entry.path}\n`);
        }
      }
    } finally {
      archive.close();
    }
  }
  if (options.json) process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
}

async function extract(
  archives: string[],
  options: {
    out?: string;
    filter?: string;
    threads?: number;
    flat: boolean;
    force: boolean;
    dryRun: boolean;
  },
): Promise<void> {
  if (!options.out) fail('error: extract needs --out <dir>');
  const outRoot = path.resolve(options.out);
  if (!options.dryRun) fs.mkdirSync(outRoot, { recursive: true });

  const totals = { extracted: 0, skipped: 0, bytes: 0, errors: 0 };
  for (const file of archives) {
    const dest =
      archives.length > 1 && !options.flat ? path.join(outRoot, archiveName(file)) : outRoot;
    const started = Date.now();
    let lastPrint = 0;
    const result = await extractArchive(file, {
      outDir: dest,
      filter: options.filter,
      threads: options.threads,
      overwrite: options.force,
      flat: options.flat,
      dryRun: options.dryRun,
      onProgress: (progress) => {
        if (!process.stderr.isTTY) return;
        const now = Date.now();
        if (now - lastPrint < 100 && progress.done !== progress.total) return;
        lastPrint = now;
        const percent = progress.total === 0 ? 100 : (progress.done / progress.total) * 100;
        process.stderr.write(
          `\r  ${path.basename(file)}: ${progress.done}/${progress.total} (${percent.toFixed(1)}%) ${formatBytes(progress.bytes)}   `,
        );
      },
    });
    if (process.stderr.isTTY && !options.dryRun) process.stderr.write('\r\x1b[K');

    const seconds = (Date.now() - started) / 1000;
    const rate = seconds > 0 ? result.bytes / seconds : 0;
    process.stdout.write(
      `${path.basename(file)}: ${result.extracted} extracted, ${result.skipped} skipped, ${formatBytes(result.bytes)} in ${seconds.toFixed(2)}s` +
        (options.dryRun ? ' (dry run)' : ` (${formatBytes(rate)}/s)`) +
        `\n`,
    );
    for (const error of result.errors.slice(0, 20)) {
      process.stderr.write(`  failed: ${error.path}: ${error.message}\n`);
    }
    if (result.errors.length > 20) {
      process.stderr.write(`  ...and ${result.errors.length - 20} more failures\n`);
    }
    totals.extracted += result.extracted;
    totals.skipped += result.skipped;
    totals.bytes += result.bytes;
    totals.errors += result.errors.length;
  }

  if (archives.length > 1) {
    process.stdout.write(
      `total: ${totals.extracted} extracted, ${totals.skipped} skipped, ${formatBytes(totals.bytes)}\n`,
    );
  }
  if (totals.errors > 0) process.exit(1);
}

main();
