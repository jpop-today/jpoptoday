import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promoteCatalog } from '../contracts/catalog-snapshot.mjs';

const fixtureBytes = await fs.readFile(new URL('./fixtures/catalog.json', import.meta.url));
const sample = () => JSON.parse(fixtureBytes);

async function setup(t) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'jpoptoday-snapshot-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const input = join(directory, 'candidate.json');
  const snapshot = join(directory, 'snapshot.json');
  await fs.writeFile(input, fixtureBytes);
  await fs.writeFile(snapshot, fixtureBytes);
  return { directory, input, snapshot };
}

async function assertPreserved(context) {
  assert.deepEqual(await fs.readFile(context.snapshot), fixtureBytes);
  assert.deepEqual((await fs.readdir(context.directory)).sort(), ['candidate.json', 'snapshot.json']);
}

test('promotes validated bytes without changing IDs, evidence, number strings, or unknown status', async t => {
  const context = await setup(t);
  const catalog = sample();
  catalog.songs[0].titleKo = '새 테스트 곡';
  const bytes = Buffer.from(JSON.stringify(catalog, null, 4) + '\n');
  await fs.writeFile(context.input, bytes);
  assert.deepEqual(await promoteCatalog(context.input, context.snapshot), { songs: 1, artists: 1 });
  assert.deepEqual(await fs.readFile(context.snapshot), bytes);
  assert.deepEqual(await fs.readFile(context.input), bytes);
  const result = JSON.parse(await fs.readFile(context.snapshot));
  assert.equal(result.songs[0].karaoke.tj.number, '00042');
  assert.deepEqual(result.songs[0].karaoke.ky, { status: 'unknown', number: null });
  assert.equal(result.songs[0].karaoke.tj.sourceUrl, 'https://example.com/test-only');
  assert.deepEqual((await fs.readdir(context.directory)).sort(), ['candidate.json', 'snapshot.json']);
});

test('creates the first snapshot only from validated input', async t => {
  const context = await setup(t);
  await fs.unlink(context.snapshot);
  await promoteCatalog(context.input, context.snapshot);
  assert.deepEqual(await fs.readFile(context.snapshot), fixtureBytes);
});

test('missing candidate preserves the last snapshot', async t => {
  const context = await setup(t);
  await assert.rejects(promoteCatalog(join(context.directory, 'missing.json'), context.snapshot), { code: 'ENOENT' });
  await assertPreserved(context);
});

for (const [label, bytes] of [
  ['empty collection output', Buffer.from('')],
  ['broken JSON', Buffer.from('{')],
  ['empty catalog', Buffer.from(JSON.stringify({ schemaVersion: 1, artists: [], songs: [] }))],
  ['unsupported schema', Buffer.from(JSON.stringify({ ...sample(), schemaVersion: 2 }))],
  ['invalid UTF-8 inside JSON', Buffer.concat([Buffer.from('{"extra":"'), Buffer.from([0xff]), Buffer.from('",'), fixtureBytes.subarray(1)])],
]) {
  test(label + ' preserves the last snapshot', async t => {
    const context = await setup(t);
    await fs.writeFile(context.input, bytes);
    await assert.rejects(promoteCatalog(context.input, context.snapshot));
    await assertPreserved(context);
  });
}

test('invalid provider evidence preserves the last snapshot instead of inventing missing fields', async t => {
  const context = await setup(t);
  const catalog = sample();
  delete catalog.songs[0].karaoke.tj.sourceUrl;
  await fs.writeFile(context.input, JSON.stringify(catalog));
  await assert.rejects(promoteCatalog(context.input, context.snapshot), error => {
    assert.equal(error.code, 'INVALID_CATALOG');
    assert.ok(error.errors.some(item => item.path === 'songs[0].karaoke.tj.sourceUrl'));
    return true;
  });
  await assertPreserved(context);
});

test('same input/output paths and normalized aliases are rejected without writes', async t => {
  const context = await setup(t);
  for (const output of [context.input, join(context.directory, 'ignored', '..', 'candidate.json')])
    await assert.rejects(promoteCatalog(context.input, output), { code: 'SAME_FILE' });
  await assertPreserved(context);
});

test('an input symlink to the snapshot is rejected without writes', async t => {
  const context = await setup(t);
  await fs.unlink(context.input);
  await fs.symlink(context.snapshot, context.input);
  await assert.rejects(promoteCatalog(context.input, context.snapshot), { code: 'SAME_FILE' });
  await assertPreserved(context);
  assert.ok((await fs.lstat(context.input)).isSymbolicLink());
});

test('same file through a hard link is rejected without breaking either link', async t => {
  const context = await setup(t);
  await fs.unlink(context.input);
  await fs.link(context.snapshot, context.input);
  await assert.rejects(promoteCatalog(context.input, context.snapshot), { code: 'SAME_FILE' });
  await assertPreserved(context);
  assert.equal((await fs.stat(context.input)).ino, (await fs.stat(context.snapshot)).ino);
});

test('a symlink in the destination directory cannot disguise identical paths', async t => {
  const context = await setup(t);
  const directoryAlias = join(context.directory, 'alias');
  await fs.symlink(context.directory, directoryAlias, 'dir');
  await assert.rejects(promoteCatalog(context.snapshot, join(directoryAlias, 'snapshot.json')), { code: 'SAME_FILE' });
  assert.deepEqual(await fs.readFile(context.snapshot), fixtureBytes);
  assert.deepEqual((await fs.readdir(context.directory)).sort(), ['alias', 'candidate.json', 'snapshot.json']);
});

test('destination symlink is rejected and its target preserved', async t => {
  const context = await setup(t);
  const target = join(context.directory, 'unrelated.json');
  await fs.writeFile(target, 'unrelated content');
  await fs.unlink(context.snapshot);
  await fs.symlink(target, context.snapshot);
  await assert.rejects(promoteCatalog(context.input, context.snapshot), { code: 'INVALID_OUTPUT' });
  assert.equal(await fs.readFile(target, 'utf8'), 'unrelated content');
  assert.ok((await fs.lstat(context.snapshot)).isSymbolicLink());
});

test('destination directory is rejected without changing its contents', async t => {
  const context = await setup(t);
  await fs.unlink(context.snapshot);
  await fs.mkdir(context.snapshot);
  await fs.writeFile(join(context.snapshot, 'keep.txt'), 'keep');
  await assert.rejects(promoteCatalog(context.input, context.snapshot), { code: 'INVALID_OUTPUT' });
  assert.equal(await fs.readFile(join(context.snapshot, 'keep.txt'), 'utf8'), 'keep');
});

test('missing destination directory is reported without creating parent directories', async t => {
  const context = await setup(t);
  await assert.rejects(promoteCatalog(context.input, join(context.directory, 'missing', 'snapshot.json')), { code: 'ENOENT' });
  await assertPreserved(context);
});

test('failure to open a staging file preserves the last snapshot', async t => {
  const context = await setup(t);
  const io = { ...fs, open: async () => { throw Object.assign(new Error('injected open failure'), { code: 'EACCES' }); } };
  await assert.rejects(promoteCatalog(context.input, context.snapshot, io), { code: 'EACCES' });
  await assertPreserved(context);
});

test('failed exclusive open does not delete an existing file it did not create', async t => {
  const context = await setup(t);
  let occupiedPath;
  const io = { ...fs, open: async (path, flags, mode) => {
    occupiedPath = path;
    await fs.writeFile(path, 'owned by another writer');
    return fs.open(path, flags, mode);
  } };
  await assert.rejects(promoteCatalog(context.input, context.snapshot, io), { code: 'EEXIST' });
  assert.equal(await fs.readFile(occupiedPath, 'utf8'), 'owned by another writer');
  assert.deepEqual(await fs.readFile(context.snapshot), fixtureBytes);
});

for (const operation of ['writeFile', 'sync', 'close']) {
  test(operation + ' failure preserves the snapshot and removes a partially written staging file', async t => {
    const context = await setup(t);
    let failed = false;
    const io = { ...fs, open: async (...args) => {
      const handle = await fs.open(...args);
      return {
        writeFile: async bytes => {
          if (operation === 'writeFile') {
            await handle.writeFile(bytes.subarray(0, 20));
            throw Object.assign(new Error('injected partial write failure'), { code: 'ENOSPC' });
          }
          return handle.writeFile(bytes);
        },
        sync: async () => {
          if (operation === 'sync') throw Object.assign(new Error('injected sync failure'), { code: 'EIO' });
          return handle.sync();
        },
        close: async () => {
          if (operation === 'close' && !failed) {
            failed = true;
            throw Object.assign(new Error('injected close failure'), { code: 'EIO' });
          }
          return handle.close();
        },
      };
    } };
    await assert.rejects(promoteCatalog(context.input, context.snapshot, io));
    await assertPreserved(context);
  });
}

test('rename failure preserves the snapshot and removes the completed staging file', async t => {
  const context = await setup(t);
  const io = { ...fs, rename: async () => { throw Object.assign(new Error('injected rename failure'), { code: 'EIO' }); } };
  await assert.rejects(promoteCatalog(context.input, context.snapshot, io), { code: 'EIO' });
  await assertPreserved(context);
});

test('readers see a complete previous snapshot until the final rename', async t => {
  const context = await setup(t);
  const catalog = sample();
  catalog.songs[0].titleKo = '승격 후보';
  const candidateBytes = Buffer.from(JSON.stringify(catalog));
  await fs.writeFile(context.input, candidateBytes);
  const io = { ...fs, rename: async (from, to) => {
    assert.deepEqual(await fs.readFile(context.snapshot), fixtureBytes);
    assert.deepEqual(await fs.readFile(from), candidateBytes);
    return fs.rename(from, to);
  } };
  await promoteCatalog(context.input, context.snapshot, io);
  assert.deepEqual(await fs.readFile(context.snapshot), candidateBytes);
});
