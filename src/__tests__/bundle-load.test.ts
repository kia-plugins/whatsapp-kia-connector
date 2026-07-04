/**
 * Smoke test for the bundled dist/index.js: builds it, then require()s the
 * copied bundle in a BARE child process (zero node_modules reachable) — the
 * exact way the extension host child loads the entry. Proves the CJS/ESM
 * dual export in src/index.ts survives esbuild, Baileys is fully bundled,
 * and the four externalized optional native deps are never needed on the
 * activate path.
 */
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('dist bundle loads standalone', () => {
  it('activate() returns the whatsapp source with no node_modules reachable', () => {
    const root = path.join(__dirname, '..', '..');
    execSync('npm run build', { cwd: root });
    const dist = path.join(root, 'dist', 'index.js');
    expect(fs.existsSync(dist)).toBe(true);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-iso-'));
    fs.copyFileSync(dist, path.join(dir, 'index.js'));
    const probe = path.join(dir, 'probe.js');
    fs.writeFileSync(
      probe,
      `const m = require('./index.js');
       const mod = m.default ?? m;
       if (typeof mod.activate !== 'function') throw new Error('no activate');
       const host = {
         self: { id: 'kia.whatsapp', dataDir: '${dir.replace(/\\/g, '\\\\')}' },
         log: () => {},
         net: { fetch: async () => { throw new Error('unused'); } },
         query: { byExternalId: async () => null },
       };
       mod.activate(host).then((r) => {
         const src = r.sources && r.sources[0];
         if (!src || src.descriptor.id !== 'whatsapp') throw new Error('no whatsapp source');
         if (src.descriptor.auth !== 'pairing') throw new Error('descriptor drift');
         if (typeof src.toDocument !== 'function') throw new Error('no toDocument');
         console.log('OK');
       }).catch((e) => { console.error(e); process.exit(1); });`,
    );
    const out = execFileSync('node', [probe], { cwd: dir, encoding: 'utf8' });
    expect(out.trim()).toBe('OK');
  }, 90_000);
});
