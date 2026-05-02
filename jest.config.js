module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { isolatedModules: true }],
  },
  setupFilesAfterEach: [],
  moduleNameMapper: {
    '^hereya-cli$': '<rootDir>/test/stubs/hereya-cli.ts',
  },
};
