# ba2-extractor

Reader and extractor for Bethesda **BA2** (`BTDX`) archives, written in TypeScript for
Node.js and tuned for the multi-gigabyte archives that ship with Fallout 4, Fallout 76
and Starfield.

## Supported games

| Game | BA2 versions | Support |
| --- | --- | --- |
| Fallout 4 (original) | 1 | `GNRL` and `DX10`, including DDS reconstruction |
| Fallout 4 Next Gen | 7, 8 | Same 24-byte header and records as version 1 |
| Fallout 76 | 1 | `GNRL` and `DX10`; byte-validated against all 72 shipping archives |
| Starfield | 2, 3 | zlib `GNRL`/`DX10`; v3 LZ4-block archives are rejected with a clear error |
| Skyrim, Oblivion, Morrowind | BSA, not BA2 | Not supported — different container |

The container is detected from the file itself (magic, version and `GNRL`/`DX10` tag),
not from the game or the archive name, so any game shipping plain BTDX archives uses the
same code path. Out of scope: `GNMF` (PlayStation GNF textures), Xbox-tiled textures and
BA2 files with more than one chunk per `GNRL` entry.

Fallout 76 is the only install that was available for the byte-level checks here;
Fallout 4 shares the same version 1 layout, while the version 2/3/7/8 header offsets are
covered by unit tests.

Bethesda's own `Archive2.exe` (from the Fallout 4 Creation Kit) is the second reference:
it extracts shipping F76 archives to the same bytes this reader produces, and three
archives it wrote are part of the fixture suite. Note that this Archive2 build writes
version 8, not version 1 — which is why the header version is handled explicitly.

- Reads the archive table once, then fetches payloads with positional reads, so a
  4 GiB archive never has to fit in memory. The format is documented in
  [FORMAT.md](FORMAT.md).
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
import { Ba2Archive, extractArchive } from 'ba2-extractor';

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

## Format

BA2 is Bethesda's `BTDX` container: a 24-byte header, a record table, the payloads and
an optional name table at the end, with zlib-compressed payloads. Fallout 76 only ships
version 1 archives in two flavours — `GNRL` (whole files, 36-byte records) and `DX10`
(interleaved texture records whose mip chunks are rebuilt into `.dds` files).

[FORMAT.md](FORMAT.md) is the full specification: every field and offset, version and
compression differences, the DDS/DX10 header layout, mip-size math, cubemap and tiling
rules, a worked hexdump, an extraction walkthrough with code snippets, and the
validation numbers.

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
| `archive2/general-v8.ba2` (727 B) | version 8 GNRL archive written by Bethesda's Archive2 (zero-byte file skipped) |
| `archive2/dds-v8.ba2` (1.1 KB) | Archive2 DX10 records built by importing the fixture DDS files |
| `archive2/nostrings-v8.ba2` (19 KB) | version 8 GNRL archive with `name table offset = 0` |

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
also parses the fixtures above. Bethesda's `Archive2` extracted the same 30 170 files
identically, and it reads the committed fixtures too — including the ones it wrote
itself (`test/fixtures/archive2/`), which cover version 8 and name-table-less archives.

`scripts/make-fixtures.mjs` regenerates the fixtures with `npm run fixtures`. The
output is deterministic, so a regeneration after a format change should show a
useful diff rather than random churn.

`test/game-data.test.mjs` additionally validates a real installation: a header census
of every `.ba2`, GNRL payloads from `SeventySix - Materials.ba2`, DDS output for
`ScorchedMaps.ba2`, cubemap sizing and a serial-vs-parallel extraction of
`SeventySix - 00UpdateStream.ba2`. It looks in
`C:/Program Files (x86)/Steam/steamapps/common/Fallout76/Data` by default; set
`BA2_DATA` (or `FO76_DATA`) to any game's `Data` folder. The census accepts every known
version, and tests for archives that are not installed are skipped, so it also runs
against a Fallout 4 or Starfield install.

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
