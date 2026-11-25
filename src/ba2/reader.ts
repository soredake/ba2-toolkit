/**
 * BA2 archive reader.
 *
 * The archive is opened once and kept open; every file payload is fetched with
 * positional reads, so multi-gigabyte Fallout 76 archives never have to be
 * loaded into memory.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import {
  BA2_ALIGN_SENTINEL,
  BA2_MAGIC,
  DX10_CHUNK_SIZE,
  DX10_RECORD_SIZE,
  GNRL_RECORD_SIZE,
  HEADER_SIZE,
  TILE_MODE_PC,
  type ArchiveKind,
  type Ba2Entry,
  type Ba2Header,
  type GnrlEntry,
  type TextureChunk,
  type TextureEntry,
} from './format.js';
import { buildDdsHeader } from './dds.js';
import { dxgiFormatName } from './dxgi.js';

const MAX_NAME_TABLE_BYTES = 256 * 1024 * 1024;

export interface ArchiveSummary {
  path: string;
  header: Ba2Header;
  fileCount: number;
  /** Bytes of decompressed payload (DDS header included for textures). */
  unpackedBytes: number;
  /** Bytes of payload actually stored in the archive. */
  storedBytes: number;
  compressedFiles: number;
  formats: { format: number; name: string; count: number }[];
  extensions: { extension: string; count: number }[];
  cubemaps: number;
  nonPcTiling: number;
}

export class Ba2Archive {
  readonly path: string;
  readonly header: Ba2Header;
  readonly entries: Ba2Entry[];
  readonly fileSize: number;
  #fd: number | null;

  private constructor(
    path: string,
    header: Ba2Header,
    entries: Ba2Entry[],
    fd: number,
    fileSize: number,
  ) {
    this.path = path;
    this.header = header;
    this.entries = entries;
    this.#fd = fd;
    this.fileSize = fileSize;
  }

  static open(path: string): Ba2Archive {
    const fd = fs.openSync(path, 'r');
    try {
      const fileSize = fs.fstatSync(fd).size;
      const header = readHeader(fd, path, fileSize);
      const entries = readRecords(fd, header, fileSize);
      attachNames(fd, header, entries, fileSize);
      return new Ba2Archive(path, header, entries, fd, fileSize);
    } catch (error) {
      fs.closeSync(fd);
      throw error;
    }
  }

  close(): void {
    if (this.#fd !== null) {
      fs.closeSync(this.#fd);
      this.#fd = null;
    }
  }

  /** Reads `size` bytes at `offset` without moving a shared file position. */
  readStored(offset: number, size: number): Buffer {
    const fd = this.#fd;
    if (fd === null) throw new Error('archive is closed');
    if (size < 0) throw new Error(`negative read size (${size})`);
    if (offset + size > this.fileSize) {
      throw new Error(
        `read past end of archive: offset ${offset} + ${size} > ${this.fileSize}`,
      );
    }
    const buffer = Buffer.allocUnsafe(size);
    let read = 0;
    while (read < size) {
      read += fs.readSync(fd, buffer, read, size - read, offset + read);
    }
    return buffer;
  }

  /** Decompressed bytes of one stored payload (without the DDS header). */
  readChunks(entry: TextureEntry): Buffer[] {
    return entry.chunks.map((chunk, index) =>
      readPayload(
        this.readStored(chunk.offset, chunk.packedSize || chunk.unpackedSize),
        chunk.packedSize,
        chunk.unpackedSize,
        `${entry.path} chunk ${index}`,
      ),
    );
  }

  /**
   * Returns the ready-to-write file contents: the raw file for GNRL archives,
   * or a complete DDS file for DX10 texture archives.
   */
  readEntry(entry: Ba2Entry | number): Buffer {
    const resolved = typeof entry === 'number' ? this.entries[entry] : entry;
    if (!resolved) throw new RangeError(`no archive entry at index ${String(entry)}`);
    if (resolved.kind === 'GNRL') {
      return readPayload(
        this.readStored(
          resolved.offset,
          resolved.packedSize || resolved.unpackedSize,
        ),
        resolved.packedSize,
        resolved.unpackedSize,
        resolved.path,
      );
    }
    if (resolved.tileMode !== TILE_MODE_PC) {
      throw new Error(
        `${resolved.path}: Xbox tiled texture (tile mode ${resolved.tileMode}) cannot be written as DDS`,
      );
    }
    const header = buildDdsHeader(resolved);
    const chunks = this.readChunks(resolved);
    return Buffer.concat([header, ...chunks], header.length + sumUnpacked(resolved));
  }

  /** Parts of a file, avoiding a large concat when writing to disk. */
  readEntryParts(entry: Ba2Entry): { parts: Buffer[]; size: number } {
    if (entry.kind === 'GNRL') {
      const data = this.readEntry(entry);
      return { parts: [data], size: data.length };
    }
    if (entry.tileMode !== TILE_MODE_PC) {
      throw new Error(
        `${entry.path}: Xbox tiled texture (tile mode ${entry.tileMode}) cannot be written as DDS`,
      );
    }
    const parts = [buildDdsHeader(entry), ...this.readChunks(entry)];
    return { parts, size: parts.reduce((sum, part) => sum + part.length, 0) };
  }

  summary(): ArchiveSummary {
    const formats = new Map<number, number>();
    const extensions = new Map<string, number>();
    let unpackedBytes = 0;
    let storedBytes = 0;
    let compressedFiles = 0;
    let cubemaps = 0;
    let nonPcTiling = 0;

    for (const entry of this.entries) {
      extensions.set(entry.extension, (extensions.get(entry.extension) ?? 0) + 1);
      if (entry.kind === 'GNRL') {
        unpackedBytes += entry.unpackedSize;
        storedBytes += entry.packedSize || entry.unpackedSize;
        if (entry.packedSize > 0) compressedFiles++;
      } else {
        formats.set(entry.dxgiFormat, (formats.get(entry.dxgiFormat) ?? 0) + 1);
        if (entry.isCubemap) cubemaps++;
        if (entry.tileMode !== TILE_MODE_PC) nonPcTiling++;
        for (const chunk of entry.chunks) {
          unpackedBytes += chunk.unpackedSize;
          storedBytes += chunk.packedSize || chunk.unpackedSize;
          if (chunk.packedSize > 0) compressedFiles++;
        }
      }
    }

    return {
      path: this.path,
      header: this.header,
      fileCount: this.entries.length,
      unpackedBytes,
      storedBytes,
      compressedFiles,
      formats: [...formats.entries()]
        .map(([format, count]) => ({ format, name: dxgiFormatName(format), count }))
        .sort((a, b) => b.count - a.count),
      extensions: [...extensions.entries()]
        .map(([extension, count]) => ({ extension, count }))
        .sort((a, b) => b.count - a.count),
      cubemaps,
      nonPcTiling,
    };
  }
}

export function openArchive(path: string): Ba2Archive {
  return Ba2Archive.open(path);
}

function readHeader(fd: number, path: string, fileSize: number): Ba2Header {
  if (fileSize < HEADER_SIZE) {
    throw new Error(`${path}: file is too small to be a BA2 archive`);
  }
  const buffer = Buffer.allocUnsafe(HEADER_SIZE + 16);
  readExact(fd, buffer, 0, Math.min(buffer.length, fileSize), 0);

  const magic = buffer.toString('latin1', 0, 4);
  if (magic !== BA2_MAGIC) {
    throw new Error(`${path}: not a BA2 archive (magic ${JSON.stringify(magic)})`);
  }
  const version = buffer.readUInt32LE(4);
  const kind = buffer.toString('latin1', 8, 12) as ArchiveKind;
  if (kind !== 'GNRL' && kind !== 'DX10' && kind !== 'GNMF') {
    throw new Error(`${path}: unsupported archive type ${JSON.stringify(kind)}`);
  }
  if (kind === 'GNMF') {
    throw new Error(`${path}: GNMF archives (PlayStation textures) are not supported`);
  }
  if (version >= 3) {
    const method = buffer.readUInt32LE(HEADER_SIZE + 8);
    if (method !== 0) {
      throw new Error(
        `${path}: archive uses compression method ${method}; only zlib (0) is supported`,
      );
    }
  }
  const fileCount = buffer.readUInt32LE(12);
  const nameTableOffset = Number(buffer.readBigUInt64LE(16));
  const extraHeaderBytes = version >= 2 ? 8 : 0;
  const recordTableOffset = HEADER_SIZE + extraHeaderBytes;
  if (fileCount > 5_000_000) {
    throw new Error(`${path}: implausible file count ${fileCount}, archive looks corrupt`);
  }
  return {
    magic,
    version,
    kind,
    fileCount,
    nameTableOffset,
    extraHeaderBytes,
    recordTableOffset,
  };
}

function readRecords(fd: number, header: Ba2Header, fileSize: number): Ba2Entry[] {
  const count = header.fileCount;
  if (count === 0) return [];

  if (header.kind === 'GNRL') {
    const table = readExact(fd, Buffer.allocUnsafe(count * GNRL_RECORD_SIZE), 0, count * GNRL_RECORD_SIZE, header.recordTableOffset);
    const entries: GnrlEntry[] = [];
    for (let i = 0; i < count; i++) {
      const base = i * GNRL_RECORD_SIZE;
      entries.push({
        kind: 'GNRL',
        index: i,
        path: '',
        extension: '',
        nameHash: table.readUInt32LE(base),
        dirHash: table.readUInt32LE(base + 8),
        flags: table.readUInt32LE(base + 12),
        offset: Number(table.readBigUInt64LE(base + 16)),
        packedSize: table.readUInt32LE(base + 24),
        unpackedSize: table.readUInt32LE(base + 28),
        // table.readUInt32LE(base + 32) === BA2_ALIGN_SENTINEL
      });
      entries[i]!.extension = table.toString('latin1', base + 4, base + 8).replace(/\0.*$/, '').toLowerCase();
    }
    return entries;
  }

  // DX10: each file record is followed by its own chunk records, so the table
  // has to be walked sequentially.
  const stream = new RecordStream(fd, header.recordTableOffset);
  const entries: TextureEntry[] = [];
  for (let i = 0; i < count; i++) {
    const nameHash = stream.u32();
    const extension = stream.bytes(4).toString('latin1').replace(/\0.*$/, '').toLowerCase();
    const dirHash = stream.u32();
    stream.skip(1); // unknown
    const chunkCount = stream.u8();
    const chunkHeaderSize = stream.u16();
    const height = stream.u16();
    const width = stream.u16();
    const mipCount = stream.u8();
    const dxgiFormat = stream.u8();
    const isCubemap = stream.u8() !== 0;
    const tileMode = stream.u8();
    if (chunkHeaderSize !== DX10_CHUNK_SIZE) {
      throw new Error(
        `record ${i}: unsupported texture chunk header size ${chunkHeaderSize} (expected ${DX10_CHUNK_SIZE})`,
      );
    }
    const chunks: TextureChunk[] = [];
    for (let c = 0; c < chunkCount; c++) {
      chunks.push({
        offset: stream.u64(),
        packedSize: stream.u32(),
        unpackedSize: stream.u32(),
        startMip: stream.u16(),
        endMip: stream.u16(),
        // trailing u32 is BA2_ALIGN_SENTINEL
      });
      stream.skip(4);
    }
    entries.push({
      kind: 'DX10',
      index: i,
      path: '',
      extension,
      nameHash,
      dirHash,
      width,
      height,
      mipCount,
      dxgiFormat,
      isCubemap,
      tileMode,
      chunks,
    });
  }
  return entries;
}

/** Sequential reader over the record table with a sliding window. */
class RecordStream {
  #fd: number;
  #pos: number;
  #buffer: Buffer = Buffer.alloc(0);
  #start = 0;

  constructor(fd: number, start: number) {
    this.#fd = fd;
    this.#pos = start;
  }

  #ensure(size: number): void {
    if (this.#pos + size <= this.#start + this.#buffer.length) return;
    const window = Buffer.allocUnsafe(Math.max(size, 1 << 20));
    let filled = 0;
    while (filled < window.length) {
      const read = fs.readSync(
        this.#fd,
        window,
        filled,
        window.length - filled,
        this.#pos,
      );
      if (read === 0) break;
      filled += read;
      if (filled >= size) break;
    }
    if (filled < size) throw new Error('unexpected end of archive inside the record table');
    this.#buffer = window.subarray(0, filled);
    this.#start = this.#pos;
  }

  bytes(size: number): Buffer {
    this.#ensure(size);
    const view = this.#buffer.subarray(this.#pos - this.#start, this.#pos - this.#start + size);
    this.#pos += size;
    return view;
  }

  skip(size: number): void {
    this.#pos += size;
  }

  u8(): number {
    this.#ensure(1);
    return this.#buffer[this.#pos++ - this.#start]!;
  }

  u16(): number {
    this.#ensure(2);
    const value = this.#buffer.readUInt16LE(this.#pos - this.#start);
    this.#pos += 2;
    return value;
  }

  u32(): number {
    this.#ensure(4);
    const value = this.#buffer.readUInt32LE(this.#pos - this.#start);
    this.#pos += 4;
    return value;
  }

  u64(): number {
    this.#ensure(8);
    const value = Number(this.#buffer.readBigUInt64LE(this.#pos - this.#start));
    this.#pos += 8;
    return value;
  }
}

function attachNames(
  fd: number,
  header: Ba2Header,
  entries: Ba2Entry[],
  fileSize: number,
): void {
  let cursor = 0;
  let table: Buffer | null = null;
  if (header.nameTableOffset > 0 && header.nameTableOffset < fileSize) {
    const length = Math.min(fileSize - header.nameTableOffset, MAX_NAME_TABLE_BYTES);
    table = readExact(fd, Buffer.allocUnsafe(length), 0, length, header.nameTableOffset);
  }

  for (const entry of entries) {
    let name: string | null = null;
    if (table && cursor + 2 <= table.length) {
      const nameLength = table.readUInt16LE(cursor);
      cursor += 2;
      if (nameLength > 0 && cursor + nameLength <= table.length) {
        name = table.toString('utf8', cursor, cursor + nameLength);
        cursor += nameLength;
      } else {
        cursor += Math.max(0, nameLength);
      }
    }
    const safe = name ? normalizeEntryPath(name) : '';
    entry.path = safe || `unnamed/${entry.index}.${entry.extension || 'bin'}`;
    const dot = entry.path.lastIndexOf('.');
    const slash = entry.path.lastIndexOf('/');
    if (dot > slash) entry.extension = entry.path.slice(dot + 1).toLowerCase();
  }
}

/** Normalises a stored path into a safe relative path. */
export function normalizeEntryPath(raw: string): string {
  const parts = raw
    .replace(/\\/g, '/')
    .replace(/^[a-zA-Z]:/, '')
    .split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      out.pop();
      continue;
    }
    out.push(part.replace(/[\0:*?"<>|]/g, '_'));
  }
  return out.join('/');
}

function readPayload(
  stored: Buffer,
  packedSize: number,
  unpackedSize: number,
  label: string,
): Buffer {
  if (packedSize === 0) return stored;
  let out: Buffer;
  try {
    out = zlib.inflateSync(stored);
  } catch {
    try {
      out = zlib.inflateRawSync(stored);
    } catch (error) {
      throw new Error(
        `${label}: inflate failed (${(error as Error).message})`,
      );
    }
  }
  if (out.length !== unpackedSize) {
    throw new Error(
      `${label}: inflated ${out.length} bytes but the archive says ${unpackedSize}`,
    );
  }
  return out;
}

function sumUnpacked(entry: TextureEntry): number {
  return entry.chunks.reduce((sum, chunk) => sum + chunk.unpackedSize, 0);
}

function readExact(
  fd: number,
  buffer: Buffer,
  offset: number,
  length: number,
  position: number,
): Buffer {
  if (length > buffer.length) {
    throw new RangeError(`read of ${length} bytes does not fit the ${buffer.length} byte buffer`);
  }
  let read = 0;
  while (read < length) {
    const n = fs.readSync(fd, buffer, offset + read, length - read, position + read);
    if (n === 0) throw new Error('unexpected end of archive');
    read += n;
  }
  return buffer;
}

export { BA2_ALIGN_SENTINEL, TILE_MODE_PC };
