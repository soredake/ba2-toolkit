# BA2 (`BTDX`) format specification and extraction guide

This document describes the Bethesda **BA2** container as it appears in Fallout 4 and
Fallout 76, how its payloads are compressed, and how to turn texture records into
usable `.dds` files. It is the reference for the code in `src/ba2/` and records what
was measured on a real Fallout 76 install (72 archives, 690 889 entries, all version
1: 55 `GNRL` and 17 `DX10`). The reader is game-agnostic — it dispatches on the header,
not on the game — so the same rules apply to any BTDX archive; see the support table in
[README.md](README.md#supported-games).

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

Version 3 archives can replace zlib with raw LZ4 **block** compression. The choice is
archive-wide and lives in the header extension (§1); individual records still signal
"stored verbatim" with `packedSize == 0`. Each compressed payload — one `GNRL` file or
one `DX10` chunk — is exactly one raw block: no LZ4 frame header, no checksum and no
size prefix, because the record already carries the unpacked size.

A block is a sequence of *sequences*. Each one is

```
token (1 byte) | literal-length extension | literals | offset (2 bytes LE) | match-length extension | match bytes
```

- token high nibble = literal length (0-14 direct, `15` = 15 + extension);
- token low nibble = match length − 4 (0 → 4 … 14 → 18, `15` = 19 + extension);
- an extension is a 255 chain: add each byte, keep reading while the byte is `0xFF`,
  stop at the first byte below 255;
- the offset is little endian, 1-65535; `0` is invalid;
- the match copies from `output[pos - offset]` **byte by byte**, so an offset smaller
  than the match length repeats bytes that are being produced (offset 1 repeats the
  previous byte);
- the block ends when the input is exhausted right after a literal run. The last
  sequence is therefore literals-only, and the token's low nibble is unused.

```
while (ip < block.length) {
  token = block[ip++]
  literalLength = token >> 4; if (literalLength == 15) literalLength = extend(ip)
  copy literalLength bytes
  if (ip == block.length) break        // final literals-only sequence
  offset = u16le(block[ip]); ip += 2
  matchLength = (token & 15) + 4; if ((token & 15) == 15) matchLength = 19 + extend(ip)
  copy matchLength bytes from output[outPos - offset], one at a time
}
assert outPos == unpackedSize
```

Details that matter for BA2:

- **The end of the block is implicit.** A decoder must not stop on a byte count; it
  stops when the input runs out after a literal run.
- **Exact output size.** The block must produce exactly `unpackedSize` bytes; a mismatch
  is corruption, not something to pad or truncate.
- **Reference-decoder compatibility.** `LZ4_decompress_safe` and every consumer built on
  it (K4os, libbsarch, the Rust `btdx`/`bsa` crates) also require the last 5 bytes of the
  block to be literals. Encoders must leave them: this project's encoder keeps the last
  5 bytes literal and starts no match within the last 12 (`LITERAL_LIMIT`/`MFLIMIT`), so
  its blocks decode in all of those tools.
- **Blocks can grow their input.** Incompressible data costs one framing byte per 255
  input bytes plus 16, so a record with `packedSize > unpackedSize` is legal. The reader
  handles it; shipping Starfield archives mostly leave such chunks stored instead.
- `archive2` cannot be used to validate this path: that build has no LZ4 mode and cannot
  write version 3 (§8). The decoder is validated against the block-format specification
  and against an independent implementation instead (§9).

Both directions are implemented: `Ba2Archive.readEntry`/`readChunks` decode method 3, and
`ba2 create --version 3 --compression lz4` writes it.

### 3.3 How the reference tools handle compression

Every tool examined, and what it actually does with compressed payloads:

| Tool | zlib | LZ4 block | Notes |
| --- | --- | --- | --- |
| `Archive2.exe` 1.1.0.5 (official CK tool) | read + write | none | `-compression=None` stores, `Default` = zlib (`78 9C`, 32 KiB window), `XBox` = zlib with a 4 KiB window (`48 C7`). Always writes version 8, so it cannot produce or read Starfield v3. |
| BSA Browser / `Sharp.BSA.BA2` | read | `DX10` chunks only | `CompressionUtils.DecompressLZ4` calls `K4os.Compression.LZ4.LZ4Codec.Decode` with the chunk's unpacked size. The `GNRL` path only ever runs SharpZipLib's `Inflater`, so LZ4 `GNRL` files are unsupported there. Its header parser also reads the compression method from the **first** unknown `u32` (`0x18`) and tests for `1` instead of `0x20`/`3`, which does not match any v3 archive layout; do not use it as a v3 reference. |
| Unpackrr (`ba2-batch-unpack-gui`) | delegates | delegates | Selection/threshold wrapper around `bsab.exe`; it contains no archive codec of its own. |
| Batch BA2 Unpacker (`ba2-batch-unpack`) | delegates | delegates | Shells out to `bsab.exe` for every archive; no format code. |
| lz4js | n/a | both | Independent JavaScript port of the reference C codec, used here for conformance (§9). Its block encoder refuses to emit a block when it finds no match at all, so literal-only vectors are built from the specification. |

In short: the only shipped codec besides zlib is LZ4, only Starfield uses it, and no
reference tool here implements both directions of it, which is why the decoder is
cross-checked against an independent LZ4 implementation rather than another BA2 tool.

### 3.4 Validation rules that catch corruption

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
import { Ba2Archive, extractArchive, buildDdsHeader } from 'ba2-toolkit';

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

## 8. Official archiver (Archive2)

Fallout 4's Creation Kit ships `Tools/Archive2/Archive2.exe`, the tool Bethesda uses to
build these archives (`BA2 Archiver Version 1.1.0.5 for Fallout 4`). Its usage:

```text
Archive2 <archive, files/folders> [<arguments>]
  -create|c=<name>            create an archive
  -extract|e=<dir>            extract to a folder
  -createSourceFile|csf=<dir> write a source file from an archive
  -sourceFile|s=<file>        list of files to archive
  -root|r=<dir>               archive root (otherwise a Data folder is assumed)
  -format|f=<General|DDS|XBoxDDS>
  -compression=<None|Default|XBox>
  -count=<n>                  split into n archives
  -maxSizeMB|sMB=<n>          split by size
  -maxChunkCount|mch=<n>      default 4
  -singleMipChunkX|mipX=<n>   default 512
  -singleMipChunkY|mipY=<n>   default 512
  -nostrings                  do not write a name table
  -quiet|q, -tempFiles, -cleanup
  -includeFilters=?, -excludeFilters=?
  -?                          usage
```

Observed behaviour of that build:

- It writes **version 8** for both `General` and `DDS` archives, with the plain 24-byte
  header. Anything that assumes "version 1 means Fallout 4" is wrong for this tool, and
  the version gating in §1 is what makes those archives readable.
- Its three compression modes were measured by archiving the same sources three times
  and reading the results back:

  | `-compression` | payloads | zlib header | behaviour |
  | --- | --- | --- | --- |
  | `None` | `packedSize = 0` | — | stored verbatim |
  | `Default` | every non-empty payload | `78 9C` | 32 KiB window; compresses even when the stream grows |
  | `XBox` | every non-empty payload | `48 C7` | zlib with a 4 KiB window (`CINFO = 4`), otherwise the same |

  `Default` compresses every payload even when the zlib stream ends up larger than the
  source (a 120-byte file was stored as 131 bytes). `XBox` produced the same file sizes
  here and differs only in the two header bytes of each stream (4 bytes across a two-file
  archive), because a 4 KiB window loses most of the long-range matches. All three modes
  extracted to byte-identical files, so `XBox` needs no special case when reading.
- There is **no LZ4 mode**: this build has no Starfield support, writes version 8 only,
  and therefore cannot create or read a v3 archive. `-compression` accepts exactly
  `None`, `Default` and `XBox`; anything else is a usage error.
- Zero-length files are skipped instead of recorded.
- `-nostrings` writes `name table offset = 0`; records then carry only hashes and
  extensions, so extraction has to synthesise names.
- The chunking defaults explain the shipping layout in §2.3: at most 4 chunks per
  texture, and a mip only gets its own chunk when both dimensions are at least 512
  (`singleMipChunkX/Y`). That is exactly the 4096 / 2048 / 1024 / tail split.
- Extracting `DX10` writes a 128-byte DDS header with a legacy FourCC (`DXT5`, `DXT1`,
  …). The mip payload behind it is byte-identical to this reader's output; only the
  header style differs (§4.1).
- It imports `.dds` files using that same header (or this reader's DX10 header)
  correctly, but refuses cubemaps with "features not supported by the archiver".
- It reads shipping Fallout 76 version 1 archives and extracts them byte-identically to
  this reader, which is the strongest validation in §9.

`test/fixtures/archive2/` contains three archives this tool wrote from synthetic
payloads, so version 8, `-nostrings` and Archive2-created `DX10` records are covered by
`npm test` without game data. See the README there for the exact commands.

## 9. Validation

- 72 archives from a Fallout 76 install, 690 889 entries: all version 1, 55 `GNRL` and
  17 `DX10`; 63 archives pass every structural check. The remaining entries are cubemaps
  (chunk bytes equal 6× the single-face chain) and one texture mod with padded mips.
- 448 524 `GNRL` records all declare a single 0x10-byte chunk.
- Payloads compared byte for byte with BSA Browser's `Sharp.BSA.BA2` reader: all 30 170
  entries of `SeventySix - Materials.ba2` and 800 textures from
  `SeventySix - Textures01.ba2` were identical.
- Bethesda's own Archive2 extracted all 30 170 `SeventySix - Materials.ba2` entries and
  both `ScorchedMaps.ba2` textures to the same bytes this reader produces (the DDS files
  differ only in header style), and it extracted the synthetic fixtures correctly.
- Pillow decoded generated DDS files (BC1, BC3, BC5, R8) to the expected images; it
  rejects only sRGB DXGI codes, which is a Pillow limitation, not a header problem.
- The LZ4 codec (no BA2 reference tool implements both directions, §3.3) was checked
  against **lz4js**, an independent port of the reference C implementation, in both
  directions over 75 blocks / 4.21 MiB: every block from lz4js's encoder decoded
  identically here, and every block from this encoder decoded identically in lz4js
  (which enforces the reference decoder's last-5-literals rule). The corpus covers empty
  and 1-byte inputs, literal lengths past 255, matches of 4 to ~60 000 bytes, offsets of
  1, 4, 16 384 and 60 000, 1 MiB of text, zeros, alternating bytes and incompressible
  noise. `test/fixtures/lz4/reference-blocks.json` keeps eleven of those blocks, with the
  gzip-compressed expected output, so the decoder is tested against a foreign encoder on
  every `npm test`.
- The v3 archive path itself is covered by a committed fixture (`test/fixtures/v3-lz4.ba2`,
  method 3, two `GNRL` payloads) and by writer round-trips for `GNRL` and multi-chunk
  `DX10` archives.
- Real game data was pushed through the LZ4 writer as well, using
  `scripts/verify-roundtrip.mjs` (extract, rebuild as v3 LZ4, compare every entry):
  `SeventySix - Materials.ba2` (30 170 `GNRL` files, 12.5 MB) and `ScorchedMaps.ba2`
  (2 textures, 8 chunks, 42.7 MB) both came back byte-for-byte identical, which exercises
  LZ4 blocks from a few bytes to several megabytes.

## 10. Limits

- `GNMF` (PlayStation GNF) is rejected.
- LZ4 support follows the block-format specification and the header layout used by
  every other v3 implementation; no Starfield installation was available here, so the
  committed fixture and writer round-trips are the only v3 archives exercised. Bethesda's
  `Archive2` cannot read or write them either (it predates Starfield).
- Compression methods other than `0` (zlib) and `3` (LZ4) in a v3 header are rejected
  with an explicit error instead of being guessed at.
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
