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
0x04 u32     version          1 = Fallout 4 / Fallout 76, 7/8 = Fallout 4 Next Gen
0x08 char[4] "GNRL" | "DX10"
0x0C u32     file count
0x10 u64     absolute offset of the name table
0x18 …       records, then payloads, then the name table
```

Starfield extends the header: version 2 adds 8 unknown bytes and version 3 adds
those plus a `u32` compression method (`0` = zlib, `3` = LZ4 block). The extra
bytes are selected by exact version, because Fallout 4 Next Gen reports version 7
or 8 with the plain 24 byte header.

**GNRL record — 36 bytes**, in file order:

```
u32 name hash | char[4] extension | u32 dir hash
u8 data file index (0) | u8 chunk count (1) | u16 chunk header size (0x10)
u64 data offset | u32 packed size | u32 unpacked size | u32 0xBAADF00D
```

That is a 16 byte chunk header followed by a single 20 byte chunk, which is what
makes the fixed 36 byte stride valid; all 448 524 records in a Fallout 76 install
have exactly one chunk with a `0x10` byte header.

`packed size != 0` means the payload is a zlib stream (`78 9c`, `78 da`, or a
small-window `48 c7` header) whose output must equal `unpacked size`; otherwise the
bytes are stored as-is.

**DX10 record — 24 bytes**, immediately followed by its own chunk records (records
are interleaved, *not* one flat header array):

```
u32 name hash | char[4] extension | u32 dir hash | u8 data file index | u8 chunk count
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

### One format, two payload kinds

Every archive in a Fallout 76 install uses exactly this header: 72 archives in the
install this was validated against, all version 1 — 55 `GNRL` and 17 `DX10`,
690 889 entries, no `GNMF` (PlayStation) archives and no newer versions. Only the
payload semantics vary:

- `GNRL` entries are either stored or a zlib stream; `DX10` entries are split into
  mip chunks, and individual chunks may be stored too.
- A cubemap entry holds six faces, so its chunks sum to `6 x` the single-face mip
  chain. The DDS written on extraction declares `arraySize = 6`.
- Third-party mod archives in `Data` follow the same layout. Some exporters pad
  mip data; that is harmless here because every chunk carries its own unpacked size.

### Archive versions

Fallout 76 ships only version 1 archives, which is what the tests here exercise
against real data. The reader also accepts zlib Starfield v2/v3 archives by
skipping their extra header bytes; LZ4 v3 archives are rejected rather than
guessed at, and the Next Gen v7/v8 headers are read as plain version 1.

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

`npm test` runs the suite with `node --test` and needs no game installation. It reads
the small archives committed under `test/fixtures/`:

| Fixture | Contents |
| --- | --- |
| `gnrl.ba2` (770 B) | four entries: a zlib stream, an uncompressed file, a zlib text file and a zero-byte file |
| `dx10.ba2` (3 KB) | a BC1 texture with a full mip chain, a BC5 texture with two chunks (one compressed, one stored) and a BC3 cubemap |

They use the shipping BTDX version 1 layout and real zlib streams, but the payloads
are generated, so no Bethesda data is redistributed. `test/fixtures/manifest.json`
records the expected size and SHA-256 of every entry, which the tests compare against
the extracted files. The suite covers record and name-table parsing, stored vs
compressed payloads, DX10 chunks, DDS/DX10 headers, cubemap flags, extraction
(serial and worker pool), filters, `--flat`, overwrite/skip, dry runs, malformed
archives and the CLI.

The payloads were also cross-checked byte for byte against BSA Browser's
`Sharp.BSA.BA2` reader: all 30 170 entries of `SeventySix - Materials.ba2` and 800
textures from `SeventySix - Textures01.ba2` came out identical, and that reader
also parses the fixtures above.

`scripts/make-fixtures.mjs` regenerates the fixtures with `npm run fixtures`. The
output is deterministic, so a regeneration after a format change should show a
useful diff rather than random churn.

`test/game-data.test.mjs` additionally validates a real installation
(`C:/Program Files (x86)/Steam/steamapps/common/Fallout76/Data`, override with
`FO76_DATA`): a header census of every `.ba2`, GNRL payloads from
`SeventySix - Materials.ba2`, DDS output for `ScorchedMaps.ba2`, cubemap sizing and a
serial-vs-parallel extraction of `SeventySix - 00UpdateStream.ba2`. Those tests skip
when the game data is missing.

## References

These tools and their sources were used while researching the `.ba2` format and
cross-checking this implementation:

- Unpackrr — <https://www.nexusmods.com/fallout4/mods/82082>
- Unpackrr source — <https://github.com/kazum1kun/ba2-batch-unpack-gui>
- Batch BA2 Unpacker — <https://www.nexusmods.com/fallout4/mods/79593>
- Batch BA2 Unpacker source — <https://github.com/kazum1kun/ba2-batch-unpack>
- BSA Browser (with .BA2 support) — <https://www.nexusmods.com/skyrimspecialedition/mods/1756>
- BSA Browser source — <https://github.com/AlexxEG/BSA_Browser>

The Python tools only drive BSA Browser's `bsab.exe`; the format details and the
byte-for-byte payload checks came from BSA Browser's `Sharp.BSA.BA2` library.
