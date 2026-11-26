/**
 * BA2 archive writer: creates new BTDX archives from files or raw data.
 *
 * Mirrors the layout of shipping Fallout 4 / 76 archives (and Starfield v2/v3):
 * 24 byte header (+8 bytes for v2, +12 for v3 with the compression method),
 * fixed size records, payload region and a trailing name table. Entry offsets
 * are absolute file offsets, exactly like the archives the reader accepts.
 *
 * Chunking follows Archive2: at most `maxChunks` (default 4) chunks per
 * texture, a mip whose width and height both reach `singleMipChunkSize`
 * (default 512) starts its own chunk, remaining small mips share the last
 * chunk. Cubemaps are written as a single chunk covering the face-major
 * payload, which is the only layout that rebuilds byte-identical DDS files.
 *
 * Like Archive2, zero-length inputs are skipped and `-compression=Default`
 * (zlib) compresses every payload even when the stream ends up larger; an
 * entry that is *not* compressed records `packedSize = 0`.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import {
  BA2_ALIGN_SENTINEL,
  BA2_MAGIC,
  DX10_CHUNK_SIZE,
  DX10_RECORD_SIZE,
  GNRL_RECORD_SIZE,
  HEADER_SIZE,
  TILE_MODE_PC,
  type TextureChunk,
} from './format.js';
import { DDS_TOTAL_HEADER_SIZE } from './dds.js';
import { mipDimensions, mipLevelSize } from './dxgi.js';
import { encodeLZ4Block } from './lz4.js';

export type CreateFormat = 'GNRL' | 'DX10';
export type CreateCompression = 'zlib' | 'none' | 'lz4';

export interface CreateOptions {
  /**
   * Archive format. Optional for `createArchive` (auto-detected from the
   * input files: any `.dds` selects DX10); required for `Ba2Writer`.
   */
  format?: CreateFormat;
  /** Payload compression (default: zlib, Archive2's "Default"). */
  compression?: CreateCompression;
  /** Archive version: 1/7/8 (Fallout), 2/3 (Starfield). Default: 8. */
  version?: number;
  /** Base directory the entry paths are relative to (default: input dir). */
  root?: string;
  /** Maximum chunks per texture (default: 4, matches Archive2). */
  maxChunks?: number;
  /** Mip size that starts its own chunk (default: 512, matches Archive2). */
  singleMipChunkSize?: number;
  /** Omit the name table, like Archive2's -nostrings. */
  noStrings?: boolean;
}

export interface AddEntryOptions {
  /** Override the stored extension (default: derived from the path). */
  extension?: string;
}

export interface AddTextureOptions extends AddEntryOptions {
  path: string;
  width: number;
  height: number;
  mipCount: number;
  /** DXGI_FORMAT value stored verbatim in the record. */
  dxgiFormat: number;
  isCubemap: boolean;
  /** Tile mode stored verbatim (8 = PC / DDS). */
  tileMode: number;
  /** Complete texture payload (every face/mip, in file order). */
  data?: Buffer;
  /**
   * Per-mip payloads; concatenated they must form the complete texture
   * payload. Convenient for single-face textures.
   */
  mipData?: Buffer[];
}

interface PendingEntry {
  kind: 'GNRL';
  path: string;
  extension: string;
  data: Buffer;
}

interface PendingTexture {
  kind: 'DX10';
  path: string;
  extension: string;
  width: number;
  height: number;
  mipCount: number;
  dxgiFormat: number;
  isCubemap: boolean;
  tileMode: number;
  payload: Buffer;
}

type Pending = PendingEntry | PendingTexture;

/** A chunk range plus its absolute archive offset and stored bytes. */
interface PreparedChunk {
  startMip: number;
  endMip: number;
  unpackedSize: number;
  packedSize: number;
  offset: number;
  stored: Buffer;
}

interface Prepared {
  entry: Pending;
  chunks: PreparedChunk[];
}

const VALID_VERSIONS = [1, 2, 3, 7, 8];

/** The options Ba2Writer actually runs with, after defaults are applied. */
interface ResolvedOptions {
  format: CreateFormat;
  compression: CreateCompression;
  version: number;
  maxChunks: number;
  singleMipChunkSize: number;
  noStrings: boolean;
}

export class Ba2Writer {
  #options: ResolvedOptions;
  #pending: Pending[] = [];
  #fd: number | null = null;
  readonly path: string;
  #closed = false;

  static open(archivePath: string, options: CreateOptions): Ba2Writer {
    if (options.format !== 'GNRL' && options.format !== 'DX10') {
      throw new Error(`Ba2Writer.open needs an explicit format ('GNRL' or 'DX10'), got ${JSON.stringify(options.format)}`);
    }
    const compression = options.compression ?? 'zlib';
    const version = options.version ?? 8;
    if (!VALID_VERSIONS.includes(version)) {
      throw new Error(`unsupported archive version ${version} (expected one of ${VALID_VERSIONS.join(', ')})`);
    }
    if (compression === 'lz4' && version !== 3) {
      throw new Error('LZ4 compression requires archive version 3 (Starfield)');
    }
    const fd = fs.openSync(archivePath, 'w');
    return new Ba2Writer(archivePath, {
      format: options.format,
      compression,
      version,
      maxChunks: options.maxChunks ?? 4,
      singleMipChunkSize: options.singleMipChunkSize ?? 512,
      noStrings: options.noStrings ?? false,
    }, fd);
  }

  private constructor(archivePath: string, options: ResolvedOptions, fd: number) {
    this.path = archivePath;
    this.#options = options;
    this.#fd = fd;
  }

  /** Queues one general file. Zero-length data is skipped (Archive2 behavior). */
  addEntry(entryPath: string, data: Buffer | Uint8Array, options?: AddEntryOptions): void {
    this.#assertOpen();
    if (this.#options.format !== 'GNRL') {
      throw new Error(`addEntry requires a GNRL archive (this writer creates ${this.#options.format})`);
    }
    if (data.length === 0) return;
    const clean = entryPath.replace(/\\/g, '/');
    const extension = (options?.extension ?? extensionOf(clean) ?? 'bin').toLowerCase();
    this.#pending.push({
      kind: 'GNRL',
      path: clean,
      extension: extension.slice(0, 4),
      data: Buffer.isBuffer(data) ? data : Buffer.from(data),
    });
  }

  /** Queues one texture. Zero-length payloads are skipped (Archive2 behavior). */
  async addTexture(options: AddTextureOptions): Promise<void> {
    this.#assertOpen();
    if (this.#options.format !== 'DX10') {
      throw new Error(`addTexture requires a DX10 archive (this writer creates ${this.#options.format})`);
    }
    const payload = options.data ?? Buffer.concat(options.mipData ?? []);
    if (payload.length === 0) return;
    if (options.mipCount > 255) throw new Error(`${options.path}: mipCount ${options.mipCount} does not fit in a byte`);
    this.#pending.push({
      kind: 'DX10',
      path: options.path.replace(/\\/g, '/'),
      extension: (options.extension ?? 'dds').toLowerCase().slice(0, 4),
      width: options.width,
      height: options.height,
      mipCount: options.mipCount,
      dxgiFormat: options.dxgiFormat,
      isCubemap: options.isCubemap,
      tileMode: options.tileMode,
      payload,
    });
  }

  /** Writes the archive and closes the file. Idempotent. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const fd = this.#fd;
    this.#fd = null;
    try {
      if (fd !== null) await this.#writeArchive(fd);
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('writer is closed');
  }

  async #writeArchive(fd: number): Promise<void> {
    const options = this.#options;
    const sorted = [...this.#pending].sort((a, b) => a.path.localeCompare(b.path));

    // Split every texture into chunk ranges before laying out the file, so
    // the record table size is known before payload offsets are assigned.
    // GNRL entries get a single whole-payload chunk, like Archive2 does.
    const prepared: Prepared[] = sorted.map((entry) => ({
      entry,
      chunks: entry.kind === 'DX10'
        ? this.#chunkRanges(entry).map((range) => ({
            startMip: range.startMip,
            endMip: range.endMip,
            unpackedSize: range.end - range.start,
            packedSize: 0,
            offset: 0,
            stored: Buffer.alloc(0),
          }))
        : [{
            startMip: 0,
            endMip: 0,
            unpackedSize: entry.data.length,
            packedSize: 0,
            offset: 0,
            stored: Buffer.alloc(0),
          }],
    }));

    const extraHeaderBytes = options.version === 2 ? 8 : options.version === 3 ? 12 : 0;
    const recordTableOffset = HEADER_SIZE + extraHeaderBytes;
    const recordTableSize = prepared.reduce((sum, item) => {
      if (item.entry.kind === 'GNRL') return sum + GNRL_RECORD_SIZE;
      return sum + DX10_RECORD_SIZE + DX10_CHUNK_SIZE * item.chunks.length;
    }, 0);

    // Compress payloads and assign absolute offsets.
    let payloadOffset = recordTableOffset + recordTableSize;
    for (const item of prepared) {
      const pieces: Buffer[] = [];
      if (item.entry.kind === 'GNRL') {
        pieces.push(item.entry.data);
      } else {
        for (let index = 0; index < item.chunks.length; index++) {
          pieces.push(this.#chunkData(item.entry, item.chunks, index));
        }
      }
      for (let index = 0; index < pieces.length; index++) {
        const stored = await this.#compress(pieces[index]!);
        const chunk = item.chunks[index]!;
        chunk.offset = payloadOffset;
        chunk.stored = stored;
        chunk.packedSize = this.#isStoredUncompressed(stored, pieces[index]!) ? 0 : stored.length;
        payloadOffset += stored.length;
      }
    }

    const nameTableOffset = options.noStrings ? 0 : payloadOffset;

    // Header (written last too; the first copy is a placeholder for layout).
    const header = this.#buildHeader(sorted.length, nameTableOffset);
    fs.writeSync(fd, header, 0, header.length, 0);

    // Record table.
    let recordOffset = recordTableOffset;
    for (const item of prepared) {
      const entry = item.entry;
      if (entry.kind === 'GNRL') {
        const record = Buffer.alloc(GNRL_RECORD_SIZE);
        record.writeUInt32LE(fnv1a(entry.path), 0);
        Buffer.from(entry.extension, 'latin1').copy(record, 4);
        record.writeUInt32LE(fnv1a(path.posix.dirname(entry.path)), 8);
        record.writeUInt8(0, 12); // data file index
        record.writeUInt8(1, 13); // chunk count
        record.writeUInt16LE(0x10, 14); // chunk header size
        record.writeBigUInt64LE(BigInt(item.chunks[0]!.offset), 16);
        record.writeUInt32LE(item.chunks[0]!.packedSize, 24);
        record.writeUInt32LE(entry.data.length, 28);
        record.writeUInt32LE(BA2_ALIGN_SENTINEL, 32);
        fs.writeSync(fd, record, 0, record.length, recordOffset);
        recordOffset += record.length;
      } else {
        const record = Buffer.alloc(DX10_RECORD_SIZE);
        record.writeUInt32LE(fnv1a(entry.path), 0);
        Buffer.from(entry.extension, 'latin1').copy(record, 4);
        record.writeUInt32LE(fnv1a(path.posix.dirname(entry.path)), 8);
        record.writeUInt8(0, 12); // unknown, zero in shipping archives
        record.writeUInt8(item.chunks.length, 13);
        record.writeUInt16LE(DX10_CHUNK_SIZE, 14);
        record.writeUInt16LE(entry.height, 16);
        record.writeUInt16LE(entry.width, 18);
        record.writeUInt8(entry.mipCount, 20);
        record.writeUInt8(entry.dxgiFormat, 21);
        record.writeUInt8(entry.isCubemap ? 1 : 0, 22);
        record.writeUInt8(entry.tileMode, 23);
        fs.writeSync(fd, record, 0, record.length, recordOffset);
        recordOffset += record.length;

        for (const chunk of item.chunks) {
          const chunkRecord = Buffer.alloc(DX10_CHUNK_SIZE);
          chunkRecord.writeBigUInt64LE(BigInt(chunk.offset), 0);
          chunkRecord.writeUInt32LE(chunk.packedSize, 8);
          chunkRecord.writeUInt32LE(chunk.unpackedSize, 12);
          chunkRecord.writeUInt16LE(chunk.startMip, 16);
          chunkRecord.writeUInt16LE(chunk.endMip, 18);
          chunkRecord.writeUInt32LE(BA2_ALIGN_SENTINEL, 20);
          fs.writeSync(fd, chunkRecord, 0, chunkRecord.length, recordOffset);
          recordOffset += chunkRecord.length;
        }
      }
    }

    // Payloads.
    for (const item of prepared) {
      for (const chunk of item.chunks) {
        fs.writeSync(fd, chunk.stored, 0, chunk.stored.length, chunk.offset);
      }
    }

    // Name table: u16 length + UTF-8 bytes per record, in record order.
    if (!options.noStrings) {
      let nameOffset = nameTableOffset;
      for (const item of prepared) {
        const name = Buffer.from(item.entry.path, 'utf8');
        const length = Buffer.alloc(2);
        length.writeUInt16LE(name.length, 0);
        fs.writeSync(fd, length, 0, 2, nameOffset);
        fs.writeSync(fd, name, 0, name.length, nameOffset + 2);
        nameOffset += 2 + name.length;
      }
    }

    // Final header with the real name table offset.
    fs.writeSync(fd, this.#buildHeader(sorted.length, nameTableOffset), 0, header.length, 0);
  }

  /**
   * True when the payload is stored raw (`packedSize = 0` in the record):
   * `compression: 'none'`, or a zero-length piece (skipped earlier anyway).
   * Archive2's Default mode keeps compressed streams even when they are
   * larger than the input, so size is deliberately not considered here.
   */
  #isStoredUncompressed(stored: Buffer, raw: Buffer): boolean {
    return this.#options.compression === 'none' || stored === raw;
  }

  async #compress(data: Buffer): Promise<Buffer> {
    switch (this.#options.compression) {
      case 'none':
        return data;
      case 'lz4':
        return encodeLZ4Block(data);
      default:
        return zlib.deflateSync(data, { level: zlib.constants.Z_DEFAULT_COMPRESSION });
    }
  }

  /** Byte ranges of every chunk inside the texture payload. */
  #chunkRanges(entry: PendingTexture): Array<{ startMip: number; endMip: number; start: number; end: number }> {
    const faces = entry.isCubemap ? 6 : 1;
    const sizes: number[] = [];
    let chainSize = 0;
    const offsets: number[] = [];
    for (let level = 0; level < entry.mipCount; level++) {
      offsets.push(chainSize);
      const dims = mipDimensions(entry.width, entry.height, level);
      const size = mipLevelSize(entry.dxgiFormat, dims.width, dims.height);
      sizes.push(size);
      chainSize += size;
    }
    const expected = chainSize * faces;
    if (entry.payload.length !== expected) {
      // A single-mip payload is accepted at any size (the chunk simply covers
      // it whole); anything else means the metadata does not match the data.
      if (entry.mipCount > 1) {
        throw new Error(
          `${entry.path}: payload is ${entry.payload.length} bytes but ${expected} bytes were expected for ` +
            `${entry.width}x${entry.height}, ${entry.mipCount} mip(s), DXGI format ${entry.dxgiFormat}` +
            (faces > 1 ? ', 6 faces' : ''),
        );
      }
      return [{ startMip: 0, endMip: 0, start: 0, end: entry.payload.length }];
    }

    // Cubemaps stay in one chunk: their payload is face-major, so a mip-range
    // chunk could not be expressed as one contiguous byte range.
    if (faces > 1 || this.#options.maxChunks <= 1 || entry.mipCount === 1) {
      return [{ startMip: 0, endMip: entry.mipCount - 1, start: 0, end: entry.payload.length }];
    }

    // Archive2: a mip reaching the chunk size in both dimensions starts its
    // own chunk (up to maxChunks - 1 splits); the rest share the last chunk.
    const ranges: Array<{ startMip: number; endMip: number; start: number; end: number }> = [];
    let startMip = 0;
    for (let level = 1; level < entry.mipCount; level++) {
      const dims = mipDimensions(entry.width, entry.height, level);
      const bigEnough = dims.width >= this.#options.singleMipChunkSize && dims.height >= this.#options.singleMipChunkSize;
      if (bigEnough && ranges.length < this.#options.maxChunks - 1) {
        ranges.push(this.#range(entry, startMip, level - 1, offsets, sizes));
        startMip = level;
      }
    }
    ranges.push(this.#range(entry, startMip, entry.mipCount - 1, offsets, sizes));
    return ranges;
  }

  #range(
    entry: PendingTexture,
    startMip: number,
    endMip: number,
    offsets: number[],
    sizes: number[],
  ): { startMip: number; endMip: number; start: number; end: number } {
    const start = offsets[startMip]!;
    const end = offsets[endMip]! + sizes[endMip]!;
    return { startMip, endMip, start, end };
  }

  /** The raw bytes of chunk `index` of a DX10 entry. */
  #chunkData(entry: PendingTexture, chunks: PreparedChunk[], index: number): Buffer {
    const range = this.#chunkRanges(entry)[index]!;
    void chunks;
    return entry.payload.subarray(range.start, range.end);
  }

  #buildHeader(fileCount: number, nameTableOffset: number): Buffer {
    const options = this.#options;
    const extraHeaderBytes = options.version === 2 ? 8 : options.version === 3 ? 12 : 0;
    const header = Buffer.alloc(HEADER_SIZE + extraHeaderBytes);
    Buffer.from(BA2_MAGIC, 'latin1').copy(header, 0);
    header.writeUInt32LE(options.version, 4);
    Buffer.from(options.format, 'latin1').copy(header, 8);
    header.writeUInt32LE(fileCount, 12);
    header.writeBigUInt64LE(BigInt(nameTableOffset), 16);
    if (options.version === 3) {
      // 8 unknown zero bytes, then the compression method (0 = zlib, 3 = LZ4).
      header.writeUInt32LE(options.compression === 'lz4' ? 3 : 0, HEADER_SIZE + 8);
    }
    return header;
  }
}

/**
 * High-level helper: creates an archive from a directory tree.
 *
 * - `format` defaults to auto-detection: any `.dds` file selects DX10, any
 *   other content selects GNRL. In DX10 mode non-DDS files are ignored.
 * - Zero-length files are skipped, like Archive2.
 * - DDS files are parsed for dimensions, mip count, DXGI format and cubemap
 *   flag; their 148 byte header is regenerated on extraction.
 */
export async function createArchive(
  outputPath: string,
  inputDir: string,
  options: CreateOptions = {},
): Promise<void> {
  const root = options.root ?? inputDir;
  const files = findFiles(inputDir, root);
  const format = options.format ?? (files.some((file) => file.extension === 'dds') ? 'DX10' : 'GNRL');
  const selected = files.filter((file) => (format === 'DX10' ? file.extension === 'dds' : file.size > 0));

  const writer = Ba2Writer.open(outputPath, { ...options, format });
  try {
    for (const file of selected) {
      const data = fs.readFileSync(file.fullPath);
      if (format === 'DX10') {
        const texture = parseDdsForWriter(data, file.relPath);
        await writer.addTexture({ path: file.relPath, ...texture });
      } else {
        writer.addEntry(file.relPath, data);
      }
    }
  } finally {
    await writer.close();
  }
}

function findFiles(dir: string, root: string): Array<{ relPath: string; fullPath: string; extension: string; size: number }> {
  const results: Array<{ relPath: string; fullPath: string; extension: string; size: number }> = [];

  const visit = (current: string): void => {
    for (const item of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, item.name);
      if (item.isDirectory()) {
        visit(fullPath);
      } else if (item.isFile()) {
        const relPath = path.relative(root, fullPath).split(path.sep).join('/');
        results.push({ relPath, fullPath, extension: extensionOf(relPath) ?? '', size: fs.statSync(fullPath).size });
      }
    }
  };

  visit(dir);
  return results.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

function extensionOf(entryPath: string): string | undefined {
  const dot = entryPath.lastIndexOf('.');
  const slash = entryPath.lastIndexOf('/');
  return dot > slash && dot + 1 < entryPath.length ? entryPath.slice(dot + 1).toLowerCase() : undefined;
}

/** Parses a DDS file into the metadata and payload `addTexture` expects. */
function parseDdsForWriter(data: Buffer, label: string): {
  path?: string;
  width: number;
  height: number;
  mipCount: number;
  dxgiFormat: number;
  isCubemap: boolean;
  tileMode: number;
  data: Buffer;
} {
  if (data.length < DDS_TOTAL_HEADER_SIZE || data.toString('latin1', 0, 4) !== 'DDS ') {
    throw new Error(`${label}: not a DDS file`);
  }

  const height = data.readUInt32LE(12);
  const width = data.readUInt32LE(16);
  const mipCount = Math.max(1, data.readUInt32LE(28));
  const caps2 = data.readUInt32LE(112);
  const isCubemap = (caps2 & 0x200) !== 0; // DDSCAPS2_CUBEMAP

  let dxgiFormat: number;
  if (data.toString('latin1', 84, 88) === 'DX10') {
    dxgiFormat = data.readUInt32LE(128);
  } else {
    const fourCC = data.toString('latin1', 84, 88).replace(/\0+$/, '');
    const legacy: Record<string, number> = {
      DXT1: 71,
      DXT3: 74,
      DXT5: 77,
      BC4U: 80,
      BC5U: 83,
      ATI1: 80,
      ATI2: 83,
    };
    if (!(fourCC in legacy)) {
      throw new Error(`${label}: unsupported DDS pixel format ${JSON.stringify(fourCC)}`);
    }
    dxgiFormat = legacy[fourCC]!;
  }

  if (width === 0 || height === 0) {
    throw new Error(`${label}: DDS has zero extent`);
  }

  return {
    width,
    height,
    mipCount,
    dxgiFormat,
    isCubemap,
    tileMode: TILE_MODE_PC,
    data: data.subarray(DDS_TOTAL_HEADER_SIZE),
  };
}

/** Cheap FNV-1a; fills the record hash fields (readers never use them). */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(text, 'utf8')) {
    hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  }
  return hash;
}

export type { TextureChunk };
