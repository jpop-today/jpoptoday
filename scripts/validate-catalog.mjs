import { readFile } from 'node:fs/promises';
import { validateCatalog } from '../contracts/catalog.mjs';

const inputPath = process.argv[2];
if (!inputPath || process.argv.length !== 3) {
  process.stderr.write('Usage: node scripts/validate-catalog.mjs <catalog.json>\n');
  process.exitCode = 1;
} else {
  try {
    const catalog = JSON.parse(await readFile(inputPath, 'utf8'));
    const errors = validateCatalog(catalog);
    if (errors.length) {
      for (const error of errors) process.stderr.write(error.path + ': ' + error.message + '\n');
      process.exitCode = 1;
    } else {
      process.stdout.write('Catalog valid: ' + catalog.songs.length + ' songs, ' + catalog.artists.length + ' artists\n');
    }
  } catch (error) {
    process.stderr.write('Cannot validate catalog: ' + error.message + '\n');
    process.exitCode = 1;
  }
}
