import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["server/src/**/*.test.ts", "shared/src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "web/**"],
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "html", "lcov"],
      include: ["server/src/**/*.ts", "shared/src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/dist/**", "**/index.ts"],
      reportsDirectory: "coverage",
    },
  },
});
