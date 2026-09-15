import assert from 'node:assert/strict';
import { readFile, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';

const json = async path => JSON.parse(await readFile(path, 'utf8'));
const [manifest, pkg, lock, versions] = await Promise.all(['manifest.json', 'package.json', 'package-lock.json', 'versions.json'].map(json));
assert.match(manifest.id, /^[a-z]+(?:-[a-z]+)*$/);
assert(!manifest.id.includes('obsidian') && !manifest.id.endsWith('plugin'));
for (const key of ['name', 'author', 'description']) assert.equal(typeof manifest[key], 'string');
assert(manifest.name && manifest.author && manifest.description.length > 0 && manifest.description.length <= 250);
for (const value of [manifest.version, manifest.minAppVersion]) assert.match(value, /^\d+\.\d+\.\d+$/);
assert.equal(typeof manifest.isDesktopOnly, 'boolean');
assert.equal(manifest.version, pkg.version);
assert.equal(pkg.version, lock.version);
assert.equal(pkg.version, lock.packages[''].version);
assert.equal(versions[manifest.version], manifest.minAppVersion);
assert.deepEqual(pkg.dependencies, lock.packages[''].dependencies);
assert.deepEqual(pkg.devDependencies, lock.packages[''].devDependencies);
const result = await build({ entryPoints: ['src/main.ts'], bundle: true, external: ['obsidian', '@codemirror/*', '@lezer/*'], platform: 'browser', format: 'cjs', write: false, metafile: true });
for (const output of Object.values(result.metafile.outputs)) {
  for (const item of output.imports) assert(/^(obsidian|@codemirror\/[^/]+|@lezer\/[^/]+)$/.test(item.path), `Unexpected runtime dependency: ${item.path}`);
}
const notices = await readFile('THIRD_PARTY_NOTICES.md', 'utf8');
const packages = new Set(Object.keys(result.metafile.inputs).filter(p => p.startsWith('node_modules/')).map(p => p.split('/').slice(0, p.split('/')[1].startsWith('@') ? 3 : 2).join('/')));
for (const folder of packages) {
  const dependency = await json(`${folder}/package.json`);
  assert(notices.includes(`## ${dependency.name} ${dependency.version}\n`), `Update third-party notices for ${dependency.name}`);
}
const main = await readFile('main.js', 'utf8');
assert(main.includes(notices.replaceAll('*/', '* /').trim()));
assert(main.includes('MIT License') && !main.includes('sourceMappingURL='));
// A strict allowlist prevents vault indexes, notes, credentials and dependencies from entering release assets.
const files = ['main.js', 'manifest.json', 'styles.css', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md'];
const destination = `release/${manifest.version}`;
await mkdir(destination, { recursive: true });
const hashes = [];
for (const file of files) {
  const bytes = await readFile(file); assert(bytes.length > 0, `Empty file: ${file}`);
  await copyFile(file, `${destination}/${file}`);
  hashes.push(`${createHash('sha256').update(bytes).digest('hex')}  ${file}`);
}
await writeFile(`${destination}/SHA256SUMS.txt`, hashes.join('\n') + '\n');
console.log(`Release checks passed. Tag: ${manifest.version}. Assets: ${destination}/ (upload main.js, manifest.json and styles.css individually).`);
