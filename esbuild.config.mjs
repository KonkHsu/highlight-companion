import esbuild from 'esbuild';
import { readFileSync } from 'node:fs';
const production = process.argv[2] === 'production';
const notices = ['LICENSE', 'THIRD_PARTY_NOTICES.md'].map(path => readFileSync(path, 'utf8')).join('\n\n');
const context = await esbuild.context({
  entryPoints: ['src/main.ts'], bundle: true, external: ['obsidian', '@codemirror/*', '@lezer/*'],
  format: 'cjs', target: 'es2018', platform: 'browser', outfile: 'main.js',
  sourcemap: production ? false : 'inline', minify: production, logLevel: 'info',
  banner: { js: `/*!\n${notices.replaceAll('*/', '* /')}\n*/` }
});
if (production) { await context.rebuild(); await context.dispose(); } else await context.watch();
