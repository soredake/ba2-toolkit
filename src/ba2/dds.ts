/**
 * Rebuilds a DDS container for a BA2 DX10 texture record.
 *
 * BA2 texture records store raw mip data only, so the extractor writes a
 * 128 byte DDS_HEADER followed by a DDS_HEADER_DXT10 that carries the DXGI
 * format verbatim. Using the DX10 extension keeps BC6H/BC7 and every other
 * modern format lossless instead of guessing an old FourCC.
 */
import { mipLevelSize } from './dxgi.js';
import type { TextureEntry } from './format.js';

export const DDS_MAGIC = 0x20534444; // 'DDS '
export const DDS_HEADER_SIZE = 124;
export const DDS_DX10_HEADER_SIZE = 20;
/** magic + DDS_HEADER + DDS_HEADER_DXT10 */
export const DDS_TOTAL_HEADER_SIZE = 4 + DDS_HEADER_SIZE + DDS_DX10_HEADER_SIZE;

const DDSD_CAPS = 0x1;
const DDSD_HEIGHT = 0x2;
const DDSD_WIDTH = 0x4;
const DDSD_PIXELFORMAT = 0x1000;
const DDSD_MIPMAPCOUNT = 0x20000;
const DDSD_LINEARSIZE = 0x80000;

const DDPF_FOURCC = 0x4;

const DDSCAPS_COMPLEX = 0x8;
const DDSCAPS_TEXTURE = 0x1000;
const DDSCAPS_MIPMAP = 0x400000;

const DDSCAPS2_CUBEMAP = 0x200;
const DDSCAPS2_CUBEMAP_ALLFACES = 0xfc00;

const D3D10_RESOURCE_DIMENSION_TEXTURE2D = 3;
const DDS_RESOURCE_MISC_TEXTURECUBE = 0x4;

/** Bytes of the DDS header written in front of the raw mip data. */
export function buildDdsHeader(entry: TextureEntry): Buffer {
  const buffer = Buffer.alloc(DDS_TOTAL_HEADER_SIZE);
  const mipCount = Math.max(1, entry.mipCount);
  const hasMips = mipCount > 1;
  const cube = entry.isCubemap;
  const faces = cube ? 6 : 1;

  buffer.writeUInt32LE(DDS_MAGIC, 0);
  buffer.writeUInt32LE(DDS_HEADER_SIZE, 4);
  buffer.writeUInt32LE(
    DDSD_CAPS |
      DDSD_HEIGHT |
      DDSD_WIDTH |
      DDSD_PIXELFORMAT |
      DDSD_MIPMAPCOUNT |
      DDSD_LINEARSIZE,
    8,
  );
  buffer.writeUInt32LE(entry.height, 12);
  buffer.writeUInt32LE(entry.width, 16);
  // dwPitchOrLinearSize: size of the top mip level of one face.
  buffer.writeUInt32LE(mipLevelSize(entry.dxgiFormat, entry.width, entry.height), 20);
  buffer.writeUInt32LE(0, 24); // dwDepth
  buffer.writeUInt32LE(mipCount, 28);
  // dwReserved1[11] stays zero.

  // DDS_PIXELFORMAT
  buffer.writeUInt32LE(32, 76);
  buffer.writeUInt32LE(DDPF_FOURCC, 80);
  buffer.write('DX10', 84, 'latin1');
  // RGB bit count / masks stay zero for FourCC formats.

  let caps = DDSCAPS_TEXTURE;
  if (hasMips) caps |= DDSCAPS_COMPLEX | DDSCAPS_MIPMAP;
  if (cube) caps |= DDSCAPS_COMPLEX;
  buffer.writeUInt32LE(caps, 108);
  buffer.writeUInt32LE(cube ? DDSCAPS2_CUBEMAP | DDSCAPS2_CUBEMAP_ALLFACES : 0, 112);
  // dwCaps3, dwCaps4, dwReserved2 stay zero.

  // DDS_HEADER_DXT10
  buffer.writeUInt32LE(entry.dxgiFormat, 128);
  buffer.writeUInt32LE(D3D10_RESOURCE_DIMENSION_TEXTURE2D, 132);
  buffer.writeUInt32LE(cube ? DDS_RESOURCE_MISC_TEXTURECUBE : 0, 136);
  buffer.writeUInt32LE(faces, 140);
  buffer.writeUInt32LE(0, 144); // miscFlags2

  return buffer;
}
