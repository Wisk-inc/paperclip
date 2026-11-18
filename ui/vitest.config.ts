import path from "path";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      lexical: path.resolve(__dirname, "./node_modules/lexical/dist/Lexical.mjs"),
    },
  },
  test: {
    environment: "node",
    css: { include: [/motion-tokens\.css/] },
    setupFiles: ["./vitest.setup.ts"],
    // scripts/ holds the string extractor's tests, written for Node's own runner (pnpm
    // test:extract-ui-strings, and the PR workflow runs them with node --test). Vitest finds no
    // suite in them and would fail the board's whole run.
    exclude: [...configDefaults.exclude, "scripts/**"],
  },
});
