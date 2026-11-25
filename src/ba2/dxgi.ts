/**
 * Minimal DXGI_FORMAT knowledge needed to rebuild DDS headers: names for
 * reporting and the surface size of one mip level.
 */

export interface DxgiFormatInfo {
  name: string;
  /** Bytes per 4x4 block for BC formats, 0 otherwise. */
  blockBytes: number;
  /** Bytes per pixel for uncompressed formats. */
  bytesPerPixel: number;
}

const FORMATS: Record<number, DxgiFormatInfo> = {
  10: { name: 'R16G16B16A16_FLOAT', blockBytes: 0, bytesPerPixel: 8 },
  11: { name: 'R16G16B16A16_UNORM', blockBytes: 0, bytesPerPixel: 8 },
  28: { name: 'R8G8B8A8_UNORM', blockBytes: 0, bytesPerPixel: 4 },
  29: { name: 'R8G8B8A8_UNORM_SRGB', blockBytes: 0, bytesPerPixel: 4 },
  49: { name: 'R8G8_UNORM', blockBytes: 0, bytesPerPixel: 2 },
  61: { name: 'R8_UNORM', blockBytes: 0, bytesPerPixel: 1 },
  71: { name: 'BC1_UNORM', blockBytes: 8, bytesPerPixel: 0 },
  72: { name: 'BC1_UNORM_SRGB', blockBytes: 8, bytesPerPixel: 0 },
  74: { name: 'BC2_UNORM', blockBytes: 16, bytesPerPixel: 0 },
  75: { name: 'BC2_UNORM_SRGB', blockBytes: 16, bytesPerPixel: 0 },
  77: { name: 'BC3_UNORM', blockBytes: 16, bytesPerPixel: 0 },
  78: { name: 'BC3_UNORM_SRGB', blockBytes: 16, bytesPerPixel: 0 },
  80: { name: 'BC4_UNORM', blockBytes: 8, bytesPerPixel: 0 },
  81: { name: 'BC4_SNORM', blockBytes: 8, bytesPerPixel: 0 },
  83: { name: 'BC5_UNORM', blockBytes: 16, bytesPerPixel: 0 },
  84: { name: 'BC5_SNORM', blockBytes: 16, bytesPerPixel: 0 },
  87: { name: 'B8G8R8A8_UNORM', blockBytes: 0, bytesPerPixel: 4 },
  88: { name: 'B8G8R8X8_UNORM', blockBytes: 0, bytesPerPixel: 4 },
  91: { name: 'B8G8R8A8_UNORM_SRGB', blockBytes: 0, bytesPerPixel: 4 },
  95: { name: 'BC6H_UF16', blockBytes: 16, bytesPerPixel: 0 },
  96: { name: 'BC6H_SF16', blockBytes: 16, bytesPerPixel: 0 },
  98: { name: 'BC7_UNORM', blockBytes: 16, bytesPerPixel: 0 },
  99: { name: 'BC7_UNORM_SRGB', blockBytes: 16, bytesPerPixel: 0 },
};

export function dxgiFormatName(format: number): string {
  return FORMATS[format]?.name ?? `DXGI_FORMAT_${format}`;
}

export function isBlockCompressed(format: number): boolean {
  return (FORMATS[format]?.blockBytes ?? 0) > 0;
}

/** Size in bytes of a single mip level, honouring 4x4 block minimums. */
export function mipLevelSize(
  format: number,
  width: number,
  height: number,
): number {
  const info = FORMATS[format];
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  if (info && info.blockBytes > 0) {
    return Math.max(1, Math.ceil(w / 4)) * Math.max(1, Math.ceil(h / 4)) * info.blockBytes;
  }
  return w * h * (info?.bytesPerPixel ?? 4);
}

/** Mip dimensions for level `level` of a `width` x `height` texture. */
export function mipDimensions(
  width: number,
  height: number,
  level: number,
): { width: number; height: number } {
  return {
    width: Math.max(1, width >> level),
    height: Math.max(1, height >> level),
  };
}

/** Total bytes of a full mip chain (single face). */
export function mipChainSize(
  format: number,
  width: number,
  height: number,
  mipCount: number,
): number {
  let total = 0;
  for (let level = 0; level < Math.max(1, mipCount); level++) {
    const dims = mipDimensions(width, height, level);
    total += mipLevelSize(format, dims.width, dims.height);
  }
  return total;
}
