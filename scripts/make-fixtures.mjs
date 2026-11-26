#!/usr/bin/env node
/**
 * Builds the committed test fixtures in `test/fixtures/`.
 *
 * The fixtures use the exact on-disk layout of the shipping archives, but the
 * payloads are synthetic so the repository stays small and free of game data.
 *
 * - `gnrl.ba2`, `dx10.ba2`: BTDX version 1 (Fallout 4 / 76 layout, zlib).
 *   One GNRL entry is stored, the rest are real zlib streams; one DX10 entry
 *   splits its mip chain over two chunks and stores one of them uncompressed.
 * - `v3-lz4.ba2`: BTDX version 3 (Starfield), 12 byte header extension with
 *   compression method 3, both GNRL payloads are raw LZ4 blocks.
 * - `raw-deflate.ba2`: BTDX version 1 with a deflate stream that has no zlib
 *   wrapper, exercising the reader's raw-deflate fallback.
 *
 * The LZ4 blocks come from the library's own encoder, so the script needs
 * `npm run build` first. LZ4 conformance against an independent implementation
 * is covered by `test/fixtures/lz4/reference-blocks.json`.
 *
 * The output is deterministic: running this script twice produces identical
 * bytes, so `test/fixtures/*.ba2` can be committed.
 *
 * Record hashes are arbitrary placeholders; the reader never uses them.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(HERE, '..', 'test', 'fixtures');
fs.mkdirSync(OUT_DIR, { recursive: true });

/** Manifest describing every committed fixture; filled in as each one is built. */
const manifest = {
  generatedBy: 'scripts/make-fixtures.mjs',
  note: 'Synthetic archives; payloads are generated, not game data.',
  gnrl: null,
  dx10: null,
};
const SENTINEL = 0xbaadf00d;
const TILE_MODE_PC = 8;
const HEADER_SIZE = 24;
const GNRL_RECORD_SIZE = 36;
const DX10_RECORD_SIZE = 24;
const DX10_CHUNK_SIZE = 24;
const DDS_HEADER_SIZE = 148;

const BLOCK_BYTES = { 71: 8, 72: 8, 74: 16, 75: 16, 77: 16, 78: 16, 80: 8, 81: 8, 83: 16, 84: 16, 95: 16, 96: 16, 98: 16, 99: 16 };
const BYTES_PER_PIXEL = { 10: 8, 11: 8, 28: 4, 29: 4, 49: 2, 61: 1, 87: 4, 88: 4, 91: 4 };

function mipLevelSize(format, width, height) {
  const block = BLOCK_BYTES[format];
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  if (block) return Math.max(1, Math.ceil(w / 4)) * Math.max(1, Math.ceil(h / 4)) * block;
  return w * h * (BYTES_PER_PIXEL[format] ?? 4);
}

function mipDimensions(width, height, level) {
  return { width: Math.max(1, width >> level), height: Math.max(1, height >> level) };
}

function mipChainSize(format, width, height, mipCount) {
  let total = 0;
  for (let level = 0; level < Math.max(1, mipCount); level++) {
    const dims = mipDimensions(width, height, level);
    total += mipLevelSize(format, dims.width, dims.height);
  }
  return total;
}

/** Cheap deterministic hash used only to fill the record hash fields. */
function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(text, 'utf8')) {
    hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  }
  return hash;
}

/** Smooth, highly compressible byte pattern (texture-like). */
function pattern(size, seed) {
  const out = Buffer.alloc(size);
  for (let i = 0; i < size; i++) {
    out[i] = ((i >> 6) + (i & 0x3f) * 3 + seed) & 0xff;
  }
  return out;
}

function compress(data) {
  const packed = zlib.deflateSync(data, { level: 9 });
  if (packed.length >= data.length) {
    throw new Error(`fixture payload did not compress (${packed.length} >= ${data.length})`);
  }
  return packed;
}

function extensionOf(name) {
  const dot = name.lastIndexOf('.');
  const slash = name.lastIndexOf('/');
  return dot > slash ? name.slice(dot + 1).toLowerCase() : '';
}

function writeExtension(target, offset, name) {
  const ext = Buffer.alloc(4);
  ext.write(extensionOf(name), 0, 'latin1');
  ext.copy(target, offset);
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function writeU64(target, offset, value) {
  target.writeBigUInt64LE(BigInt(value), offset);
}

function buildGnrl(entries) {
  const records = [];
  for (const entry of entries) {
    const stored = entry.compress ? compress(entry.data) : entry.data;
    records.push({ entry, stored, packedSize: entry.compress ? stored.length : 0 });
  }
  const payloadBytes = records.reduce((sum, record) => sum + record.stored.length, 0);
  const nameTableOffset = HEADER_SIZE + GNRL_RECORD_SIZE * records.length + payloadBytes;
  const names = entries.map((entry) => Buffer.from(entry.path, 'utf8'));
  const nameBytes = names.reduce((sum, name) => sum + 2 + name.length, 0);
  const file = Buffer.alloc(nameTableOffset + nameBytes);

  file.write('BTDX', 0, 'latin1');
  file.writeUInt32LE(1, 4);
  file.write('GNRL', 8, 'latin1');
  file.writeUInt32LE(records.length, 12);
  writeU64(file, 16, nameTableOffset);

  let payloadOffset = HEADER_SIZE + GNRL_RECORD_SIZE * records.length;
  records.forEach((record, index) => {
    const base = HEADER_SIZE + index * GNRL_RECORD_SIZE;
    file.writeUInt32LE(fnv1a(record.entry.path), base);
    writeExtension(file, base + 4, record.entry.path);
    file.writeUInt32LE(fnv1a(path.posix.dirname(record.entry.path)), base + 8);
    file.writeUInt8(0, base + 12); // data file index
    file.writeUInt8(1, base + 13); // chunk count
    file.writeUInt16LE(0x10, base + 14); // chunk header size
    writeU64(file, base + 16, payloadOffset);
    file.writeUInt32LE(record.packedSize, base + 24);
    file.writeUInt32LE(record.entry.data.length, base + 28);
    file.writeUInt32LE(SENTINEL, base + 32);
    record.stored.copy(file, payloadOffset);
    payloadOffset += record.stored.length;
  });

  let nameOffset = nameTableOffset;
  for (const name of names) {
    file.writeUInt16LE(name.length, nameOffset);
    name.copy(file, nameOffset + 2);
    nameOffset += 2 + name.length;
  }

  return {
    file,
    entries: records.map((record) => ({
      path: record.entry.path,
      kind: 'GNRL',
      size: record.entry.data.length,
      compressed: record.packedSize > 0,
      sha256: sha256(record.entry.data),
    })),
  };
}

/**
 * @param entries {{ path: string, width: number, height: number, mips: number,
 *   format: number, cubemap?: boolean, chunks: [number, number, boolean][] }[]}
 *   `chunks` lists `[startMip, endMip, compressed]` ranges; ranges must cover
 *   every mip level exactly once.
 */
function buildDx10(entries) {
  const records = [];
  for (const entry of entries) {
    const faces = entry.cubemap ? 6 : 1;
    const chain = mipChainSize(entry.format, entry.width, entry.height, entry.mips);
    const payload = Buffer.alloc(chain * faces);
    for (let face = 0; face < faces; face++) {
      pattern(chain, face * 17 + 3).copy(payload, face * chain);
    }
    const chunks = entry.chunks.map(([startMip, endMip, compressed]) => {
      const offsetInPayload = chunkOffset(entry, startMip, faces);
      const size = chunkUnpackedSize(entry, startMip, endMip, faces);
      const chunkData = payload.subarray(offsetInPayload, offsetInPayload + size);
      const stored = compressed ? compress(chunkData) : chunkData;
      return { startMip, endMip, unpackedSize: size, packedSize: compressed ? stored.length : 0, stored };
    });
    const covered = chunks.reduce((sum, chunk) => sum + chunk.unpackedSize, 0);
    if (covered !== payload.length) {
      throw new Error(`${entry.path}: chunks cover ${covered} bytes, payload is ${payload.length}`);
    }
    records.push({ entry, payload, chunks });
  }

  const recordBytes = records.reduce(
    (sum, record) => sum + DX10_RECORD_SIZE + DX10_CHUNK_SIZE * record.chunks.length,
    0,
  );
  const payloadBytes = records.reduce(
    (sum, record) => sum + record.chunks.reduce((inner, chunk) => inner + chunk.stored.length, 0),
    0,
  );
  const nameTableOffset = HEADER_SIZE + recordBytes + payloadBytes;
  const names = entries.map((entry) => Buffer.from(entry.path, 'utf8'));
  const nameBytes = names.reduce((sum, name) => sum + 2 + name.length, 0);
  const file = Buffer.alloc(nameTableOffset + nameBytes);

  file.write('BTDX', 0, 'latin1');
  file.writeUInt32LE(1, 4);
  file.write('DX10', 8, 'latin1');
  file.writeUInt32LE(records.length, 12);
  writeU64(file, 16, nameTableOffset);

  let recordOffset = HEADER_SIZE;
  let payloadOffset = HEADER_SIZE + recordBytes;
  records.forEach((record) => {
    const base = recordOffset;
    file.writeUInt32LE(fnv1a(record.entry.path), base);
    writeExtension(file, base + 4, record.entry.path);
    file.writeUInt32LE(fnv1a(path.posix.dirname(record.entry.path)), base + 8);
    file.writeUInt8(0, base + 12); // unknown, zero in shipping archives
    file.writeUInt8(record.chunks.length, base + 13);
    file.writeUInt16LE(DX10_CHUNK_SIZE, base + 14);
    file.writeUInt16LE(record.entry.height, base + 16);
    file.writeUInt16LE(record.entry.width, base + 18);
    file.writeUInt8(record.entry.mips, base + 20);
    file.writeUInt8(record.entry.format, base + 21);
    file.writeUInt8(record.entry.cubemap ? 1 : 0, base + 22);
    file.writeUInt8(TILE_MODE_PC, base + 23);
    recordOffset += DX10_RECORD_SIZE;

    for (const chunk of record.chunks) {
      writeU64(file, recordOffset, payloadOffset);
      file.writeUInt32LE(chunk.packedSize, recordOffset + 8);
      file.writeUInt32LE(chunk.unpackedSize, recordOffset + 12);
      file.writeUInt16LE(chunk.startMip, recordOffset + 16);
      file.writeUInt16LE(chunk.endMip, recordOffset + 18);
      file.writeUInt32LE(SENTINEL, recordOffset + 20);
      chunk.stored.copy(file, payloadOffset);
      payloadOffset += chunk.stored.length;
      recordOffset += DX10_CHUNK_SIZE;
    }
  });

  let nameOffset = nameTableOffset;
  for (const name of names) {
    file.writeUInt16LE(name.length, nameOffset);
    name.copy(file, nameOffset + 2);
    nameOffset += 2 + name.length;
  }

  return {
    file,
    entries: records.map((record) => ({
      path: record.entry.path,
      kind: 'DX10',
      width: record.entry.width,
      height: record.entry.height,
      mips: record.entry.mips,
      format: record.entry.format,
      cubemap: Boolean(record.entry.cubemap),
      tileMode: TILE_MODE_PC,
      payloadSize: record.payload.length,
      payloadSha256: sha256(record.payload),
      size: DDS_HEADER_SIZE + record.payload.length,
      chunks: record.chunks.map((chunk) => ({
        startMip: chunk.startMip,
        endMip: chunk.endMip,
        unpackedSize: chunk.unpackedSize,
        compressed: chunk.packedSize > 0,
      })),
    })),
  };
}

/** Offset inside a face-major payload (face 0, then face 1, ...). */
function chunkOffset(entry, startMip, faces) {
  if (!faces || faces === 1) {
    return mipChainSizeBefore(entry, startMip);
  }
  return 0;
}

function mipChainSizeBefore(entry, startMip) {
  let total = 0;
  for (let level = 0; level < startMip; level++) {
    const dims = mipDimensions(entry.width, entry.height, level);
    total += mipLevelSize(entry.format, dims.width, dims.height);
  }
  return total;
}

function chunkUnpackedSize(entry, startMip, endMip, faces) {
  let total = 0;
  for (let level = startMip; level <= endMip; level++) {
    const dims = mipDimensions(entry.width, entry.height, level);
    total += mipLevelSize(entry.format, dims.width, dims.height);
  }
  return total * faces;
}

const configText = [
  'BA2 fixture archive',
  'format=GNRL',
  'entries=4',
  ...Array.from({ length: 12 }, (_, index) => `key${index}=value${index}`),
].join('\n').concat('\n');

const gnrl = buildGnrl([
  { path: 'interface/panel.swf', data: pattern(1536, 11), compress: true },
  { path: 'materials/steel.bgsm', data: pattern(120, 29), compress: false },
  { path: 'scripts/config.txt', data: Buffer.from(configText, 'utf8'), compress: true },
  { path: 'meshes/empty.bin', data: Buffer.alloc(0), compress: false },
]);

const dx10 = buildDx10([
  {
    path: 'textures/wall_d.dds',
    width: 128,
    height: 64,
    mips: 8,
    format: 71, // BC1_UNORM
    chunks: [[0, 7, true]],
  },
  {
    path: 'textures/detail_n.dds',
    width: 64,
    height: 64,
    mips: 4,
    format: 83, // BC5_UNORM
    chunks: [[0, 0, true], [1, 3, false]],
  },
  {
    path: 'textures/sky_e.dds',
    width: 32,
    height: 32,
    mips: 5,
    format: 77, // BC3_UNORM
    cubemap: true,
    chunks: [[0, 4, true]],
  },
]);

function encodeRawDeflate(data) {
  // Node zlib can produce raw deflate (no zlib header/trailer).
  const packed = zlib.deflateRawSync(data, { level: 9 });
  if (packed.length >= data.length) {
    throw new Error(`raw-deflate payload did not compress (${packed.length} >= ${data.length})`);
  }
  return packed;
}

// ---- v3 LZ4 GNRL archive (Starfield compression method 3) ----
{
  const LZ4_METHOD = 3;
  const HEADER_V3_SIZE = HEADER_SIZE + 12; // 24 + 8 unknown u32s + 4 method
  // The encoder lives in the library; `npm run build` has to run first.
  const { encodeLZ4Block } = await import('../dist/ba2/lz4.js');
  const rawWall = pattern(2048, 11);
  const rawTxt = Buffer.from(configText, 'utf8');
  const lz4Wall = encodeLZ4Block(rawWall);
  const lz4Txt = encodeLZ4Block(rawTxt);
  if (lz4Wall.length >= rawWall.length) throw new Error('LZ4 wall did not compress');
  if (lz4Txt.length >= rawTxt.length) throw new Error('LZ4 txt did not compress');

  const lz4PayloadBytes = lz4Wall.length + lz4Txt.length;
  const nameTableOffset = HEADER_V3_SIZE + GNRL_RECORD_SIZE * 2 + lz4PayloadBytes;
  const nameBytes = [
    Buffer.from('textures/wall.dds', 'utf8'),
    Buffer.from('scripts/config.txt', 'utf8'),
  ].reduce((s, n) => s + 2 + n.length, 0);
  const file = Buffer.alloc(nameTableOffset + nameBytes);

  file.write('BTDX', 0, 'latin1');
  file.writeUInt32LE(3, 4); // version 3
  file.write('GNRL', 8, 'latin1');
  file.writeUInt32LE(2, 12); // file count
  writeU64(file, 16, nameTableOffset);
  // 8 unknown bytes (zero)
  file.writeUInt32LE(0, HEADER_SIZE);
  file.writeUInt32LE(0, HEADER_SIZE + 4);
  // compression method = LZ4 (3) at HEADER_SIZE + 8
  file.writeUInt32LE(LZ4_METHOD, HEADER_SIZE + 8);

  let payloadOffset = HEADER_V3_SIZE + GNRL_RECORD_SIZE * 2;
  const rawEntries = [
    { path: 'textures/wall.dds', raw: rawWall, packed: lz4Wall },
    { path: 'scripts/config.txt', raw: rawTxt, packed: lz4Txt },
  ];
  rawEntries.forEach((entry, index) => {
    const base = HEADER_V3_SIZE + index * GNRL_RECORD_SIZE;
    file.writeUInt32LE(fnv1a(entry.path), base);
    writeExtension(file, base + 4, entry.path);
    file.writeUInt32LE(fnv1a(path.posix.dirname(entry.path)), base + 8);
    file.writeUInt8(0, base + 12);
    file.writeUInt8(1, base + 13);
    file.writeUInt16LE(0x10, base + 14);
    writeU64(file, base + 16, payloadOffset);
    file.writeUInt32LE(entry.packed.length, base + 24);
    file.writeUInt32LE(entry.raw.length, base + 28);
    file.writeUInt32LE(SENTINEL, base + 32);
    entry.packed.copy(file, payloadOffset);
    payloadOffset += entry.packed.length;
  });

  let nameOffset = nameTableOffset;
  for (const name of [Buffer.from('textures/wall.dds', 'utf8'), Buffer.from('scripts/config.txt', 'utf8')]) {
    file.writeUInt16LE(name.length, nameOffset);
    name.copy(file, nameOffset + 2);
    nameOffset += 2 + name.length;
  }

  const lz4ManifestEntries = rawEntries.map((entry) => ({
    path: entry.path,
    kind: 'GNRL',
    size: entry.raw.length,
    compressed: true,
    sha256: sha256(entry.raw),
  }));

  fs.writeFileSync(path.join(OUT_DIR, 'v3-lz4.ba2'), file);
  process.stdout.write(`test/fixtures/v3-lz4.ba2: ${file.length} bytes (LZ4 block, v3)\n`);

  // round-trip sanity: decode with the lib and compare
  const { Ba2Archive } = await import('../dist/index.js');
  const arch = Ba2Archive.open(path.join(OUT_DIR, 'v3-lz4.ba2'));
  try {
    for (let i = 0; i < arch.entries.length; i++) {
      const data = arch.readEntry(arch.entries[i]);
      if (!rawEntries[i].raw.equals(data)) throw new Error(`v3-lz4 round-trip failed for ${rawEntries[i].path}`);
    }
  } finally {
    arch.close();
  }

  // attach to manifest
  manifest.lz4 = { file: 'v3-lz4.ba2', entries: lz4ManifestEntries };
}

// ---- v1 GNRL archive with one raw-deflate payload ----
{
  const rawDeflateEntries = [
    { path: 'data.bin', data: pattern(1024, 7), compress: true },
  ];
  // Rebuild with raw deflate
  const raw = pattern(1024, 7);
  const packed = encodeRawDeflate(raw);
  const nameTableOffset = HEADER_SIZE + GNRL_RECORD_SIZE + packed.length;
  const nameBytes = Buffer.from('data.bin', 'utf8').length + 2;
  const file = Buffer.alloc(nameTableOffset + nameBytes);

  file.write('BTDX', 0, 'latin1');
  file.writeUInt32LE(1, 4);
  file.write('GNRL', 8, 'latin1');
  file.writeUInt32LE(1, 12);
  writeU64(file, 16, nameTableOffset);

  const base = HEADER_SIZE;
  file.writeUInt32LE(fnv1a('data.bin'), base);
  writeExtension(file, base + 4, 'data.bin');
  file.writeUInt32LE(fnv1a(''), base + 8);
  file.writeUInt8(0, base + 12);
  file.writeUInt8(1, base + 13);
  file.writeUInt16LE(0x10, base + 14);
  writeU64(file, base + 16, HEADER_SIZE + GNRL_RECORD_SIZE);
  file.writeUInt32LE(packed.length, base + 24);
  file.writeUInt32LE(raw.length, base + 28);
  file.writeUInt32LE(SENTINEL, base + 32);
  packed.copy(file, HEADER_SIZE + GNRL_RECORD_SIZE);

  let nameOffset = nameTableOffset;
  const name = Buffer.from('data.bin', 'utf8');
  file.writeUInt16LE(name.length, nameOffset);
  name.copy(file, nameOffset + 2);

  fs.writeFileSync(path.join(OUT_DIR, 'raw-deflate.ba2'), file);
  process.stdout.write(`test/fixtures/raw-deflate.ba2: ${file.length} bytes (raw deflate, v1)\n`);

  // round-trip sanity
  const { Ba2Archive } = await import('../dist/index.js');
  const arch = Ba2Archive.open(path.join(OUT_DIR, 'raw-deflate.ba2'));
  try {
    const data = arch.readEntry(arch.entries[0]);
    if (!raw.equals(data)) throw new Error('raw-deflate round-trip failed');
  } finally {
    arch.close();
  }

  manifest.rawDeflate = {
    file: 'raw-deflate.ba2',
    entries: [{ path: 'data.bin', kind: 'GNRL', size: raw.length, compressed: true, sha256: sha256(raw) }],
  };
}

manifest.gnrl = { file: 'gnrl.ba2', entries: gnrl.entries };
manifest.dx10 = { file: 'dx10.ba2', entries: dx10.entries };

fs.writeFileSync(path.join(OUT_DIR, 'gnrl.ba2'), gnrl.file);
fs.writeFileSync(path.join(OUT_DIR, 'dx10.ba2'), dx10.file);
fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

for (const [name, file] of [['gnrl.ba2', gnrl.file], ['dx10.ba2', dx10.file]]) {
  process.stdout.write(`test/fixtures/${name}: ${file.length} bytes\n`);
}
