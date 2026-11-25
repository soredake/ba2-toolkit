/** LZ4 block-level decompression (raw block format, no frame header).

 * The LZ4 Block Format (<https://github.com/lz4/lz4/blob/dev/doc/lz4_Block_format.md>):
 *
 * An LZ4 compressed block is a sequence of "sequences". Each sequence is:
 *   token (1 byte) | literal-run | offset (2 bytes LE) | match-run
 *
 * - token high nibble = literal length (0-14 direct, 15 = 15 + extension).
 * - literal extension: read bytes, add each, keep reading while the byte == 255.
 * - literal-run bytes follow (verbatim).
 * - token low nibble = match length - 4 (0 -> 4, ..., 14 -> 18, 15 = 19 + extension).
 * - offset (2 bytes LE, 1..65535, 0 is invalid).
 * - match-run: copy `match length` bytes from output[pos - offset:], byte by byte
 *   (overlapping copies are valid; offset 1 repeats the last byte).
 *
 * End of block: the last sequence is literals-only (no offset/match follows).
 * The decoder detects this when the input is exhausted right after a literal run.
 *
 * This module only decodes raw blocks. It is used by the BA2 reader for
 * Starfield v3 archives whose header compression method is 3 (LZ4 block).
 */

export interface Lz4DecodeOptions {
  /** Maximum decoded bytes; the decoder errors if it would exceed this. */
  maxOutput: number;
}

/** Decode one raw LZ4 block. Throws on truncation, offset 0 or output overflow. */
export function decodeLZ4Block(data: Buffer, { maxOutput }: Lz4DecodeOptions): Buffer {
  let inPos = 0;
  let outPos = 0;
  const out = Buffer.alloc(Math.min(maxOutput, 64 * 1024 * 1024));

  while (inPos < data.length) {
    const token = data[inPos++]!;
    let litLen = readLength(data, inPos, token >>> 4, 15);
    inPos += litLen.consumed;

    // Literal run.
    if (inPos + litLen.value > data.length) {
      throw new Error('LZ4: truncated literal run');
    }
    if (outPos + litLen.value > maxOutput) {
      throw new Error('LZ4: decompressed size overflow');
    }
    data.copy(out, outPos, inPos, inPos + litLen.value);
    outPos += litLen.value;
    inPos += litLen.value;

    // If the input is now exhausted the block is done (last sequence is
    // literals-only). The token's low nibble is unused/ignored here.
    if (inPos >= data.length) break;

    // Match offset (2 bytes LE). 0 is invalid.
    if (inPos + 2 > data.length) {
      throw new Error('LZ4: truncated match offset');
    }
    const offset = data.readUInt16LE(inPos);
    inPos += 2;
    if (offset === 0) {
      throw new Error('LZ4: invalid match offset 0');
    }
    if (outPos - offset < 0) {
      throw new Error('LZ4: match offset references data before the start of the output');
    }

    let matchLen = readLength(data, inPos, token & 0x0f, 19);
    inPos += matchLen.consumed;
    if (outPos + matchLen.value > maxOutput) {
      throw new Error('LZ4: decompressed size overflow');
    }

    // Overlapping copy, one byte at a time.
    const matchStart = outPos - offset;
    for (let i = 0; i < matchLen.value; i++) {
      out[outPos] = out[matchStart + i]!;
      outPos++;
    }
  }

  if (outPos !== maxOutput) {
    throw new Error(
      `LZ4: decoded ${outPos} bytes but the archive expects ${maxOutput}`,
    );
  }
  return out.subarray(0, outPos);
}

/**
 * Read an LZ4 extended length field.
 *
 * `base` is the value the 4-bit field stands for when it is **not** 15: for
 * literal length that is 0-14, for match length that is 4-18 (so the caller
 * passes 15 and 19 respectively for the "15 means extended" case).
 *
 * Returns `{ value, consumed }` where `consumed` is the number of input bytes
 * read past `offset` (the extension bytes), so the caller can advance.
 */
function readLength(
  data: Buffer,
  offset: number,
  nibble: number,
  baseWhenExtended: number,
): { value: number; consumed: number } {
  // Nibble 0-14 is the final length (literal: 0-14, match: 4-18).
  if (nibble < 15) {
    return { value: nibble + (baseWhenExtended === 19 ? 4 : 0), consumed: 0 };
  }
  // Extended: base (15 for literals, 19 for matches) + extension bytes.
  const base = baseWhenExtended;
  let value = base;
  let pos = offset;
  let consumed = 0;
  while (pos < data.length) {
    const b = data[pos++]!;
    consumed++;
    value += b;
    if (b !== 255) break;
  }
  if (pos > data.length) {
    throw new Error('LZ4: truncated length extension');
  }
  return { value, consumed };
}
