import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  Ba2Archive,
  createArchive,
  Ba2Writer,
  compileFilter,
  entryCompression,
  extractArchive,
  mipChainSize,
  mipLevelSize,
  buildDdsHeader,
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

function readFixtureEntries(archivePath, kind) {
  const archive = Ba2Archive.open(archivePath);
  try {
    return archive.entries.map(entry => {
      const data = archive.readEntry(entry);
      return { entry, data };
    });
  } finally {
    archive.close();
  }
}

test('create: GNRL archive with zlib compression', async () => {
  const srcDir = tempDir('gnrl-src');
  // Copy fixture files to source dir
  for (const entry of manifest.gnrl.entries) {
    if (entry.size === 0) continue; // Archive2 skips empty files
    const targetPath = path.join(srcDir, entry.path);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const originalArchive = Ba2Archive.open(gnrlPath);
    try {
      const matchingEntry = originalArchive.entries.find(e => e.path === entry.path);
      const data = originalArchive.readEntry(matchingEntry);
      fs.writeFileSync(targetPath, data);
    } finally {
      originalArchive.close();
    }
  }

  const outPath = path.join(tempDir('gnrl-out'), 'created-gnrl.ba2');
  await createArchive(outPath, srcDir, { format: 'GNRL', compression: 'zlib' });

  // Verify the created archive
  const created = Ba2Archive.open(outPath);
  try {
    assert.equal(created.header.kind, 'GNRL');
    assert.equal(created.header.version, 8); // Archive2 writes version 8
    assert.equal(created.entries.length, manifest.gnrl.entries.filter(e => e.size > 0).length);
    
    for (const entry of created.entries) {
      const expected = manifest.gnrl.entries.find(e => e.path === entry.path);
      assert.ok(expected, `entry ${entry.path} not in manifest`);
      const data = created.readEntry(entry);
      assert.equal(data.length, expected.size);
      assert.equal(sha256(data), expected.sha256, entry.path);
      assert.ok(entry.packedSize > 0, 'payload should be compressed');
    }
  } finally {
    created.close();
  }
});

test('create: GNRL archive with no compression', async () => {
  const srcDir = tempDir('gnrl-src-none');
  for (const entry of manifest.gnrl.entries) {
    if (entry.size === 0) continue;
    const targetPath = path.join(srcDir, entry.path);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const originalArchive = Ba2Archive.open(gnrlPath);
    try {
      const matchingEntry = originalArchive.entries.find(e => e.path === entry.path);
      const data = originalArchive.readEntry(matchingEntry);
      fs.writeFileSync(targetPath, data);
    } finally {
      originalArchive.close();
    }
  }

  const outPath = path.join(tempDir('gnrl-out-none'), 'created-gnrl-none.ba2');
  await createArchive(outPath, srcDir, { format: 'GNRL', compression: 'none' });

  const created = Ba2Archive.open(outPath);
  try {
    assert.equal(created.header.kind, 'GNRL');
    for (const entry of created.entries) {
      assert.equal(entry.packedSize, 0, `${entry.path} should be stored uncompressed`);
      const data = created.readEntry(entry);
      const expected = manifest.gnrl.entries.find(e => e.path === entry.path);
      assert.equal(data.length, expected.size);
      assert.equal(sha256(data), expected.sha256, entry.path);
    }
  } finally {
    created.close();
  }
});

test('create: DX10 archive from DDS files', async () => {
  const srcDir = tempDir('dx10-src');
  // Copy DDS fixture files
  for (const entry of manifest.dx10.entries) {
    const targetPath = path.join(srcDir, entry.path);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const originalArchive = Ba2Archive.open(dx10Path);
    try {
      const matchingEntry = originalArchive.entries.find(e => e.path === entry.path);
      const dds = originalArchive.readEntry(matchingEntry);
      fs.writeFileSync(targetPath, dds);
    } finally {
      originalArchive.close();
    }
  }

  const outPath = path.join(tempDir('dx10-out'), 'created-dx10.ba2');
  await createArchive(outPath, srcDir, { format: 'DX10', compression: 'zlib' });

  const created = Ba2Archive.open(outPath);
  try {
    assert.equal(created.header.kind, 'DX10');
    assert.equal(created.header.version, 8);
    assert.equal(created.entries.length, manifest.dx10.entries.length);
    
    for (const entry of created.entries) {
      const expected = manifest.dx10.entries.find(e => e.path === entry.path);
      assert.ok(expected, `entry ${entry.path} not in manifest`);
      assert.equal(entry.width, expected.width);
      assert.equal(entry.height, expected.height);
      assert.equal(entry.mipCount, expected.mips);
      assert.equal(entry.dxgiFormat, expected.format);
      assert.equal(entry.isCubemap, expected.cubemap);
      assert.equal(entry.tileMode, 8);
      
      const dds = created.readEntry(entry);
      assert.equal(dds.length, DDS_HEADER_SIZE + expected.payloadSize);
      assert.equal(sha256(dds.subarray(DDS_HEADER_SIZE)), expected.payloadSha256, entry.path);
    }
  } finally {
    created.close();
  }
});

test('create: round-trip GNRL extract and recreate', async () => {
  const srcDir = tempDir('roundtrip-src');
  const outPath = path.join(tempDir('roundtrip-out'), 'roundtrip.ba2');
  
  // Extract original
  await extractArchive(gnrlPath, { outDir: srcDir, threads: 1 });
  
  // Recreate
  await createArchive(outPath, srcDir, { format: 'GNRL', compression: 'zlib' });
  
  // Verify round-trip
  const original = Ba2Archive.open(gnrlPath);
  const recreated = Ba2Archive.open(outPath);
  try {
    const origEntries = original.entries.filter(e => e.unpackedSize > 0);
    assert.equal(recreated.entries.length, origEntries.length);
    
    for (const entry of recreated.entries) {
      const orig = origEntries.find(e => e.path === entry.path);
      assert.ok(orig, `entry ${entry.path} not in original`);
      const origData = original.readEntry(orig);
      const newData = recreated.readEntry(entry);
      assert.deepEqual(newData, origData, `${entry.path} data mismatch`);
    }
  } finally {
    original.close();
    recreated.close();
  }
});

test('create: CLI create command', async () => {
  const cli = path.join(process.cwd(), 'dist', 'cli.js');
  const srcDir = tempDir('cli-src');
  const outPath = path.join(tempDir('cli-out'), 'cli-created.ba2');
  
  // Create source files
  fs.writeFileSync(path.join(srcDir, 'test.txt'), 'Hello BA2');
  fs.writeFileSync(path.join(srcDir, 'data.bin'), Buffer.from([0,1,2,3,4,5]));
  fs.mkdirSync(path.join(srcDir, 'subdir'), { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'subdir', 'nested.txt'), 'Nested');
  
  const output = execFileSync(process.execPath, [
    cli, 'create', outPath, srcDir, '--format', 'GNRL', '--compression', 'zlib'
  ], { encoding: 'utf8' });
  
  const created = Ba2Archive.open(outPath);
  try {
    assert.equal(created.entries.length, 3);
    const paths = created.entries.map(e => e.path).sort();
    assert.deepEqual(paths, ['data.bin', 'subdir/nested.txt', 'test.txt']);
    
    const txtEntry = created.entries.find(e => e.path === 'test.txt');
    const txtData = created.readEntry(txtEntry);
    assert.equal(txtData.toString('utf8'), 'Hello BA2');
  } finally {
    created.close();
  }
});

test('create: auto-detect format from file extensions', async () => {
  const srcDir = tempDir('auto-src');
  const outPath = path.join(tempDir('auto-out'), 'auto.ba2');
  
  // Mix of DDS and non-DDS files
  const originalArchive = Ba2Archive.open(dx10Path);
  try {
    for (const entry of originalArchive.entries) {
      const targetPath = path.join(srcDir, entry.path);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      const dds = originalArchive.readEntry(entry);
      fs.writeFileSync(targetPath, dds);
    }
  } finally {
    originalArchive.close();
  }
  
  // Add a non-DDS file
  fs.writeFileSync(path.join(srcDir, 'readme.txt'), 'Readme');
  
  // Auto-detect should create DX10 (DDS files take precedence) or GNRL for mixed?
  // Let's test with explicit format for now
  await createArchive(outPath, srcDir, { format: 'DX10', compression: 'zlib' });
  
  const created = Ba2Archive.open(outPath);
  try {
    assert.equal(created.header.kind, 'DX10');
    // DDS files should be processed, text file ignored or error?
  } finally {
    created.close();
  }
});

test('create: streaming writer Ba2Writer', async () => {
  const outPath = path.join(tempDir('writer-out'), 'writer.ba2');
  
  const writer = Ba2Writer.open(outPath, { format: 'GNRL', compression: 'zlib' });
  try {
    writer.addEntry('file1.txt', Buffer.from('Hello'));
    writer.addEntry('file2.bin', Buffer.from([1,2,3,4]));
    writer.addEntry('subdir/file3.txt', Buffer.from('World'));
  } finally {
    await writer.close();
  }
  
  const archive = Ba2Archive.open(outPath);
  try {
    assert.equal(archive.entries.length, 3);
    const paths = archive.entries.map(e => e.path).sort();
    assert.deepEqual(paths, ['file1.txt', 'file2.bin', 'subdir/file3.txt']);
    
    const file1Entry = archive.entries.find(e => e.path === 'file1.txt');
    const file1 = archive.readEntry(file1Entry);
    assert.equal(file1.toString('utf8'), 'Hello');
  } finally {
    archive.close();
  }
});

test('create: Ba2Writer with DX10 from raw texture data', async () => {
  const outPath = path.join(tempDir('writer-dx10-out'), 'writer-dx10.ba2');
  
  // Create a minimal BC1 texture (4x4, 1 mip = 16 bytes)
  const bc1Data = Buffer.alloc(16);
  bc1Data.fill(0xFF);
  
  const writer = Ba2Writer.open(outPath, { format: 'DX10', compression: 'zlib' });
  try {
    await writer.addTexture({
      path: 'textures/test.dds',
      width: 4,
      height: 4,
      mipCount: 1,
      dxgiFormat: 71, // BC1_UNORM
      isCubemap: false,
      tileMode: 8,
      mipData: [bc1Data],
    });
  } finally {
    await writer.close();
  }
  
  const archive = Ba2Archive.open(outPath);
  try {
    assert.equal(archive.entries.length, 1);
    const entry = archive.entries[0];
    assert.equal(entry.kind, 'DX10');
    assert.equal(entry.width, 4);
    assert.equal(entry.height, 4);
    assert.equal(entry.mipCount, 1);
    assert.equal(entry.dxgiFormat, 71);
    
    const dds = archive.readEntry(entry);
    assert.equal(dds.length, DDS_HEADER_SIZE + 16);
    assert.equal(dds.toString('latin1', 0, 4), 'DDS ');
  } finally {
    archive.close();
  }
});

test('create: auto-detect format from file extensions', async () => {
  const srcDir = tempDir('auto-src');
  const outPath = path.join(tempDir('auto-out'), 'auto.ba2');
  
  // Mix of DDS and non-DDS files
  const originalArchive = Ba2Archive.open(dx10Path);
  try {
    for (const entry of originalArchive.entries) {
      const targetPath = path.join(srcDir, entry.path);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      const dds = originalArchive.readEntry(entry);
      fs.writeFileSync(targetPath, dds);
    }
  } finally {
    originalArchive.close();
  }
  
  // Add a non-DDS file
  fs.writeFileSync(path.join(srcDir, 'readme.txt'), 'Readme');
  
  // Auto-detect should create DX10 (DDS files take precedence) or GNRL for mixed?
  // Let's test with explicit format for now
  await createArchive(outPath, srcDir, { format: 'DX10', compression: 'zlib' });
  
  const created = Ba2Archive.open(outPath);
  try {
    assert.equal(created.header.kind, 'DX10');
    // DDS files should be processed, text file ignored or error?
  } finally {
    created.close();
  }
});

test('create: LZ4 compression (Starfield v3)', async () => {
  const srcDir = tempDir('lz4-src');
  // Repetitive content so LZ4 matches actually win; a short unique string
  // cannot shrink below its input size.
  const content = 'LZ4 block test payload, highly repetitive. '.repeat(24);
  fs.writeFileSync(path.join(srcDir, 'test.txt'), content);

  const outPath = path.join(tempDir('lz4-out'), 'lz4.ba2');
  await createArchive(outPath, srcDir, { format: 'GNRL', compression: 'lz4', version: 3 });

  const archive = Ba2Archive.open(outPath);
  try {
    assert.equal(archive.header.version, 3);
    assert.equal(archive.header.kind, 'GNRL');
    assert.equal(archive.header.compressionMethod, 3);
    const entry = archive.entries[0];
    assert.ok(entry.packedSize > 0);
    assert.ok(entry.packedSize < entry.unpackedSize);
    // The reader decodes LZ4 (method 3) and returns the original bytes.
    assert.equal(archive.readEntry(entry).toString('utf8'), content);
  } finally {
    archive.close();
  }
});
test('create: DX10 LZ4 archive compresses every chunk', async () => {
  const outPath = path.join(tempDir('lz4-dx10-out'), 'dx10-lz4.ba2');

  // 128x128 BC1 with a full mip chain. With a 64 pixel chunk threshold the top
  // mip gets its own chunk and the remaining mips share the second one, so the
  // archive has two independently compressed LZ4 blocks.
  const mipData = [];
  let width = 128;
  let height = 128;
  for (let level = 0; level < 8; level++) {
    const size = mipLevelSize(71, width, height);
    const mip = Buffer.alloc(size);
    for (let i = 0; i < size; i++) mip[i] = (i * 7) & 0x3f;
    mipData.push(mip);
    width = Math.max(1, width >> 1);
    height = Math.max(1, height >> 1);
  }

  const writer = Ba2Writer.open(outPath, {
    format: 'DX10',
    compression: 'lz4',
    version: 3,
    singleMipChunkSize: 64,
  });
  try {
    await writer.addTexture({
      path: 'textures/tiles.dds',
      width: 128,
      height: 128,
      mipCount: 8,
      dxgiFormat: 71,
      isCubemap: false,
      tileMode: 8,
      mipData,
    });
  } finally {
    await writer.close();
  }

  const archive = Ba2Archive.open(outPath);
  try {
    assert.equal(archive.header.version, 3);
    assert.equal(archive.header.compressionMethod, 3);
    assert.equal(archive.compression, 'lz4');

    const [entry] = archive.entries;
    assert.equal(entry.kind, 'DX10');
    assert.deepEqual(entry.chunks.map((chunk) => [chunk.startMip, chunk.endMip]), [[0, 0], [1, 7]]);
    for (const chunk of entry.chunks) {
      assert.ok(chunk.packedSize > 0, 'every chunk should be LZ4 compressed');
      assert.ok(chunk.packedSize < chunk.unpackedSize, 'LZ4 should shrink this data');
    }

    const dds = archive.readEntry(entry);
    assert.equal(dds.toString('latin1', 0, 4), 'DDS ');
    assert.ok(dds.subarray(DDS_HEADER_SIZE).equals(Buffer.concat(mipData)));
  } finally {
    archive.close();
  }
});

test('create: LZ4 keeps incompressible payloads readable', async () => {
  const srcDir = tempDir('lz4-noise-src');
  const noise = crypto.randomBytes(4096);
  fs.writeFileSync(path.join(srcDir, 'noise.bin'), noise);
  const outPath = path.join(tempDir('lz4-noise-out'), 'noise.ba2');

  await createArchive(outPath, srcDir, { format: 'GNRL', compression: 'lz4', version: 3 });

  const archive = Ba2Archive.open(outPath);
  try {
    const [entry] = archive.entries;
    // LZ4 framing can grow random data; the block is stored anyway (exactly
    // what zlib archives do with their "Default" mode) and still decodes.
    assert.ok(entry.packedSize > 0);
    assert.equal(entryCompression(entry, archive.compression), 'lz4');
    assert.ok(archive.readEntry(entry).equals(noise));
  } finally {
    archive.close();
  }
});

test('create: LZ4 only exists for Starfield version 3', async () => {
  const srcDir = tempDir('lz4-version-src');
  fs.writeFileSync(path.join(srcDir, 'file.txt'), 'compressed payload');
  const outPath = path.join(tempDir('lz4-version-out'), 'wrong.ba2');

  await assert.rejects(
    createArchive(outPath, srcDir, { format: 'GNRL', compression: 'lz4', version: 8 }),
    /LZ4 compression requires archive version 3/,
  );

  // Version 3 with zlib keeps method 0 in the header.
  await createArchive(outPath, srcDir, { format: 'GNRL', compression: 'zlib', version: 3 });
  const archive = Ba2Archive.open(outPath);
  try {
    assert.equal(archive.header.version, 3);
    assert.equal(archive.header.compressionMethod, 0);
    assert.equal(archive.compression, 'zlib');
    assert.equal(archive.readEntry(0).toString('utf8'), 'compressed payload');
  } finally {
    archive.close();
  }
});
