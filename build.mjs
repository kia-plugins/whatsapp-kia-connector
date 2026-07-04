import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: 'dist/index.js',
  // Optional native media deps Baileys lazy-loads; not used by buffer download.
  external: ['sharp', 'jimp', 'link-preview-js', 'audio-decode'],
  logLevel: 'info',
});
console.log('bundled dist/index.js');
