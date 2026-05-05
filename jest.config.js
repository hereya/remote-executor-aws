module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { isolatedModules: true }],
  },
  // Prefer .ts source files over the .js artifacts that `tsc` writes alongside
  // them. Without this Jest may pick up a stale `.js` from a previous
  // `npm run build`, which leaves test stubs out of sync with their `.ts`
  // sources.
  moduleFileExtensions: ['ts', 'tsx', 'js', 'mjs', 'cjs', 'jsx', 'json', 'node'],
  moduleNameMapper: {
    '^hereya-cli$': '<rootDir>/test/stubs/hereya-cli.ts',
    '^hereya-cli/dist/lib/github-app\\.js$': '<rootDir>/test/stubs/hereya-cli.ts',
  },
};
