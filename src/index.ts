/**
 * Public library entry point.
 */
export {
  BA2_ALIGN_SENTINEL,
  TILE_MODE_PC,
  archiveCompression,
  entryCompression,
  entryUnpackedSize,
  isGnrlEntry,
  isTextureEntry,
  type ArchiveKind,
  type Ba2Entry,
  type Ba2Header,
  type Compression,
  type GnrlEntry,
  type TextureChunk,
  type TextureEntry,
} from './ba2/format.js';
export { Ba2Archive, openArchive, normalizeEntryPath, type ArchiveSummary } from './ba2/reader.js';
export { compileFilter, extractArchive, type ExtractOptions, type ExtractProgress, type ExtractResult } from './ba2/extract.js';
export { buildDdsHeader, DDS_TOTAL_HEADER_SIZE } from './ba2/dds.js';
export { dxgiFormatName, mipChainSize, mipLevelSize } from './ba2/dxgi.js';
export { Ba2Writer, createArchive, type CreateOptions } from './ba2/writer.js';
export { encodeLZ4Block, decodeLZ4Block, type Lz4DecodeOptions } from './ba2/lz4.js';
