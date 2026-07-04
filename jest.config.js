module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/__tests__/**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { diagnostics: false }],
    // Baileys ships pure ESM; convert it to CJS for the jest environment
    // (production never uses this path — esbuild bundles Baileys in dist/).
    'node_modules/@whiskeysockets/baileys/.+\\.js$':
      '<rootDir>/jest/esm-cjs-transformer.cjs',
  },
  transformIgnorePatterns: ['node_modules/(?!(@whiskeysockets/baileys)/)'],
};
