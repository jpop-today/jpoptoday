import * as filesystem from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { validateCatalog } from './catalog.mjs';

export class CatalogSnapshotError extends Error {
  constructor(message, code, errors = []) {
    super(message);
    this.name = 'CatalogSnapshotError';
    this.code = code;
    this.errors = errors;
  }
}

// The optional filesystem parameter lets tests exercise failed writes without
// relying on platform permissions. Production uses Node's filesystem directly.
export async function promoteCatalog(inputPath, snapshotPath, io = filesystem) {
  if (typeof inputPath !== 'string' || !inputPath || typeof snapshotPath !== 'string' || !snapshotPath)
    throw new CatalogSnapshotError('Input and snapshot paths are required', 'INVALID_PATH');
  if (resolve(inputPath) === resolve(snapshotPath))
    throw new CatalogSnapshotError('Input and snapshot must be different files', 'SAME_FILE');

  const sourcePath = await io.realpath(inputPath);
  const resolvedOutputPath = resolve(snapshotPath);
  const outputDirectory = await io.realpath(dirname(resolvedOutputPath));
  const outputPath = join(outputDirectory, basename(resolvedOutputPath));
  if (sourcePath === outputPath)
    throw new CatalogSnapshotError('Input and snapshot must be different files', 'SAME_FILE');

  const inputStat = await io.stat(sourcePath);
  if (!inputStat.isFile())
    throw new CatalogSnapshotError('Input must be a regular file', 'INVALID_INPUT');

  let outputStat;
  try {
    outputStat = await io.lstat(outputPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (outputStat && !outputStat.isFile())
    throw new CatalogSnapshotError('Snapshot must be a regular file, not a link or directory', 'INVALID_OUTPUT');
  if (outputStat && outputStat.dev === inputStat.dev && outputStat.ino === inputStat.ino)
    throw new CatalogSnapshotError('Input and snapshot must be different files', 'SAME_FILE');

  const bytes = await io.readFile(sourcePath);
  let catalog;
  try {
    // Reject damaged UTF-8 rather than silently changing song names.
    catalog = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    throw new CatalogSnapshotError('Input must contain valid UTF-8 JSON', 'INVALID_JSON');
  }
  const errors = validateCatalog(catalog);
  if (errors.length)
    throw new CatalogSnapshotError('Catalog failed validation; snapshot was preserved', 'INVALID_CATALOG', errors);

  const stagedPath = join(outputDirectory, '.' + basename(outputPath) + '.' + randomUUID() + '.tmp');
  let handle;
  let created = false;
  try {
    handle = await io.open(stagedPath, 'wx', outputStat ? outputStat.mode & 0o777 : 0o644);
    created = true;
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    // The staging file shares the destination filesystem, so no partial
    // destination becomes visible. Nothing is written to the source file.
    await io.rename(stagedPath, outputPath);
    created = false;
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (created) await io.unlink(stagedPath).catch(() => {});
  }
  return { songs: catalog.songs.length, artists: catalog.artists.length };
}
