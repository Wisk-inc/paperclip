import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // The build copies compiled tests into dist; running them too doubled
    // every failure and failed on fixtures that aren't copied.
    exclude: [...configDefaults.exclude, "dist/**"],
  },
});
