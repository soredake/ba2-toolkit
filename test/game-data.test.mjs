/**
 * Optional integration tests against an installed Fallout 76 copy. They are the
 * only tests that need game data; the fixture suite in `ba2.test.mjs` covers the
 * format on its own.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Ba2Archive, extractArchive, mipChainSize } from '../dist/index.js';

const DATA_DIR =
  process.env.FO76_DATA ?? 'C:/Program Files (x86)/Steam/steamapps/common/Fallout76/Data';
const hasData = fs.existsSync(DATA_DIR);
const skip = !hasData && 'Fallout 76 data not found';
const archive = (name) => path.join(DATA_DIR, name);

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ba2-${label}-`));
}

/** Relative POSIX path -> absolute path for every file below `root`. */
function walk(root) {
  const files = new Map();
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else files.set(path.relative(root, full).split(path.sep).join('/'), full);
    }
  };
  visit(root);
  return files;
}

test('shipping archives: every .ba2 uses the BTDX version 1 layout', { skip }, () => {
  const files = fs.readdirSync(DATA_DIR).filter((file) => file.toLowerCase().endsWith('.ba2'));
  assert.ok(files.length > 0, 'the data directory contains archives');

  const kinds = { GNRL: 0, DX10: 0 };
  for (const file of files) {
    const full = path.join(DATA_DIR, file);
    const size = fs.statSync(full).size;
    const header = Buffer.alloc(24);
    const fd = fs.openSync(full, 'r');
    try {
      fs.readSync(fd, header, 0, header.length, 0);
    } finally {
      fs.closeSync(fd);
    }
    assert.equal(header.toString('latin1', 0, 4), 'BTDX', file);
    assert.equal(header.readUInt32LE(4), 1, `${file}: version`);
    const kind = header.toString('latin1', 8, 12);
    assert.ok(kind === 'GNRL' || kind === 'DX10', `${file}: type ${kind}`);
    kinds[kind]++;
    const nameTableOffset = Number(header.readBigUInt64LE(16));
    assert.ok(nameTableOffset > 0 && nameTableOffset < size, `${file}: name table offset`);
  }
  assert.ok(kinds.GNRL > 0 && kinds.DX10 > 0);
});

test('GNRL: Shipping Materials archive parses and inflates', { skip }, () => {
  const ba2 = Ba2Archive.open(archive('SeventySix - Materials.ba2'));
  try {
    assert.equal(ba2.header.kind, 'GNRL');
    assert.ok(ba2.entries.length > 30_000);
    for (const entry of ba2.entries.slice(0, 200)) {
      const data = ba2.readEntry(entry);
      assert.equal(data.length, entry.unpackedSize, entry.path);
    }
  } finally {
    ba2.close();
  }
});

test('DX10: Shipping texture archive rebuilds a BC3 DDS', { skip }, () => {
  const ba2 = Ba2Archive.open(archive('ScorchedMaps.ba2'));
  try {
    const entry = ba2.entries[0];
    assert.equal(entry.kind, 'DX10');
    assert.equal(entry.dxgiFormat, 77);
    assert.equal(entry.width, 4096);
    assert.equal(entry.height, 4096);
    assert.equal(entry.mipCount, 13);
    assert.equal(entry.chunks.length, 4);

    const chunkBytes = entry.chunks.reduce((sum, chunk) => sum + chunk.unpackedSize, 0);
    assert.equal(chunkBytes, mipChainSize(entry.dxgiFormat, entry.width, entry.height, entry.mipCount));

    const dds = ba2.readEntry(entry);
    assert.equal(dds.toString('latin1', 0, 4), 'DDS ');
    assert.equal(dds.readUInt32LE(12), 4096);
    assert.equal(dds.readUInt32LE(16), 4096);
    assert.equal(dds.readUInt32LE(128), 77);
    assert.equal(dds.length, 148 + chunkBytes);
  } finally {
    ba2.close();
  }
});

test('DX10: cubemap entries store six faces', { skip }, () => {
  const ba2 = Ba2Archive.open(archive('SeventySix - Textures01.ba2'));
  try {
    const cube = ba2.entries.find((entry) => entry.kind === 'DX10' && entry.isCubemap);
    assert.ok(cube, 'the archive contains cubemaps');
    const chunkBytes = cube.chunks.reduce((sum, chunk) => sum + chunk.unpackedSize, 0);
    assert.equal(
      chunkBytes,
      6 * mipChainSize(cube.dxgiFormat, cube.width, cube.height, cube.mipCount),
    );
    assert.equal(cube.tileMode, 8);
  } finally {
    ba2.close();
  }
});

test('extract: small shipping archive, 1 vs 2 threads', { skip }, async () => {
  const file = archive('SeventySix - 00UpdateStream.ba2');
  const single = tempDir('game-1');
  const parallel = tempDir('game-2');
  const a = await extractArchive(file, { outDir: single, threads: 1 });
  const b = await extractArchive(file, { outDir: parallel, threads: 2 });
  assert.equal(a.errors.length, 0);
  assert.equal(b.errors.length, 0);
  assert.equal(a.extracted, b.extracted);
  assert.ok(a.extracted > 0);

  const left = walk(single);
  const right = walk(parallel);
  assert.equal(left.size, a.extracted);
  assert.deepEqual([...left.keys()].sort(), [...right.keys()].sort());
  for (const [name, file] of left) {
    assert.deepEqual(fs.readFileSync(file), fs.readFileSync(right.get(name)), name);
  }
});
