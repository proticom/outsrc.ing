import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 20_000,
    // Polls wait on spawned wrapper and engine processes; the 1s default flakes on loaded CI runners.
    expect: { poll: { timeout: 10_000 } },
  },
});
