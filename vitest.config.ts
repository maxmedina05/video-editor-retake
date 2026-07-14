import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // web-ui tests cover pure browser-side logic (e.g. the undo reducer);
    // they are excluded from web-ui's tsc build and run here instead.
    include: ["src/**/*.test.ts", "web-ui/src/**/*.test.ts"],
    environment: "node",
  },
});
