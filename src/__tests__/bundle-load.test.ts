/**
 * Two smokes for the bundled dist/index.js:
 *
 *  - `bundleLoadSmoke` (the shared @kiagent/connector-sdk/testing kit):
 *    builds, require()s it in-process, and asserts activate() contributes
 *    the whatsapp source. Standard across all nine connector repos.
 *
 *  - the bare-child-process isolation probe below: whatsapp is the only
 *    connector whose build.mjs carries a genuine `external:` list (sharp,
 *    jimp, link-preview-js, audio-decode — optional native deps Baileys
 *    lazy-loads) — bundleLoadSmoke's in-process require can't prove those
 *    four (or the SDK itself) are actually absent from the runtime path,
 *    because node_modules is reachable from inside this repo. Only a
 *    require() in a bare temp dir with NOTHING else on disk — the exact way
 *    the extension host child loads the entry — proves it. This is the
 *    original test's mechanics (recovered from git history at 668ca00),
 *    kept as a committed guard rather than a one-off manual check.
 */
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { bundleLoadSmoke } from '@kiagent/connector-sdk/testing';

describe('dist bundle loads standalone', () => {
  it('require()s dist/index.js and activate() returns the whatsapp source', async () => {
    await bundleLoadSmoke({
      root: path.join(__dirname, '..', '..'),
      selfId: 'kia.whatsapp',
      sourceIds: ['whatsapp'],
    });
  }, 90_000);

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
