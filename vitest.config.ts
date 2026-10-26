import { fileURLToPath } from "node:url";

import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    // Agent worktrees under .claude hold whole copies of the repository.
    exclude: [...configDefaults.exclude, ".claude/**"],
    reporters: ["tree"],
  },
});
