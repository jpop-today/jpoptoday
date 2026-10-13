import { promoteCatalog } from '../contracts/catalog-snapshot.mjs';

const [inputPath, snapshotPath] = process.argv.slice(2);
if (!inputPath || !snapshotPath || process.argv.length !== 4) {
  process.stderr.write('Usage: node scripts/promote-catalog.mjs <candidate.json> <snapshot.json>\n');
  process.exitCode = 1;
} else {
  try {
    const result = await promoteCatalog(inputPath, snapshotPath);
    process.stdout.write('Catalog snapshot promoted: ' + result.songs + ' songs, ' + result.artists + ' artists\n');
  } catch (error) {
    process.stderr.write('Cannot promote catalog: ' + error.message + '\n');
    for (const item of error.errors ?? [])
      process.stderr.write(item.path + ': ' + item.message + '\n');
    process.exitCode = 1;
  }
}
