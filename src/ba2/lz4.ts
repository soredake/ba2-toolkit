/**
 * LZ4 block compression and decompression (raw block format, no frame header).
 *
 * A BA2 v3 archive that stores `compression method = 3` replaces the zlib
 * stream of every payload (GNRL file or DX10 chunk) with one raw LZ4 block.
 *
 * Block layout, from the LZ4 Block Format specification
 * (<https://github.com/lz4/lz4/blob/dev/doc/lz4_Block_format.md>):
 *
 *   token (1 byte) | literal-length extension | literals |
 *   offset (2 bytes LE) | match-length extension | match bytes
 *
 * - token high nibble = literal length (0-14 direct, 15 = 15 + extension).
 * - literal extension: one byte is added to the length; while that byte is 255
 *   another byte follows.
 * - literal bytes follow the token and its extension, verbatim.
 * - token low nibble = match length - 4 (0 -> 4, ..., 14 -> 18, 15 = 19 +
 *   extension, same 255 continuation rule).
 * - offset is 2 bytes little endian, 1..65535; 0 is invalid.
 * - the match copies from `output[outPos - offset]`, byte by byte, so an offset
 *   smaller than the match length repeats the already produced bytes.
 * - the last sequence is literals only, which is how the end of the block is
 *   detected: once the input is exhausted right after a literal run, the block
 *   is complete and the token's low nibble is unused.
 *
 * The decoder is exact: it is told how many bytes the archive says the payload
 * should occupy and fails if the block produces a different amount.
 */

export interface Lz4DecodeOptions {
  /**
   * Number of bytes the block must decode to (the record's unpacked size).
   * The decoder errors if the block produces more or fewer bytes.
   */
  maxOutput: number;
}

/** Largest single block either direction of this module will handle (2 GiB - 1). */
const MAX_BLOCK_SIZE = 0x7fffffff;

/**
 * Decodes one raw LZ4 block.
 *
 * Throws on truncation, an invalid offset, or when the block does not produce
 * exactly `maxOutput` bytes.
 */
export function decodeLZ4Block(data: Buffer, { maxOutput }: Lz4DecodeOptions): Buffer {
  if (!Number.isSafeInteger(maxOutput) || maxOutput < 0) {
    throw new RangeError(`LZ4: invalid expected output size ${String(maxOutput)}`);
  }
  if (maxOutput > MAX_BLOCK_SIZE) {
    throw new RangeError(`LZ4: payload too large for a single block (${maxOutput} bytes)`);
  }
  if (data.length === 0) {
    throw new Error('LZ4: empty block (a block always has at least one token)');
  }

  const out = Buffer.allocUnsafe(maxOutput);
  let inPos = 0;
  let outPos = 0;

  while (inPos < data.length) {
    const token = data[inPos]!;
    inPos++;

    // Literal run.
    const litLen = readLength(data, inPos, token >>> 4, 0);
    inPos += litLen.consumed;
    if (inPos + litLen.value > data.length) {
      throw new Error('LZ4: truncated literal run');
    }
    if (outPos + litLen.value > maxOutput) {
      throw new Error(
        `LZ4: literal run overflows the expected ${maxOutput} byte output`,
      );
    }
    data.copy(out, outPos, inPos, inPos + litLen.value);
    outPos += litLen.value;
    inPos += litLen.value;

    // Input exhausted after the literals: this was the final (literals-only)
    // sequence, so the block ends here.
    if (inPos >= data.length) break;

    // Match offset.
    if (inPos + 2 > data.length) {
      throw new Error('LZ4: truncated match offset');
    }
    const offset = data.readUInt16LE(inPos);
    inPos += 2;
    if (offset === 0) {
      throw new Error('LZ4: invalid match offset 0');
    }
    if (offset > outPos) {
      throw new Error(
        `LZ4: match offset ${offset} reaches before the start of the output (${outPos} bytes produced)`,
      );
    }

    // Match run.
    const matchLen = readLength(data, inPos, token & 0x0f, 4);
    inPos += matchLen.consumed;
    if (outPos + matchLen.value > maxOutput) {
      throw new Error(
        `LZ4: match run overflows the expected ${maxOutput} byte output`,
      );
    }

    // Overlapping copies are valid, so copy one byte at a time.
    const matchStart = outPos - offset;
    for (let i = 0; i < matchLen.value; i++) {
      out[outPos] = out[matchStart + i]!;
      outPos++;
    }
  }

  if (outPos !== maxOutput) {
    throw new Error(
      `LZ4: block decoded to ${outPos} bytes but the archive says ${maxOutput}`,
    );
  }
  return out;
}

/**
 * Reads an LZ4 length field: the 4 bit nibble, plus the extension bytes when
 * the nibble is 15. `matchBase` is 0 for literal lengths and 4 for match
 * lengths (which are stored as length - 4).
 */
function readLength(
  data: Buffer,
  offset: number,
  nibble: number,
  matchBase: number,
): { value: number; consumed: number } {
  if (nibble < 15) {
    return { value: nibble + matchBase, consumed: 0 };
  }
  let value = 15 + matchBase;
  let pos = offset;
  for (;;) {
    if (pos >= data.length) {
      throw new Error('LZ4: truncated length extension');
    }
    const byte = data[pos]!;
    pos++;
    value += byte;
    if (byte !== 255) break;
  }
  return { value, consumed: pos - offset };
}

/**
 * Encodes one raw LZ4 block with a greedy hash-table match finder.
 *
 * The output is a valid block per the specification, not necessarily the same
 * bytes the reference encoder would produce:
 *
 * - matches need at least 4 bytes and an offset of 1..65535;
 * - the last 5 bytes of the input always stay literals, and no match may start
 *   within the last 12 bytes (`MFLIMIT`), which keeps the final sequence
 *   literals-only as the format requires;
 * - overlapping matches are emitted normally (offset 1 repeats a byte).
 *
 * Incompressible input grows by at most 1 byte per 255 input bytes plus 16
 * bytes of framing, which is the bound the buffer is sized for.
 */
export function encodeLZ4Block(data: Buffer): Buffer {
  const inputLength = data.length;
  if (inputLength > MAX_BLOCK_SIZE) {
    throw new RangeError(`LZ4: input too large for a single block (${inputLength} bytes)`);
  }
  if (inputLength === 0) {
    // An empty block is a single token with nothing in it.
    return Buffer.from([0]);
  }

  const output = Buffer.allocUnsafe(inputLength + Math.ceil(inputLength / 255) + 32);
  let outPos = 0;
  const matchLimit = inputLength - 12; // last position a match may start at
  const lastLiterals = inputLength - 5; // first byte that must stay a literal

  const HASH_LOG = 16;
  const HASH_SIZE = 1 << HASH_LOG;
  const table = new Int32Array(HASH_SIZE).fill(-1);
  const hash = (pos: number): number =>
    (Math.imul(data.readUInt32LE(pos), 0x9e3779b1) >>> (32 - HASH_LOG)) & (HASH_SIZE - 1);

  let anchor = 0; // start of the pending literal run

  const writeLength = (length: number, base: number): void => {
    let remaining = length - base;
    while (remaining >= 255) {
      output[outPos] = 255;
      outPos++;
      remaining -= 255;
    }
    output[outPos] = remaining;
    outPos++;
  };

  let pos = 0;
  while (pos < matchLimit) {
    const bucket = hash(pos);
    const candidate = table[bucket]!;
    table[bucket] = pos;

    if (
      candidate >= 0 &&
      pos - candidate <= 65535 &&
      data.readUInt32LE(candidate) === data.readUInt32LE(pos)
    ) {
      const offset = pos - candidate;
      let matchLength = 4;
      while (
        pos + matchLength < lastLiterals &&
        data[candidate + matchLength] === data[pos + matchLength]
      ) {
        matchLength++;
      }

      const literalLength = pos - anchor;
      output[outPos] = (Math.min(literalLength, 15) << 4) | Math.min(matchLength - 4, 15);
      outPos++;
      if (literalLength >= 15) writeLength(literalLength, 15);
      data.copy(output, outPos, anchor, pos);
      outPos += literalLength;
      output.writeUInt16LE(offset, outPos);
      outPos += 2;
      if (matchLength - 4 >= 15) writeLength(matchLength, 4 + 15);

      // Remember the positions the match skipped over.
      for (let skipped = pos + 1; skipped < pos + matchLength; skipped++) {
        if (skipped < matchLimit) table[hash(skipped)] = skipped;
      }

      pos += matchLength;
      anchor = pos;
    } else {
      pos++;
    }
  }

  // Final literals-only sequence.
  const literalLength = inputLength - anchor;
  output[outPos] = Math.min(literalLength, 15) << 4;
  outPos++;
  if (literalLength >= 15) writeLength(literalLength, 15);
  data.copy(output, outPos, anchor, inputLength);
  outPos += literalLength;

  return output.subarray(0, outPos);
}
