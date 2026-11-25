/**
 * Binary layout constants and shared types for Bethesda BA2 ("BTDX") archives.
 *
 * Layout (all little endian), taken from the shipping Fallout 76 archives:
 *
 *  0x00  char[4]  "BTDX"
 *  0x04  u32      version          (1 = Fallout 4 / Fallout 76)
 *  0x08  char[4]  "GNRL" | "DX10"
 *  0x0C  u32      file count
 *  0x10  u64      absolute offset of the file name table
 *  [version >= 2: 8 unknown bytes]
 *
 * The record table starts directly after the header (0x18). Archives keep file
 * paths in a separate table at the end of the file, one `u16 length + bytes`
 * string per record, in record order.
 */

export const BA2_MAGIC = 'BTDX';
export const HEADER_SIZE = 24;
export const GNRL_RECORD_SIZE = 36;
export const DX10_RECORD_SIZE = 24;
export const DX10_CHUNK_SIZE = 24;
/** Sentinel stored in the trailing `align` field of every record. */
export const BA2_ALIGN_SENTINEL = 0xbaadf00d;
/** PC (DDS) tiling. Any other value is an Xbox One tiled texture. */
export const TILE_MODE_PC = 8;

export type ArchiveKind = 'GNRL' | 'DX10' | 'GNMF';

export interface Ba2Header {
  magic: string;
  version: number;
  kind: ArchiveKind;
  fileCount: number;
  nameTableOffset: number;
  /** Header bytes omitted when version >= 2 (Starfield). */
  extraHeaderBytes: number;
  recordTableOffset: number;
}

export interface Ba2EntryBase {
  /** Record index inside the archive. */
  index: number;
  /** Full path with forward slashes, e.g. `interface/foo.swf`. */
  path: string;
  /** Extension without the dot, lower case. */
  extension: string;
  nameHash: number;
  dirHash: number;
}

export interface GnrlEntry extends Ba2EntryBase {
  kind: 'GNRL';
  flags: number;
  offset: number;
  /** 0 means the payload is stored uncompressed. */
  packedSize: number;
  unpackedSize: number;
}

export interface TextureChunk {
  offset: number;
  /** 0 means the chunk is stored uncompressed. */
  packedSize: number;
  unpackedSize: number;
  startMip: number;
  endMip: number;
}

export interface TextureEntry extends Ba2EntryBase {
  kind: 'DX10';
  width: number;
  height: number;
  mipCount: number;
  /** DXGI_FORMAT value, written verbatim into the DDS DX10 header. */
  dxgiFormat: number;
  isCubemap: boolean;
  /** 8 = plain PC layout; anything else is Xbox tiling and cannot be used as DDS. */
  tileMode: number;
  chunks: TextureChunk[];
}

export type Ba2Entry = GnrlEntry | TextureEntry;

export function isTextureEntry(entry: Ba2Entry): entry is TextureEntry {
  return entry.kind === 'DX10';
}

export function isGnrlEntry(entry: Ba2Entry): entry is GnrlEntry {
  return entry.kind === 'GNRL';
}

/** Compression of a stored payload, derived from its packed size. */
export type Compression = 'none' | 'zlib';

export function entryCompression(entry: Ba2Entry): Compression {
  if (isTextureEntry(entry)) {
    return entry.chunks.some((chunk) => chunk.packedSize > 0) ? 'zlib' : 'none';
  }
  return entry.packedSize > 0 ? 'zlib' : 'none';
}

export function entryUnpackedSize(entry: Ba2Entry): number {
  if (isTextureEntry(entry)) {
    // Mip data only; the DDS header is generated at extraction time.
    return entry.chunks.reduce((sum, chunk) => sum + chunk.unpackedSize, 0);
  }
  return entry.unpackedSize;
}
