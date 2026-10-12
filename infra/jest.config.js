/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  transform: {
    // `.ts`/`.tsx` tests and the AppSync JS resolvers (plain ESM `.js` under
    // resolvers/) are both transpiled by ts-jest. The resolver test imports the
    // resolver module directly, so `.js` must be transformed too; `allowJs`
    // lives in tsconfig.jest.json so the production `tsc` build (tsconfig.json)
    // is unchanged and never tries to compile the runtime resolvers.
    '^.+\\.(tsx?|js)$': [
      'ts-jest',
      {
        tsconfig: 'tsconfig.jest.json',
      },
    ],
  },
};
