# ba2-extractor-fallout76

Fast reader and extractor for Bethesda **BA2** (`BTDX`) archives, written in TypeScript
for Node.js and tuned for the multi-gigabyte archives that ship with **Fallout 76**
(the same format is used by Fallout 4).

- Reads the archive table once, then fetches payloads with positional reads, so a
  4 GiB archive never has to fit in memory.
- Decompresses with Node's native `zlib` (C libz, not a JS inflate) on a pool of
  worker threads.
- Rebuilds complete `.dds` files for `DX10` texture archives, including BC5/BC6H/BC7
  through a proper `DDS_HEADER_DXT10`, so the output opens in any modern DDS reader.
- No runtime dependencies. `typescript` and `@types/node` are dev-only.

## Usage

```bash
npm install
npm run build

# What is in this archive?
node dist/cli.js info "C:/Program Files (x86)/Steam/steamapps/common/Fallout76/Data/SeventySix - Textures01.ba2"

# List entries (glob filter, machine readable with --json)
node dist/cli.js list "SeventySix - Materials.ba2" --filter "*.bgsm" --limit 20

# Extract everything
node dist/cli.js extract "SeventySix - Meshes.ba2" --out out

# Extract a subset with 8 workers
node dist/cli.js extract "SeventySix - Meshes.ba2" --out out --filter "meshes/architecture/*" --threads 8

# Batch extraction: each archive gets its own subdirectory
node dist/cli.js extract "SeventySix - Materials.ba2" "SeventySix - Sounds01.ba2" --out out

# Verify every payload without writing anything
node dist/cli.js extract "SeventySix - Animations.ba2" --out out --dry-run
```

`npm link` (or `npm install -g .`) exposes the same commands as `ba2`.

| Command | Options |
| --- | --- |
| `ba2 info <archive...>` | `--json` |
| `ba2 list <archive...>` | `--filter <glob>`, `--json`, `--limit <n>` |
| `ba2 extract <archive...>` | `--out <dir>`, `--filter <glob>`, `--threads <n>`, `--flat`, `--force`, `--dry-run` |

`*` in `--filter` matches across directory separators, and matching is
case-insensitive, so `--filter "*.dds"` selects every texture.

## Library

```ts
import { Ba2Archive, extractArchive } from 'ba2-extractor-fallout76';

const archive = Ba2Archive.open('SeventySix - Textures01.ba2');
const entry = archive.entries[0];        // parsed record: path, sizes, chunks…
const dds = archive.readEntry(entry);    // Buffer with a full DDS file
archive.close();

await extractArchive('SeventySix - Meshes.ba2', {
  outDir: 'out',
  filter: 'meshes/*',
  threads: 8,
  overwrite: false,
});
```

Exports: `Ba2Archive` / `openArchive`, `extractArchive`, `compileFilter`,
`buildDdsHeader`, `dxgiFormatName`, `mipChainSize`, plus the entry/header types.

## Format notes

All integers are little endian.

```
0x00 char[4] "BTDX"
0x04 u32     version          1 = Fallout 4 / Fallout 76
0x08 char[4] "GNRL" | "DX10"
0x0C u32     file count
0x10 u64     absolute offset of the name table
0x18 …       records, then payloads, then the name table
```

**GNRL record — 36 bytes**, in file order:

```
u32 name hash | char[4] extension | u32 dir hash | u32 flags
u64 data offset | u32 packed size | u32 unpacked size | u32 0xBAADF00D
```

`packed size != 0` means the payload is a zlib stream (`78 9c`, `78 da`, or a
small-window `48 c7` header) whose output must equal `unpacked size`; otherwise the
bytes are stored as-is.

**DX10 record — 24 bytes**, immediately followed by its own chunk records (records
are interleaved, *not* one flat header array):

```
u32 name hash | char[4] extension | u32 dir hash | u8 unknown | u8 chunk count
u16 chunk header size (0x18) | u16 height | u16 width | u8 mip count
u8 DXGI format | u8 is cubemap | u8 tile mode (8 = PC)
```

**DX10 chunk — 24 bytes:**

```
u64 data offset | u32 packed size | u32 unpacked size
u16 first mip | u16 last mip | u32 0xBAADF00D
```

Mip data is concatenated in record order behind a generated DDS header; the DXGI
format is stored verbatim in a `DDS_HEADER_DXT10`, so nothing is lossily converted.
`packed size != 0` again means zlib.

**Name table:** `u16 byte length + path` per record, in record order, at
`name table offset`. Fallout 76 writes forward slashes; backslashes are normalised too.
Paths are sanitised so an archive can never write outside the output directory.

### Limits

- `GNMF` (PlayStation GNF textures) is rejected.
- Archive versions whose header declares a non-zlib compression method (Starfield v3,
  LZ4 block) are rejected with an explicit error instead of producing garbage.
- Xbox One tiled textures (`tile mode != 8`) keep their raw layout; they are reported
  but cannot be written as usable DDS files.
- BA2 filename hashes are not needed for extraction and are only exposed as metadata.

## Performance

Measured on this machine (16 logical cores, Windows, archives on an SSD) with
`npm run bench` and the CLI. Decompression runs in native `zlib` on worker threads;
small files are limited by Windows file creation, large payloads by inflate
throughput.

| Workload | Threads | Throughput |
| --- | --- | --- |
| `SeventySix - Meshes.ba2`, 9 489 files, 422 MiB | 1 | 26.6 MiB/s |
| same | 16 | 77.3 MiB/s |
| `SeventySix - EnlightenInteriors02.ba2`, 29 files, 1.35 GiB | 1 | 152 MiB/s |
| same | 8 | 327 MiB/s |
| `SeventySix - WorkshopIcons.ba2`, 7 276 small textures | 16 | 23.7 MiB/s (≈1 500 files/s) |
| decompress only (`--dry-run`), 7 276 textures, 115 MiB | 1 | 126 MiB/s |

## Tests

`npm test` runs `node --test` against the installed Fallout 76 archives
(`C:/Program Files (x86)/Steam/steamapps/common/Fallout76/Data`, override with
`FO76_DATA`). It covers GNRL parsing, zlib payloads, DX10 metadata and mip sizes,
DDS header fields, single-threaded vs parallel extraction equality, filters,
dry-run and the CLI. Tests are skipped when the game data is not present.
