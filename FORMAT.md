# BA2 (`BTDX`) format specification and extraction guide

This document describes the Bethesda **BA2** container as it appears in Fallout 4 and
Fallout 76, how its payloads are compressed, and how to turn texture records into
usable `.dds` files. It is the reference for the code in `src/ba2/` and records what
was measured on a real Fallout 76 install (72 archives, 690 889 entries, all version
1: 55 `GNRL` and 17 `DX10`).

Everything here was cross-checked against BSA Browser's `Sharp.BSA.BA2` reader and the
UESP BTDX notes; see [References](#references). Details that only exist in Starfield or
newer Fallout 4 archives are marked as such and are not exercised by this repository's
tests.

## Conventions

- All integers are **little endian**.
- `u8/u16/u32/u64` are unsigned integers of that width; `char[N]` is N raw bytes.
- Every offset in a record table is an **absolute offset in the archive file**, not an
  offset relative to the payload area.
- Sizes are bytes. A single payload is limited to 4 GiB by its `u32` size fields, while
  offsets are `u64`, so archives larger than 4 GiB are normal.

## 1. Archive header

The archive starts with a fixed 24-byte header:

| Offset | Type | Field | Notes |
| --- | --- | --- | --- |
| `0x00` | `char[4]` | magic | `"BTDX"` |
| `0x04` | `u32` | version | see the version table below |
| `0x08` | `char[4]` | type | `"GNRL"`, `"DX10"` or `"GNMF"` |
| `0x0C` | `u32` | file count | number of records in the table |
| `0x10` | `u64` | name table offset | absolute offset of the names, `0` if absent |
| `0x18` | — | record table | starts here for versions without an extension |

### Versions

| Version | Games | Header size | Payload compression |
| --- | --- | --- | --- |
| `1` | Fallout 4, Fallout 76 | 24 | zlib |
| `2` | Starfield `GNRL` | 32 (24 + 8) | zlib |
| `3` | Starfield `DX10` | 36 (24 + 12) | zlib or LZ4 block |
| `7` | Fallout 4 Next Gen textures | 24 | zlib |
| `8` | Fallout 4 Next Gen | 24 | zlib |

For version 2 the 8 extra bytes are two unknown `u32` values. Version 3 adds a third
`u32`, the compression method, at `0x20`:

| Value | Compression |
| --- | --- |
| `0` | zlib |
| `3` | raw LZ4 block |

The extension must be selected by **exact version** (`2` or `3`), not by
`version >= 2`: Fallout 4 Next Gen reports 7 or 8 with the plain 24-byte header, and
treating those as extended shifts every record by 8 bytes.

## 2. Record table

Each file entry begins with a 16-byte *chunk header*. Its shape is shared by all three
archive types; only the chunk record layout that follows differs.

### 2.1 Chunk header (16 bytes)

| Offset | Type | Field | Notes |
| --- | --- | --- | --- |
| `0x00` | `u32` | name hash | Bethesda's file-name hash; not needed for extraction |
| `0x04` | `char[4]` | extension | NUL padded, e.g. `bgem`, `dds` |
| `0x08` | `u32` | directory hash | Bethesda's directory hash |
| `0x0C` | `u8` | data file index | `0` for single-file archives |
| `0x0D` | `u8` | chunk count | `1` for every shipping `GNRL` entry |
| `0x0E` | `u16` | chunk header size | `0x10` GNRL, `0x18` DX10, `0x30` GNMF |

The record tables contain no per-entry name; names live in a separate table at the end
of the archive (§2.5) and are matched to records by index.

### 2.2 GNRL record — 36 bytes

`GNRL` ("general") archives hold whole files: meshes, sounds, materials, scripts, even
textures stored as finished DDS files.

| Offset | Type | Field |
| --- | --- | --- |
| `0x00` | — | 16-byte chunk header (§2.1) |
| `0x10` | `u64` | data offset |
| `0x18` | `u32` | packed (stored) size, `0` = not compressed |
| `0x1C` | `u32` | unpacked size |
| `0x20` | `u32` | `0xBAADF00D` sentinel / alignment |

That is one 16-byte header plus one 20-byte chunk, so every F76 record is exactly
36 bytes and the table can be read as a fixed-stride array. This was checked across all
448 524 `GNRL` records in a Fallout 76 install: every one has `chunk count = 1` and
`chunk header size = 0x10`. An archive that declares more chunks changes the stride and
must be walked record by record instead; this reader rejects it explicitly rather than
misparsing the table.

### 2.3 DX10 record — 24 bytes + N chunks

`DX10` archives hold textures as raw mip data. The chunk records are **interleaved**:
each file record is immediately followed by its own chunks, not stored in a separate
flat array.

| Offset | Type | Field |
| --- | --- | --- |
| `0x00` | — | 16-byte chunk header (§2.1) |
| `0x10` | `u16` | height |
| `0x12` | `u16` | width |
| `0x14` | `u8` | mip count |
| `0x15` | `u8` | DXGI format (see §6.3) |
| `0x16` | `u8` | `1` if the texture is a cubemap |
| `0x17` | `u8` | tile mode, `8` = plain PC layout |

Each chunk that follows is 24 bytes:

| Offset | Type | Field |
| --- | --- | --- |
| `0x00` | `u64` | data offset |
| `0x08` | `u32` | packed (stored) size, `0` = chunk stored uncompressed |
| `0x0C` | `u32` | unpacked size |
| `0x10` | `u16` | first mip level (inclusive) |
| `0x12` | `u16` | last mip level (inclusive) |
| `0x14` | `u32` | `0xBAADF00D` sentinel |

So a texture record is `24 + 24 * chunkCount` bytes and the table has to be walked
sequentially. The chunk count is stored in the shared chunk header at record offset
`0x0D`.

`startMip`/`endMip` describe what the chunk contains, but extraction does not need them:
concatenating the chunks **in record order** produces the mip chain, top level first.
They are still useful for validation.

Typical chunking (from `ScorchedMaps.ba2`, a 4096×4096 BC3 texture with 13 mips) is one
chunk per large level and one chunk for the tail:

| Chunk | Mips | Unpacked |
| --- | --- | --- |
| 0 | 0 | 16 777 216 |
| 1 | 1 | 4 194 304 |
| 2 | 2 | 1 048 576 |
| 3 | 3–12 | 349 552 |

### 2.4 GNMF record

`GNMF` archives carry PlayStation GNF textures and use 0x30-byte chunk headers. They do
not occur in the PC game and this project rejects them.

### 2.5 Name table

At `name table offset` the archive stores one string per record, in record order:

```
u16 length | char[length] path
```

Paths use forward slashes (`textures/shared/cubemaps/foo.dds`). The bytes are ASCII in
shipping archives and are decoded as UTF-8 here. A name table offset of `0` means the
archive has no names (some console archives); entries then get synthetic names.

Because names are attacker-controlled, the extractor normalises them: backslashes become
forward slashes, drive letters and `.`/`..` segments are removed, and characters that are
invalid in Windows paths (`\0 : * ? " < > |`) are replaced. Extraction additionally
resolves the final path and refuses anything outside the output directory.

## 3. Payload compression

Both archive types use the same rule: **a stored size of `0` means the payload is stored
verbatim; anything else is compressed and inflates to exactly the unpacked size.**
This is per chunk for textures, so one chunk can be compressed while another is stored.

### 3.1 zlib (versions 1, 2, 7, 8, and version 3 with method `0`)

Payloads are ordinary zlib streams (RFC 1950) wrapping deflate data: a 2-byte zlib
header, deflate data, and an Adler-32 trailer. Fallout 76 uses `78 9c` and `78 da`
(default and best-compression headers) and occasionally `48 c7`, which declares a 4 KiB
window instead of the usual 32 KiB. Any conforming inflater handles all three.

```
stored = archive[offset .. offset + packedSize]
raw    = inflate_zlib(stored)
assert raw.length == unpackedSize
```

The uncompressed data is exactly the file contents for `GNRL` and the raw mip chain for
`DX10`. No extra file header is embedded.

Some tools write the same deflate data without the zlib wrapper. This reader falls back
to raw deflate if zlib framing fails, but nothing in the shipping game needs that path.

### 3.2 LZ4 block (Starfield version 3, method `3`)

Version 3 archives can replace zlib with raw LZ4 **block** compression. The compression
choice is archive-wide; individual chunks still signal "uncompressed" with
`packedSize == 0`. A block is a sequence of tokens:

- one token byte: high nibble = literal length, low nibble = match length − 4;
- a length nibble of `15` means "add the following bytes, each `0xFF` adds 255, stop at
  the first byte below 255";
- copy that many literal bytes;
- if the input is exhausted, the block ends (the last sequence has literals only);
- otherwise read a 2-byte little-endian back-reference offset, copy `match length` bytes
  from the already-produced output (overlapping copies are valid), and continue.

This project rejects LZ4 archives with an explicit error; implementing the block decoder
is the only gap for reading Starfield textures.

### 3.3 Validation rules that catch corruption

A strict reader should check, and this one does:

- header magic/type/count are plausible, and the name table offset lies inside the file;
- for `GNRL`, `offset + (packedSize || unpackedSize) <= nameTableOffset`;
- for `DX10`, every chunk ends at or before the name table, and the chunk sizes sum to a
  valid mip chain for the declared format, dimensions and mip count (except cubemaps,
  see §6.4);
- inflate output length equals `unpackedSize` (a truncated or corrupt stream otherwise
  produces short files);
- `GNRL` records declare exactly one 0x10-byte chunk (otherwise the table stride is
  unknown).

## 4. Textures and DDS reconstruction

`DX10` payloads are raw surface data. To get a usable texture, prepend a DDS header:
a 4-byte magic, the 124-byte `DDS_HEADER`, and a 20-byte `DDS_HEADER_DXT10` — 148 bytes
in total — followed by the concatenated mip chunks.

Using the DX10 extension for **every** format (rather than legacy FourCCs) keeps BC6H,
BC7 and sRGB formats exactly as stored.

### 4.1 DDS header fields

| Offset | Field | Value written |
| --- | --- | --- |
| `0x00` | magic | `"DDS "` / `0x20534444` |
| `0x04` | `dwSize` | `124` |
| `0x08` | `dwFlags` | `0xA1007` (caps, height, width, pixel format, mip count, linear size) |
| `0x0C` | `dwHeight` | texture height |
| `0x10` | `dwWidth` | texture width |
| `0x14` | `dwPitchOrLinearSize` | size of mip 0 of one face |
| `0x18` | `dwDepth` | `0` |
| `0x1C` | `dwMipMapCount` | mip count (at least 1) |
| `0x20`–`0x4B` | `dwReserved1[11]` | `0` |
| `0x4C` | `ddspf.dwSize` | `32` |
| `0x50` | `ddspf.dwFlags` | `0x4` (`DDPF_FOURCC`) |
| `0x54` | `ddspf.dwFourCC` | `"DX10"` |
| `0x58`–`0x6B` | bit masks / bit count | `0` |
| `0x6C` | `dwCaps` | `0x1000` texture, `| 0x8` and `| 0x400000` when mipmapped |
| `0x70` | `dwCaps2` | `0xFE00` (`CUBEMAP \| ALLFACES`) for cubemaps, else `0` |
| `0x74`–`0x7F` | `dwCaps3/4`, `dwReserved2` | `0` |

### 4.2 DDS_HEADER_DXT10

| Offset | Field | Value |
| --- | --- | --- |
| `0x80` | `dxgiFormat` | the record's DXGI format, verbatim |
| `0x84` | `resourceDimension` | `3` (`TEXTURE2D`) |
| `0x88` | `miscFlag` | `0x4` (`TEXTURECUBE`) for cubemaps |
| `0x8C` | `arraySize` | `6` for cubemaps, `1` otherwise |
| `0x90` | `miscFlags2` | `0` |

Some tools instead emit legacy FourCCs (`DXT1`, `DXT5`, `BC5U`, …) for the formats that
old readers understand and only use a DX10 header for the rest. Both outputs are valid
DDS; the payload bytes are identical. BSA Browser, for example, writes `arraySize = 1`
for cubemaps and relies on `dwCaps2` alone.

### 4.3 Mip size math

A mip level's byte size depends on the format:

- **Block-compressed** formats store 4×4 texel blocks, each 8 or 16 bytes. The level
  size is `max(1, ceil(width/4)) * max(1, ceil(height/4)) * blockBytes`, so a 1×1 level
  still occupies one block.
- **Uncompressed** formats use `width * height * bytesPerPixel`, with a minimum of one
  pixel.

Level dimensions are `max(1, width >> level)` and `max(1, height >> level)`; the minimum
of one block/pixel is what makes the final levels of a mip chain non-zero.

Total single-face chain size:

```
size = 0
for level in 0 .. mipCount-1:
    w = max(1, width  >> level)
    h = max(1, height >> level)
    size += levelSize(format, w, h)
```

The top-level size is the same `levelSize(format, width, height)` and goes into
`dwPitchOrLinearSize`.

Examples:

| Format | Texture | Level 0 | 13-level chain |
| --- | --- | --- | --- |
| BC3 (77) | 4096×4096 | 16 777 216 | 22 369 648 |
| BC1 (71) | 1024×1024 | 524 288 | 699 064 |
| BC1 (71) | 128×64, 8 mips | 4 096 | 5 480 |

A useful identity for block formats: `chain ≈ level0 * 4/3`, truncating as levels reach
one block.

### 4.4 Cubemaps

When the `is cubemap` byte is `1`, the mip data contains **six faces**, so the chunks sum
to `6 ×` the single-face chain size. Faces are stored consecutively; this extractor does
not reorder them and declares `arraySize = 6` in the DDS header, which is the layout D3D
expects. The order is whatever the archive uses (the game consumes it directly), and has
not been verified by decoding faces here.

### 4.5 Tiling

`tile mode` `8` is the plain PC layout that can be written as DDS. Any other value marks
Xbox One tiled/swizzled data: it needs platform-specific detiling and is not a valid DDS
payload. This reader reports such entries and refuses to write them (an optional
`XBOX` FourCC path exists in BSA Browser, which also cannot produce a PC-usable texture).

### 4.6 DXGI formats seen in Fallout 76

| Value | Name | Storage |
| --- | --- | --- |
| 10 | `R16G16B16A16_FLOAT` | 8 bytes/pixel |
| 11 | `R16G16B16A16_UNORM` | 8 bytes/pixel |
| 28 | `R8G8B8A8_UNORM` | 4 bytes/pixel |
| 29 | `R8G8B8A8_UNORM_SRGB` | 4 bytes/pixel |
| 61 | `R8_UNORM` | 1 byte/pixel |
| 71 | `BC1_UNORM` | 8 bytes per 4×4 block |
| 72 | `BC1_UNORM_SRGB` | 8 bytes per block |
| 77 | `BC3_UNORM` | 16 bytes per block |
| 78 | `BC3_UNORM_SRGB` | 16 bytes per block |
| 80 | `BC4_UNORM` | 8 bytes per block |
| 83 | `BC5_UNORM` | 16 bytes per block |
| 84 | `BC5_SNORM` | 16 bytes per block |
| 87 | `B8G8R8A8_UNORM` | 4 bytes/pixel |
| 98 | `BC7_UNORM` | 16 bytes per block |
| 99 | `BC7_UNORM_SRGB` | 16 bytes per block |

If a format is unknown, the DXGI value is still written verbatim and a size fallback of
4 bytes/pixel is assumed for header fields only; extraction does not depend on it.

## 5. Extraction algorithm

For each selected record, in index order:

1. Read the record (fixed stride for `GNRL`, sequential for `DX10`).
2. Resolve the name from the name table.
3. For `GNRL`: read `packedSize || unpackedSize` bytes at `offset`; inflate if needed;
   write the bytes.
4. For `DX10`: read each chunk at its offset, inflate if needed, build the 148-byte DDS
   header from the record fields, write header + chunks (use `writev`/scatter writes to
   avoid copying hundreds of MiB).
5. Verify the output length and report per-file errors instead of aborting the archive.

Files are independent, so the loop parallelises trivially: this project splits record
indices across worker threads, each opening the archive separately and writing its own
files, using `open(..., 'wx')` to skip existing files without a stat call.

### Minimal reader in TypeScript

```ts
import fs from 'node:fs';
import zlib from 'node:zlib';

const fd = fs.openSync(path, 'r');
const header = Buffer.alloc(24);
fs.readSync(fd, header, 0, 24, 0);

const version = header.readUInt32LE(4);
const type = header.toString('latin1', 8, 12);
const count = header.readUInt32LE(12);
const nameTableOffset = Number(header.readBigUInt64LE(16));
const extra = version === 2 ? 8 : version === 3 ? 12 : 0;
const recordOffset = 0x18 + extra;

// GNRL: fixed 36-byte records
const record = Buffer.alloc(36);
fs.readSync(fd, record, 0, 36, recordOffset + index * 36);
const offset = Number(record.readBigUInt64LE(16));
const packedSize = record.readUInt32LE(24);
const unpackedSize = record.readUInt32LE(28);

const stored = Buffer.alloc(packedSize || unpackedSize);
fs.readSync(fd, stored, 0, stored.length, offset);
const data = packedSize ? zlib.inflateSync(stored) : stored;
```

With this package the same work is:

```ts
import { Ba2Archive, extractArchive, buildDdsHeader } from 'ba2-extractor-fallout76';

const archive = Ba2Archive.open('SeventySix - Textures01.ba2');
const entry = archive.entries[0];
const dds = archive.readEntry(entry);      // 148-byte header + mip data
archive.close();

await extractArchive('SeventySix - Meshes.ba2', {
  outDir: 'out',
  filter: '*.nif',
  threads: 8,
});
```

Or from the command line:

```bash
node dist/cli.js extract "SeventySix - Textures01.ba2" --out out --filter "*.dds" --threads 8
node dist/cli.js extract "SeventySix - Materials.ba2" --out out --dry-run   # validate only
```

## 6. Worked examples

### 6.1 A GNRL record

`SeventySix - Materials.ba2` starts with `BTDX`, version 1, `GNRL`, 30 170 records, name
table at `0x5783A2` (5 735 330). The first record at `0x18`:

```
18: ce51 b53a   name hash
1c: 6267 656d   extension "bgem"
20: 1b02 1e7d   directory hash
24: 00 01 1000  file index 0, chunk count 1, chunk header size 0x10
28: c092 1000 0000 0000   data offset 0x1092C0
30: 0001 0000   packed size 256
34: e101 0000   unpacked size 481
38: 0df0 adba   sentinel
```

`0x1092C0` lies just past the record table, the payload is a 256-byte zlib stream, and it
inflates to 481 bytes. The name table entry with index 0 supplies the path
(`materials/…bgem`); the record itself only carries its extension and hashes.

### 6.2 A DX10 record with four chunks

`ScorchedMaps.ba2`, header v1/DX10, 2 records, name table at `0x1470094` (21 430 676):

```
18: 1a00 7699   name hash
1c: 6464 7300   extension "dds"
20: a749 f387   directory hash
24: 00 04 1800  file index 0, 4 chunks, chunk header size 0x18
28: 0010 0010   height 4096, width 4096
2c: 0d 4d 00 08  mips 13, DXGI 77 (BC3_UNORM), not a cubemap, tile mode 8
30: 0801 0000 0000 0000   chunk 0: offset 0x108
38: 4841 7d00   0x7D4148 stored
3c: 0000 0001   unpacked 0x01000000 (16 MiB)
40: 0000 0000   mips 0–0
44: 0df0 adba   sentinel
48: 5042 7d00 0000 0000   chunk 1: offset 0x7D4250
...
60: 7810 9a00 0000 0000   chunk 2: offset 0x9A1078, 1 MiB, mips 2–2
78: 9e2b a100 0000 0000   chunk 3: offset 0xA12B9E, 349 552 bytes, mips 3–12
```

The four chunks are interleaved directly after the record, and chunk 0's offset is exactly
the end of the record table: `0x18 + 24 + 4*24 = 0x108`.

Reassembling produces a 148 + 22 369 648 byte DDS file that decodes as a 4096×4096 BC3
texture.

## 7. Variability in the wild

- **Mod archives** use the same layout. Python/C# packers can pad mip data slightly;
  because every chunk carries its own unpacked size, extraction still works.
- **Cubemaps** store six faces; naive mip-chain checks will report a 6× mismatch unless
  the cubemap flag is taken into account.
- **Partial chunks**: a chunk may be compressed while another is stored
  (`packedSize == 0`). Never assume the whole texture is compressed because chunk 0 is.
- **Missing name tables** (some console archives) leave records with hashes only; the
  name table offset is `0`.
- **4 GiB archives** are routine (`SeventySix - Textures01.ba2` is 4 194 135 355 bytes);
  use `u64` offsets and positional reads rather than loading the archive.

## 8. Validation

- 72 archives from a Fallout 76 install, 690 889 entries: all version 1, 55 `GNRL` and
  17 `DX10`; 63 archives pass every structural check. The remaining entries are cubemaps
  (chunk bytes equal 6× the single-face chain) and one texture mod with padded mips.
- 448 524 `GNRL` records all declare a single 0x10-byte chunk.
- Payloads compared byte for byte with BSA Browser's `Sharp.BSA.BA2` reader: all 30 170
  entries of `SeventySix - Materials.ba2` and 800 textures from
  `SeventySix - Textures01.ba2` were identical.
- Pillow decoded generated DDS files (BC1, BC3, BC5, R8) to the expected images; it
  rejects only sRGB DXGI codes, which is a Pillow limitation, not a header problem.

## 9. Limits

- `GNMF` (PlayStation GNF) is rejected.
- LZ4 block compression (Starfield v3, method 3) is rejected; zlib v2/v3 headers are
  accepted and parsed, but no Starfield archive was available here to exercise them.
- `GNRL` archives with more than one chunk per file are rejected, because their record
  stride differs from the 36-byte layout.
- Xbox tiled textures cannot be written as usable DDS.
- Filename hashes are not validated or generated; they are metadata only.

## References

- BSA Browser (with .BA2 support) —
  <https://www.nexusmods.com/skyrimspecialedition/mods/1756>, source
  <https://github.com/AlexxEG/BSA_Browser> (`Sharp.BSA.BA2`)
- Unpackrr — <https://www.nexusmods.com/fallout4/mods/82082>, source
  <https://github.com/kazum1kun/ba2-batch-unpack-gui>
- Batch BA2 Unpacker — <https://www.nexusmods.com/fallout4/mods/79593>, source
  <https://github.com/kazum1kun/ba2-batch-unpack>
- UESP BTDX notes — <https://en.uesp.net/wiki/User:SniffleMan>
- `btdx` Rust crate (version and compression notes) — <https://docs.rs/btdx>
