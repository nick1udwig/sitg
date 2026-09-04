import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = resolve(projectRoot, 'dist');
const html = readFileSync(resolve(distRoot, 'index.html'), 'utf8');
const entryMatch = html.match(/<script[^>]+src="([^"]+\.js)"/);

if (!entryMatch) {
  throw new Error('Could not find the JavaScript entry point in dist/index.html.');
}

const entryPath = resolve(distRoot, entryMatch[1].replace(/^\/+/, ''));
const entryBytes = statSync(entryPath).size;
const maximumEntryBytes = 350_000;

if (entryBytes > maximumEntryBytes) {
  throw new Error(
    `Initial JavaScript entry is ${entryBytes} bytes; expected at most ${maximumEntryBytes}. `
      + 'Keep wallet and route-specific dependencies behind dynamic imports.'
  );
}

console.log(`Initial JavaScript entry: ${entryBytes} bytes (limit ${maximumEntryBytes}).`);
