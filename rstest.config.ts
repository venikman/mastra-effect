import { defineConfig } from "@rstest/core";

export default defineConfig({
  testEnvironment: "node",
  testMatch: ["test/**/*.test.ts"],
  testTimeout: 30_000,
});
