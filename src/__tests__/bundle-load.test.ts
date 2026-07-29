/**
 * Smoke test for the bundled dist/index.js: builds it, then require()s it
 * (Node's module cache is keyed by resolved path — one smoke per process) via
 * the shared @kiagent/connector-sdk/testing kit. Proves the CJS/ESM dual
 * export in src/index.ts (`export default mod; module.exports = mod;`)
 * survives esbuild and that activate() contributes the whatsapp source.
 */
import { join } from 'node:path';

import { bundleLoadSmoke } from '@kiagent/connector-sdk/testing';

describe('dist bundle loads standalone', () => {
  it('require()s dist/index.js and activate() returns the whatsapp source', async () => {
    await bundleLoadSmoke({
      root: join(__dirname, '..', '..'),
      selfId: 'kia.whatsapp',
      sourceIds: ['whatsapp'],
    });
  }, 90_000);
});
