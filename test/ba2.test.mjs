import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  Ba2Archive,
  compileFilter,
  extractArchive,
  mipChainSize,
} from '../dist/index.js';

const DATA_DIR =
  process.env.FO76_DATA ?? 'C:/Program Files (x86)/Steam/steamapps/common/Fallout76/Data';
const hasData = fs.existsSync(DATA_DIR);
const archive = (name) => path.join(DATA_DIR, name);

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ba2-${label}-`));
}

test('GNRL: header, records and name table', { skip: !hasData && 'Fallout 76 data not found' }, () => {
  const file = archive('BetterContainers.ba2');
  const ba2 = Ba2Archive.open(file);
  try {
    assert.equal(ba2.header.kind, 'GNRL');
    assert.equal(ba2.header.version, 1);
    assert.equal(ba2.entries.length, 1);
    const entry = ba2.entries[0];
    assert.equal(entry.path, 'Interface/BetterContainers.swf');
    assert.equal(entry.extension, 'swf');
    assert.equal(entry.offset + entry.unpackedSize, ba2.header.nameTableOffset);
  } finally {
    ba2.close();
  }
});

test('GNRL: uncompressed payload is returned verbatim', { skip: !hasData && 'Fallout 76 data not found' }, () => {
  const ba2 = Ba2Archive.open(archive('76Radio.ba2'));
  try {
    assert.equal(ba2.entries.length, 2);
    for (const entry of ba2.entries) {
      const data = ba2.readEntry(entry);
      assert.equal(data.length, entry.unpackedSize);
      assert.match(data.toString('latin1', 0, 3), /^(CWS|FWS|ZWS)$/);
    }
  } finally {
    ba2.close();
  }
});

test('GNRL: zlib payloads inflate to the declared size', { skip: !hasData && 'Fallout 76 data not found' }, () => {
  const samples = ['EventNotifications.ba2', 'FastUI.ba2', 'CampBudgetAndBuildingCosts.ba2'];
  for (const name of samples) {
    const ba2 = Ba2Archive.open(archive(name));
    try {
      const entry = ba2.entries[0];
      assert.ok(entry.packedSize > 0, `${name} should be compressed`);
      const data = ba2.readEntry(entry);
      assert.equal(data.length, entry.unpackedSize);
      assert.match(data.toString('latin1', 0, 3), /^(CWS|FWS|ZWS)$/);
    } finally {
      ba2.close();
    }
  }
});

test('DX10: texture metadata, chunk sizes and DDS header', { skip: !hasData && 'Fallout 76 data not found' }, () => {
  const ba2 = Ba2Archive.open(archive('ScorchedMaps.ba2'));
  try {
    assert.equal(ba2.header.kind, 'DX10');
    const entry = ba2.entries[0];
    assert.equal(entry.kind, 'DX10');
    assert.equal(entry.dxgiFormat, 77);
    assert.equal(entry.width, 4096);
    assert.equal(entry.height, 4096);
    assert.equal(entry.mipCount, 13);
    assert.equal(entry.chunks.length, 4);
    assert.equal(entry.chunks[0].unpackedSize, 4096 * 4096);

    const chunkBytes = entry.chunks.reduce((sum, chunk) => sum + chunk.unpackedSize, 0);
    assert.equal(chunkBytes, mipChainSize(entry.dxgiFormat, entry.width, entry.height, entry.mipCount));

    const dds = ba2.readEntry(entry);
    assert.equal(dds.toString('latin1', 0, 4), 'DDS ');
    assert.equal(dds.readUInt32LE(4), 124);
    assert.equal(dds.readUInt32LE(12), 4096); // height
    assert.equal(dds.readUInt32LE(16), 4096); // width
    assert.equal(dds.readUInt32LE(28), 13); // mip count
    assert.equal(dds.toString('latin1', 84, 88), 'DX10');
    assert.equal(dds.readUInt32LE(128), 77); // DXGI format
    assert.equal(dds.readUInt32LE(132), 3); // TEXTURE2D
    assert.equal(dds.length, 148 + chunkBytes);
  } finally {
    ba2.close();
  }
});

test('DX10: compressed BC1 texture from a 4 GiB archive', { skip: !hasData && 'Fallout 76 data not found' }, () => {
  const ba2 = Ba2Archive.open(archive('SeventySix - Textures01.ba2'));
  try {
    const entry = ba2.entries[0];
    assert.equal(entry.width, 1024);
    assert.equal(entry.mipCount, 11);
    assert.equal(entry.dxgiFormat, 71);
    const chunkBytes = entry.chunks.reduce((sum, chunk) => sum + chunk.unpackedSize, 0);
    const dds = ba2.readEntry(entry);
    assert.equal(dds.length, 148 + chunkBytes);
    assert.equal(dds.toString('latin1', 0, 4), 'DDS ');
  } finally {
    ba2.close();
  }
});

test('extract: single threaded output matches archive payloads', { skip: !hasData && 'Fallout 76 data not found' }, async () => {
  const out = tempDir('single');
  const result = await extractArchive(archive('EventNotifications.ba2'), {
    outDir: out,
    threads: 1,
  });
  assert.equal(result.errors.length, 0);
  assert.equal(result.extracted, 1);
  const entry = Ba2Archive.open(archive('EventNotifications.ba2'));
  const expected = entry.readEntry(0);
  entry.close();
  const written = fs.readdirSync(out, { recursive: true }).filter((name) => fs.statSync(path.join(out, name)).isFile());
  assert.equal(written.length, 1);
  const data = fs.readFileSync(path.join(out, written[0]));
  assert.deepEqual(data, expected);
});

test('extract: parallel workers produce identical files', { skip: !hasData && 'Fallout 76 data not found' }, async () => {
  const single = tempDir('par1');
  const parallel = tempDir('par8');
  const file = archive('SeventySix - WorkshopIcons.ba2');
  const filter = '*.dds';
  const a = await extractArchive(file, { outDir: single, threads: 1, filter });
  const b = await extractArchive(file, { outDir: parallel, threads: 4, filter });
  assert.equal(a.errors.length, 0);
  assert.equal(b.errors.length, 0);
  assert.equal(a.extracted, b.extracted);
  assert.ok(a.extracted > 10);
  const files = fs.readdirSync(single, { recursive: true }).filter((name) => name.endsWith('.dds'));
  assert.equal(files.length, a.extracted);
  for (const name of files) {
    const left = fs.readFileSync(path.join(single, name));
    const right = fs.readFileSync(path.join(parallel, name));
    assert.equal(left.length, right.length, name);
    assert.ok(left.equals(right), name);
  }
});

test('extract: filter matches nested paths and rejects others', { skip: !hasData && 'Fallout 76 data not found' }, async () => {
  const matches = compileFilter('*.nif');
  const ba2 = Ba2Archive.open(archive('SeventySix - Meshes.ba2'));
  try {
    const names = ba2.entries.filter(matches).slice(0, 50).map((entry) => entry.path);
    assert.ok(names.length > 0);
    assert.ok(names.every((name) => name.endsWith('.nif')));
  } finally {
    ba2.close();
  }
  const out = tempDir('filter');
  const result = await extractArchive(archive('SeventySix - Meshes.ba2'), {
    outDir: out,
    filter: 'meshes/architecture/*',
    threads: 2,
  });
  assert.equal(result.errors.length, 0);
  assert.equal(result.selected, result.extracted + result.skipped);
});

test('extract: dry run writes nothing and validates payloads', { skip: !hasData && 'Fallout 76 data not found' }, async () => {
  const out = tempDir('dry');
  const result = await extractArchive(archive('ImprovedPipboyStats.ba2'), {
    outDir: out,
    dryRun: true,
  });
  assert.equal(result.errors.length, 0);
  assert.equal(result.extracted, 1);
  assert.deepEqual(fs.readdirSync(out), []);
});

test('cli: list and extract', { skip: !hasData && 'Fallout 76 data not found' }, () => {
  const cli = path.join(process.cwd(), 'dist', 'cli.js');
  const listed = execFileSync(
    process.execPath,
    [cli, 'list', archive('76Radio.ba2'), '--json'],
    { encoding: 'utf8' },
  );
  const rows = JSON.parse(listed);
  assert.equal(rows.length, 2);
  assert.ok(rows[0].path.endsWith('.swf'));

  const out = tempDir('cli');
  const output = execFileSync(
    process.execPath,
    [cli, 'extract', archive('76Radio.ba2'), '--out', out, '--threads', '1'],
    { encoding: 'utf8' },
  );
  assert.match(output, /2 extracted/);
  const files = fs.readdirSync(out, { recursive: true }).filter((name) => fs.statSync(path.join(out, name)).isFile());
  assert.equal(files.length, 2);
});
