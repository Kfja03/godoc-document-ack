/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  setupFiles: ["<rootDir>/tests/setupEnv.ts"],
  testMatch: ["<rootDir>/tests/**/*.test.ts"],
};
