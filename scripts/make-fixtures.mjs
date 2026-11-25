#!/usr/bin/env node
/**
 * Builds the committed test fixtures in `test/fixtures/`.
 *
 * The fixtures use the exact on-disk layout of the shipping Fallout 76
 * archives (BTDX version 1, 36 byte GNRL records / 24 byte DX10 records with
 * interleaved 24 byte chunk headers, `u16 length + bytes` name table), but the
 * payloads are synthetic so the repository stays small and free of game data.
 * One GNRL entry is stored, the rest are real zlib streams; one DX10 entry
 * splits its mip chain over two chunks and stores one of them uncompressed.
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

const manifest = {
  generatedBy: 'scripts/make-fixtures.mjs',
  note: 'Synthetic archives in the shipping BTDX version 1 layout; payloads are generated, not game data.',
  gnrl: { file: 'gnrl.ba2', entries: gnrl.entries },
  dx10: { file: 'dx10.ba2', entries: dx10.entries },
};

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'gnrl.ba2'), gnrl.file);
fs.writeFileSync(path.join(OUT_DIR, 'dx10.ba2'), dx10.file);
fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

for (const [name, file] of [['gnrl.ba2', gnrl.file], ['dx10.ba2', dx10.file]]) {
  process.stdout.write(`test/fixtures/${name}: ${file.length} bytes\n`);
}
