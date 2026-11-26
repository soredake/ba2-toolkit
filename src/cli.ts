#!/usr/bin/env node
/**
 * Command line interface: info / list / extract / create.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { Ba2Archive } from './ba2/reader.js';
import { compileFilter, extractArchive } from './ba2/extract.js';
import { createArchive } from './ba2/writer.js';
import { dxgiFormatName } from './ba2/dxgi.js';
import { entryCompression, entryUnpackedSize } from './ba2/format.js';

const HELP = `ba2 - Bethesda BA2 (BTDX) archive tool

Works with Fallout 4 (including Next Gen), Fallout 76 and Starfield archives
(zlib and LZ4), and creates new archives.

Usage:
  ba2 info <archive.ba2...>
  ba2 list <archive.ba2...> [--filter <glob>] [--json] [--limit <n>]
  ba2 extract <archive.ba2...> --out <dir> [options]
  ba2 create <archive.ba2> <source-dir> [options]

Create options:
      --format <f>     GNRL (general files) or DX10 (textures). Default:
                       auto-detect - any .dds file selects DX10.
      --compression <c>  zlib (default), none (store), lz4 (version 3 only).
      --version <n>    Archive version: 1, 2, 3, 7 or 8 (default 8).
      --max-chunks <n> Maximum texture chunks (default 4, like Archive2).
      --chunk-size <n> Mip size that starts its own chunk (default 512).
      --nostrings      Omit the name table (paths become unnamed/NN.ext).

Extract options:
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
  ba2 create MyMod - Textures.ba2 ./textures            # auto-detects DX10
  ba2 create patch.ba2 ./loose --format GNRL --compression none
  ba2 create starfield.ba2 ./assets --version 3 --compression lz4
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
      // create options
      format: { type: 'string' },
      compression: { type: 'string' },
      version: { type: 'string' },
      nostrings: { type: 'boolean' },
      'max-chunks': { type: 'string' },
      'chunk-size': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help) {
    process.stdout.write(HELP);
    return;
  }

  if (command === 'create') {
    const [output, source] = positionals;
    if (!output || !source) {
      fail('error: create needs an output archive and a source directory (see ba2 --help)');
    }
    if (!fs.statSync(source).isDirectory()) {
      fail(`error: ${source} is not a directory`);
    }
    const compression = values.compression ?? 'zlib';
    if (compression !== 'zlib' && compression !== 'none' && compression !== 'lz4') {
      fail(`error: unknown --compression ${JSON.stringify(compression)} (zlib, none or lz4)`);
    }
    const format = values.format ?? undefined;
    if (format !== undefined && format !== 'GNRL' && format !== 'DX10') {
      fail(`error: unknown --format ${JSON.stringify(format)} (GNRL or DX10)`);
    }
    // LZ4 needs Starfield v3; pick it automatically unless told otherwise.
    const requestedVersion = values.version !== undefined ? Number(values.version) : undefined;
    void createArchive(output, source, {
      format,
      compression,
      version: requestedVersion ?? (compression === 'lz4' ? 3 : undefined),
      maxChunks: values['max-chunks'] !== undefined ? Number(values['max-chunks']) : undefined,
      singleMipChunkSize: values['chunk-size'] !== undefined ? Number(values['chunk-size']) : undefined,
      noStrings: Boolean(values.nostrings),
    }).then(() => {
      const size = fs.statSync(output).size;
      process.stdout.write(`created ${output} (${formatBytes(size)})\n`);
    }, (error: unknown) => {
      fail(`error: ${(error as Error).message}`);
    });
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
    const codec = summary.compressedFiles > 0 ? summary.compression : 'none';
    process.stdout.write(`${summary.path}\n`);
    process.stdout.write(`  format      : ${h.kind}, version ${h.version}\n`);
    process.stdout.write(`  files       : ${summary.fileCount}\n`);
    process.stdout.write(`  compression : ${codec}\n`);
    process.stdout.write(
      `  payload     : ${formatBytes(summary.unpackedBytes)} unpacked, ${formatBytes(summary.storedBytes)} stored\n`,
    );
    process.stdout.write(
      `  compressed  : ${summary.compressedFiles} payload block(s)\n`,
    );
    if (summary.extensions.length > 0) {
      const list = summary.extensions
        .slice(0, 8)
        .map((item) => `${item.extension || '(none)'} ${item.count}`)
        .join(', ');
      process.stdout.write(`  extensions  : ${list}\n`);
    }
    if (summary.formats.length > 0) {
      const list = summary.formats
        .slice(0, 8)
        .map((item) => `${item.name} ${item.count}`)
        .join(', ');
      process.stdout.write(`  textures    : ${list}\n`);
      if (summary.cubemaps > 0) process.stdout.write(`  cubemaps    : ${summary.cubemaps}\n`);
      if (summary.nonPcTiling > 0) {
        process.stdout.write(
          `  warning     : ${summary.nonPcTiling} Xbox tiled texture(s) cannot be written as DDS\n`,
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
      const codec = archive.compression;
      let printed = 0;
      for (const entry of archive.entries) {
        if (!matches(entry)) continue;
        if (options.limit !== undefined && printed >= options.limit) break;
        printed++;
        const compression = entryCompression(entry, codec);
        if (options.json) {
          rows.push({
            archive: file,
            path: entry.path,
            kind: entry.kind,
            size: entryUnpackedSize(entry),
            compressed: compression !== 'none',
            compression,
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
          const kind = entry.kind === 'DX10' ? 'DX10' : compression === 'none' ? 'raw ' : compression;
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
