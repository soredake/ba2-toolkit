import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  Ba2Archive,
  compileFilter,
  extractArchive,
  mipChainSize,
  mipLevelSize,
} from '../dist/index.js';

const FIXTURE_DIR = path.join(import.meta.dirname, 'fixtures');
const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'manifest.json'), 'utf8'));
const gnrlPath = path.join(FIXTURE_DIR, manifest.gnrl.file);
const dx10Path = path.join(FIXTURE_DIR, manifest.dx10.file);
const DDS_HEADER_SIZE = 148;

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ba2-${label}-`));
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
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

function patchedFixture(source, label, patch) {
  const target = path.join(tempDir(label), 'broken.ba2');
  const data = fs.readFileSync(source);
  patch(data);
  fs.writeFileSync(target, data);
  return target;
}

test('fixtures: GNRL header, records and name table', () => {
  const archive = Ba2Archive.open(gnrlPath);
  try {
    assert.equal(archive.header.kind, 'GNRL');
    assert.equal(archive.header.version, 1);
    assert.equal(archive.header.fileCount, manifest.gnrl.entries.length);
    assert.deepEqual(
      archive.entries.map((entry) => entry.path),
      manifest.gnrl.entries.map((entry) => entry.path),
    );
    const recordBytes = 36;
    for (const [index, entry] of archive.entries.entries()) {
      const expected = manifest.gnrl.entries[index];
      assert.equal(entry.kind, 'GNRL');
      assert.equal(entry.unpackedSize, expected.size);
      assert.equal(entry.packedSize > 0, expected.compressed);
      assert.equal(entry.extension, path.posix.extname(entry.path).slice(1));
      assert.ok(entry.offset >= 24 + recordBytes * archive.entries.length);
      assert.ok(
        entry.offset + (entry.packedSize || entry.unpackedSize) <= archive.header.nameTableOffset,
        `${entry.path} must stay inside the payload region`,
      );
    }

    const last = archive.entries.at(-1);
    assert.equal(
      last.offset + (last.packedSize || last.unpackedSize),
      archive.header.nameTableOffset,
      'payloads must end where the name table starts',
    );
  } finally {
    archive.close();
  }
});

test('fixtures: GNRL payloads are stored or zlib streams', () => {
  const archive = Ba2Archive.open(gnrlPath);
  try {
    for (const [index, entry] of archive.entries.entries()) {
      const expected = manifest.gnrl.entries[index];
      const data = archive.readEntry(entry);
      assert.equal(data.length, expected.size);
      assert.equal(sha256(data), expected.sha256, entry.path);
    }

    const stored = archive.entries.find((entry) => entry.packedSize === 0 && entry.unpackedSize > 0);
    assert.ok(stored, 'the fixture contains one entry stored without compression');

    const text = archive.entries.find((entry) => entry.path.endsWith('.txt'));
    assert.ok(text.packedSize > 0, 'the text entry is zlib compressed');
    const lines = archive.readEntry(text).toString('utf8').split('\n');
    assert.equal(lines[0], 'BA2 fixture archive');
    assert.equal(lines[1], 'format=GNRL');

    const empty = archive.entries.find((entry) => entry.path.endsWith('empty.bin'));
    assert.equal(empty.unpackedSize, 0);
    assert.equal(archive.readEntry(empty).length, 0);
  } finally {
    archive.close();
  }
});

test('fixtures: DX10 records, chunks and generated DDS headers', () => {
  const archive = Ba2Archive.open(dx10Path);
  try {
    assert.equal(archive.header.kind, 'DX10');
    assert.equal(archive.entries.length, manifest.dx10.entries.length);

    for (const [index, entry] of archive.entries.entries()) {
      const expected = manifest.dx10.entries[index];
      assert.equal(entry.kind, 'DX10');
      assert.equal(entry.path, expected.path);
      assert.equal(entry.width, expected.width);
      assert.equal(entry.height, expected.height);
      assert.equal(entry.mipCount, expected.mips);
      assert.equal(entry.dxgiFormat, expected.format);
      assert.equal(entry.isCubemap, expected.cubemap);
      assert.equal(entry.tileMode, 8);
      assert.deepEqual(
        entry.chunks.map((chunk) => [chunk.startMip, chunk.endMip, chunk.packedSize > 0]),
        expected.chunks.map((chunk) => [chunk.startMip, chunk.endMip, chunk.compressed]),
      );

      const chunkBytes = entry.chunks.reduce((sum, chunk) => sum + chunk.unpackedSize, 0);
      assert.equal(chunkBytes, expected.payloadSize);
      if (entry.isCubemap) {
        assert.equal(
          chunkBytes,
          6 * mipChainSize(entry.dxgiFormat, entry.width, entry.height, entry.mipCount),
          'cubemaps store six faces',
        );
      } else {
        assert.equal(
          chunkBytes,
          mipChainSize(entry.dxgiFormat, entry.width, entry.height, entry.mipCount),
        );
      }

      const dds = archive.readEntry(entry);
      assert.equal(dds.length, DDS_HEADER_SIZE + expected.payloadSize);
      assert.equal(sha256(dds.subarray(DDS_HEADER_SIZE)), expected.payloadSha256);
      assert.equal(dds.toString('latin1', 0, 4), 'DDS ');
      assert.equal(dds.readUInt32LE(4), 124);
      assert.equal(dds.readUInt32LE(12), entry.height);
      assert.equal(dds.readUInt32LE(16), entry.width);
      assert.equal(dds.readUInt32LE(20), mipLevelSize(entry.dxgiFormat, entry.width, entry.height));
      assert.equal(dds.readUInt32LE(28), entry.mipCount);
      assert.equal(dds.toString('latin1', 84, 88), 'DX10');
      assert.equal(dds.readUInt32LE(128), entry.dxgiFormat);
      assert.equal(dds.readUInt32LE(132), 3); // D3D10_RESOURCE_DIMENSION_TEXTURE2D
      assert.equal(dds.readUInt32LE(136), entry.isCubemap ? 0x4 : 0);
      assert.equal(dds.readUInt32LE(140), entry.isCubemap ? 6 : 1);
      assert.equal(dds.readUInt32LE(112), entry.isCubemap ? 0xfe00 : 0); // caps2
    }
  } finally {
    archive.close();
  }
});

test('fixtures: summary reports formats, cubemaps and compression', () => {
  const textures = Ba2Archive.open(dx10Path);
  try {
    const summary = textures.summary();
    assert.equal(summary.fileCount, 3);
    assert.equal(summary.cubemaps, 1);
    assert.equal(summary.nonPcTiling, 0);
    assert.deepEqual(
      summary.formats.map((format) => format.name).sort(),
      ['BC1_UNORM', 'BC3_UNORM', 'BC5_UNORM'],
    );
    assert.equal(
      summary.unpackedBytes,
      manifest.dx10.entries.reduce((sum, entry) => sum + entry.payloadSize, 0),
    );
  } finally {
    textures.close();
  }

  const general = Ba2Archive.open(gnrlPath);
  try {
    const summary = general.summary();
    assert.equal(summary.fileCount, 4);
    assert.equal(summary.compressedFiles, 2);
    assert.deepEqual(
      summary.extensions.map((item) => item.extension),
      ['swf', 'bgsm', 'txt', 'bin'],
    );
  } finally {
    general.close();
  }
});

test('fixtures: extraction writes exactly the manifest bytes', async () => {
  for (const [file, expected] of [
    [gnrlPath, manifest.gnrl.entries],
    [dx10Path, manifest.dx10.entries],
  ]) {
    const out = tempDir(path.basename(file, '.ba2'));
    const result = await extractArchive(file, { outDir: out, threads: 1 });
    assert.equal(result.errors.length, 0);
    assert.equal(result.extracted, expected.length);
    assert.equal(result.selected, expected.length);
    assert.equal(result.bytes, expected.reduce((sum, entry) => sum + entry.size, 0));

    const files = walk(out);
    assert.equal(files.size, expected.length);
    for (const entry of expected) {
      const written = files.get(entry.path);
      assert.ok(written, `${entry.path} should exist`);
      const data = fs.readFileSync(written);
      assert.equal(data.length, entry.size);
      if (entry.kind === 'DX10') {
        // The DDS header is generated; the mip payload must match byte for byte.
        assert.equal(sha256(data.subarray(DDS_HEADER_SIZE)), entry.payloadSha256, entry.path);
      } else {
        assert.equal(sha256(data), entry.sha256, entry.path);
      }
    }
  }
});

test('fixtures: parallel workers produce byte identical files', async () => {
  const single = tempDir('single');
  const parallel = tempDir('parallel');
  const a = await extractArchive(dx10Path, { outDir: single, threads: 1 });
  const b = await extractArchive(dx10Path, { outDir: parallel, threads: 4 });
  assert.equal(a.errors.length, 0);
  assert.equal(b.errors.length, 0);
  assert.equal(a.extracted, b.extracted);
  assert.equal(b.threads, 3, 'worker count is capped by the entry count');

  const left = walk(single);
  const right = walk(parallel);
  assert.deepEqual([...left.keys()].sort(), [...right.keys()].sort());
  for (const [name, file] of left) {
    assert.deepEqual(fs.readFileSync(file), fs.readFileSync(right.get(name)), name);
  }
});

test('fixtures: filters match nested paths and are case insensitive', async () => {
  assert.equal(compileFilter('*.txt')({ path: 'scripts/config.txt' }), true);
  assert.equal(compileFilter('*.txt')({ path: 'textures/wall.dds' }), false);
  assert.equal(compileFilter('TEXTURES/*.DDS')({ path: 'textures/wall_d.dds' }), true);
  assert.equal(compileFilter('materials/*.bgsm')({ path: 'materials/steel.bgsm' }), true);

  const out = tempDir('filter');
  const textures = await extractArchive(dx10Path, {
    outDir: out,
    filter: '*.dds',
    threads: 2,
  });
  assert.equal(textures.errors.length, 0);
  assert.equal(textures.selected, 3);
  assert.equal(textures.extracted, 3);
  assert.equal(walk(out).size, 3);

  const text = await extractArchive(gnrlPath, { outDir: tempDir('filter-txt'), filter: '*.txt' });
  assert.equal(text.selected, 1);
  assert.equal(text.extracted, 1);

  const none = await extractArchive(gnrlPath, { outDir: tempDir('filter-none'), filter: '*.nif' });
  assert.equal(none.selected, 0);
  assert.equal(none.extracted, 0);
  assert.equal(none.errors.length, 0);
});

test('fixtures: flat, overwrite and dry run', async () => {
  const out = tempDir('flat');
  const flat = await extractArchive(gnrlPath, { outDir: out, flat: true, threads: 1 });
  assert.equal(flat.extracted, 4);
  assert.deepEqual(
    [...walk(out).keys()].sort(),
    ['config.txt', 'empty.bin', 'panel.swf', 'steel.bgsm'],
  );

  const nested = tempDir('overwrite');
  const first = await extractArchive(gnrlPath, { outDir: nested, threads: 1 });
  assert.equal(first.extracted, 4);
  const second = await extractArchive(gnrlPath, { outDir: nested, threads: 1 });
  assert.equal(second.extracted, 0);
  assert.equal(second.skipped, 4);
  const forced = await extractArchive(gnrlPath, { outDir: nested, threads: 1, overwrite: true });
  assert.equal(forced.extracted, 4);
  assert.equal(forced.skipped, 0);

  const dry = tempDir('dry');
  const dryRun = await extractArchive(dx10Path, { outDir: dry, dryRun: true });
  assert.equal(dryRun.extracted, 3);
  assert.equal(dryRun.errors.length, 0);
  assert.equal(dryRun.threads, 0);
  assert.equal(walk(dry).size, 0);
});

test('fixtures: malformed archives fail with clear errors', async () => {
  const badMagic = patchedFixture(gnrlPath, 'magic', (data) => data.write('XXXX', 0, 'latin1'));
  assert.throws(() => Ba2Archive.open(badMagic), /not a BA2 archive/);

  const truncated = patchedFixture(gnrlPath, 'truncated', (data) => data.fill(0));
  fs.truncateSync(truncated, 12);
  assert.throws(() => Ba2Archive.open(truncated), /too small/);

  const wrongChunkHeader = patchedFixture(dx10Path, 'chunk-header', (data) =>
    data.writeUInt16LE(0x20, 0x18 + 14),
  );
  assert.throws(() => Ba2Archive.open(wrongChunkHeader), /unsupported texture chunk header size/);

  const tiled = patchedFixture(dx10Path, 'tiled', (data) => data.writeUInt8(4, 0x18 + 23));
  const tiledArchive = Ba2Archive.open(tiled);
  try {
    assert.equal(tiledArchive.entries[0].tileMode, 4);
    assert.throws(() => tiledArchive.readEntry(0), /Xbox tiled texture/);
  } finally {
    tiledArchive.close();
  }
  const tiledOut = tempDir('tiled');
  const tiledResult = await extractArchive(tiled, { outDir: tiledOut, threads: 1 });
  assert.equal(tiledResult.extracted, 2, 'the other two entries are still extractable');
  assert.equal(tiledResult.errors.length, 1);
  assert.equal(tiledResult.errors[0].path, 'textures/wall_d.dds');
  assert.match(tiledResult.errors[0].message, /Xbox tiled texture/);

  const badSizes = patchedFixture(gnrlPath, 'sizes', (data) => {
    const unpacked = data.readUInt32LE(0x18 + 28);
    data.writeUInt32LE(unpacked + 1, 0x18 + 28);
  });
  const badSizesArchive = Ba2Archive.open(badSizes);
  try {
    assert.throws(() => badSizesArchive.readEntry(0));
  } finally {
    badSizesArchive.close();
  }
});

test('fixtures: archive versions pick the right record table offset', () => {
  // Fallout 4 Next Gen reports version 7/8 but keeps the 24 byte header.
  const v7 = patchedFixture(gnrlPath, 'v7', (data) => data.writeUInt32LE(7, 4));
  const nextGen = Ba2Archive.open(v7);
  try {
    assert.equal(nextGen.header.version, 7);
    assert.equal(nextGen.header.extraHeaderBytes, 0);
    assert.equal(nextGen.header.recordTableOffset, 24);
    assert.equal(nextGen.entries.length, 4);
    assert.equal(nextGen.entries[0].path, 'interface/panel.swf');
    assert.equal(nextGen.readEntry(0).length, 1536);
  } finally {
    nextGen.close();
  }

  // Starfield v3 stores the compression method 8 bytes into the extension.
  const lz4 = patchedFixture(gnrlPath, 'v3-lz4', (data) => {
    data.writeUInt32LE(3, 4);
    data.writeUInt32LE(3, 0x20);
  });
  assert.throws(() => Ba2Archive.open(lz4), /LZ4/);
});

test('fixtures: CLI list and extract', () => {
  const cli = path.join(process.cwd(), 'dist', 'cli.js');

  const listed = execFileSync(process.execPath, [cli, 'list', dx10Path, '--json'], {
    encoding: 'utf8',
  });
  const rows = JSON.parse(listed);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((row) => row.format).sort(), ['BC1_UNORM', 'BC3_UNORM', 'BC5_UNORM']);
  assert.equal(rows.filter((row) => row.cubemap).length, 1);
  assert.equal(rows[0].kind, 'DX10');

  const info = JSON.parse(
    execFileSync(process.execPath, [cli, 'info', gnrlPath, '--json'], { encoding: 'utf8' }),
  );
  assert.equal(info[0].fileCount, 4);

  const out = tempDir('cli');
  const output = execFileSync(
    process.execPath,
    [cli, 'extract', gnrlPath, '--out', out, '--threads', '1'],
    { encoding: 'utf8' },
  );
  assert.match(output, /4 extracted/);
  assert.equal(walk(out).size, 4);
});
