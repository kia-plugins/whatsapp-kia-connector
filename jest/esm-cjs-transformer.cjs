// Jest transformer: converts ESM-only JS (Baileys ships pure ESM) to CommonJS so
// it can be required in the CJS Jest environment. Uses TypeScript's
// transpileModule because typescript is already a project devDependency and
// handles ESM->CJS reliably. getCacheKey folds in the typescript version so the
// cache invalidates on upgrades. (Mirrors the v1 repo's .erb/jest transformer;
// production never uses this path — esbuild bundles Baileys to CJS in dist/.)
const ts = require('typescript');
const crypto = require('crypto');
const tsVersion = require('typescript/package.json').version;

module.exports = {
  process(sourceText, sourcePath) {
    const result = ts.transpileModule(sourceText, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        allowJs: true,
        esModuleInterop: true,
      },
      fileName: sourcePath,
    });
    return { code: result.outputText };
  },

  getCacheKey(sourceText, sourcePath) {
    return crypto
      .createHash('sha1')
      .update(sourceText)
      .update(sourcePath)
      .update(tsVersion)
      .digest('hex');
  },
};
