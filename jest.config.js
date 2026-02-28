/** @type {import('jest').Config} */
module.exports = {
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  // Coverage thresholds - raise toward 100% as coverage improves.
  // Uncomment to enforce on PRs:
  // coverageThreshold: { global: { statements: 100, branches: 100, functions: 100, lines: 100 } },
};
