import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { decodeLZ4Block, encodeLZ4Block } from '../dist/index.js';

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'lz4', 'reference-blocks.json');
const reference = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

/** Deterministic xorshift bytes, so the corpus is reproducible. */
function randomBytes(length, seed) {
  let state = seed >>> 0 || 1;
  const out = Buffer.allocUnsafe(length);
  for (let i = 0; i < length; i++) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    out[i] = state & 0xff;
  }
  return out;
}

/** LZ4 length field: the value minus `base`, coded as 255-loops plus a tail. */
function lengthBytes(value, base) {
  const out = [];
  let remaining = value - base;
  while (remaining >= 255) {
    out.push(255);
    remaining -= 255;
  }
  out.push(remaining);
  return Buffer.from(out);
}

/**
 * Builds a raw LZ4 block from explicit sequences, straight from the block
 * format spec. Used to hand-craft vectors whose expected output can be worked
 * out on paper, independently of the encoder.
 */
function buildBlock(sequences) {
  const parts = [];
  for (const { literals = '', match } of sequences) {
    const literalBytes = Buffer.from(literals);
    const matchCode = match ? match.length - 4 : 0;
    parts.push(Buffer.from([
      (Math.min(literalBytes.length, 15) << 4) | (match ? Math.min(matchCode, 15) : 0),
    ]));
    if (literalBytes.length >= 15) parts.push(lengthBytes(literalBytes.length, 15));
    parts.push(literalBytes);
    if (match) {
      parts.push(Buffer.from([match.offset & 0xff, (match.offset >> 8) & 0xff]));
      if (matchCode >= 15) parts.push(lengthBytes(matchCode, 15));
    }
  }
  return Buffer.concat(parts);
}

test('lz4: decodes blocks produced by an independent encoder', () => {
  assert.ok(reference.blocks.length >= 10, 'expected a corpus of reference blocks');
  for (const block of reference.blocks) {
    const plain = zlib.gunzipSync(Buffer.from(block.plain, 'base64'));
    const compressed = Buffer.from(block.lz4, 'hex');
    assert.equal(plain.length, block.plainSize, block.name);
    assert.equal(compressed.length, block.lz4Size, block.name);
    const decoded = decodeLZ4Block(compressed, { maxOutput: block.plainSize });
    assert.equal(decoded.length, block.plainSize, block.name);
    assert.ok(decoded.equals(plain), `${block.name} decoded to different bytes`);
  }
});

test('lz4: hand built blocks follow the block format', () => {
  const cases = [
    // Literals only: one token, one literal run, end of block.
    ['literals', buildBlock([{ literals: 'abc' }]), 'abc'],
    // Offset 1 repeats the previous byte, so this is a run of eight 'a'.
    [
      'overlapping offset 1',
      buildBlock([{ literals: 'a', match: { offset: 1, length: 7 } }]),
      'a'.repeat(8),
    ],
    // Extended literal length (300) and extended match length (700).
    [
      'extended lengths',
      buildBlock([
        { literals: 'abcdefghij'.repeat(30), match: { offset: 300, length: 700 } },
        { literals: 'vwxyz' },
      ]),
      'abcdefghij'.repeat(100) + 'vwxyz',
    ],
    // A match far beyond the 255 byte neighbourhood: 60 000 bytes are produced
    // by one long overlapping match, then eight bytes are copied from position
    // 0 with offset 60000 (both offset bytes non-zero).
    [
      'far offset',
      buildBlock([
        { literals: 'abcd', match: { offset: 4, length: 59996 } },
        { match: { offset: 60000, length: 8 } },
        { literals: 'vwxyz' },
      ]),
      'abcd'.repeat(15000) + 'abcdabcd' + 'vwxyz',
    ],
    // A block may end right after a match as long as the byte count is exact.
    ['ends on a match', buildBlock([{ literals: 'abcd', match: { offset: 4, length: 8 } }]), 'abcdabcdabcd'],
  ];

  for (const [name, block, expected] of cases) {
    const decoded = decodeLZ4Block(block, { maxOutput: expected.length });
    assert.equal(decoded.toString('latin1'), expected, name);
  }

  // Empty output: the format's single zero token.
  assert.equal(decodeLZ4Block(Buffer.from([0x00]), { maxOutput: 0 }).length, 0);
});

test('lz4: malformed blocks fail with clear errors', () => {
  const decode = (bytes, maxOutput) => decodeLZ4Block(Buffer.from(bytes), { maxOutput });

  assert.throws(() => decode([], 4), /empty block/);
  // Match offset 0 is invalid.
  assert.throws(() => decode([0x40, 0x61, 0x62, 0x63, 0x64, 0x00, 0x00], 8), /offset 0/);
  // Offset points before the start of the output.
  assert.throws(() => decode([0x40, 0x61, 0x62, 0x63, 0x64, 0x08, 0x00], 12), /before the start/);
  // Literal run longer than the remaining input.
  assert.throws(() => decode([0x40, 0x61], 4), /truncated literal/);
  // Truncated match offset.
  assert.throws(() => decode([0x40, 0x61, 0x62, 0x63, 0x64, 0x01], 8), /truncated match offset/);
  // Length extension that runs off the end of the block.
  assert.throws(() => decode([0xf0, 0xff], 300), /truncated length extension/);
  // The block produces more bytes than the archive says.
  assert.throws(() => decode([0x40, 0x61, 0x62, 0x63, 0x64], 3), /overflows the expected 3 byte output/);
  // ... and fewer.
  assert.throws(() => decode([0x40, 0x61, 0x62, 0x63, 0x64], 8), /decoded to 4 bytes but the archive says 8/);
});

test('lz4: encoder round trips a mixed corpus', () => {
  const corpus = [
    Buffer.alloc(0),
    Buffer.from('a'),
    Buffer.from('abcd'),
    Buffer.from('abcd'.repeat(4)),
    Buffer.from('a'.repeat(16)),
    Buffer.alloc(4096),
    Buffer.from('ab'.repeat(500)),
    Buffer.from('The quick brown fox jumps over the lazy dog. '.repeat(200)),
    randomBytes(1024, 7),
    randomBytes(65536, 11),
    // 120 KiB with an exact copy 60 000 bytes in: the match offset needs both
    // offset bytes and sits close to the format's 65535 limit.
    Buffer.concat([randomBytes(60000, 21), randomBytes(60000, 21)]),
  ];

  for (const [index, plain] of corpus.entries()) {
    const encoded = encodeLZ4Block(plain);
    const bound = plain.length + Math.ceil(plain.length / 255) + 32;
    assert.ok(encoded.length <= bound, `block ${index} grew past the LZ4 compress bound`);
    const decoded = decodeLZ4Block(encoded, { maxOutput: plain.length });
    assert.ok(decoded.equals(plain), `block ${index} did not round trip`);
  }

  // Incompressible input grows by the format's framing overhead only.
  const noise = randomBytes(2048, 99);
  assert.equal(encodeLZ4Block(noise).length, 2048 + 1 + 8);

  // A literals-only block is exactly what the spec prescribes for short input.
  assert.deepEqual([...encodeLZ4Block(Buffer.from('abcd'))], [0x40, 0x61, 0x62, 0x63, 0x64]);
  assert.deepEqual([...encodeLZ4Block(Buffer.alloc(0))], [0x00]);

  // Repetitive data compresses instead of expanding.
  assert.ok(encodeLZ4Block(Buffer.alloc(4096)).length < 64);
  assert.ok(encodeLZ4Block(Buffer.from('a'.repeat(4096))).length < 64);
});
