import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * The path alias, and one exclusion.
 *
 * Until now every test imported relatively or imported types, which are erased
 * before anything has to resolve them — so `@/…` in a value position failed at
 * run time while typechecking fine, which is a confusing way to find out.
 */
export default defineConfig({
  test: {
    /**
     * `test/lambda-handler.test.mjs` is a `node:test` suite, not a vitest one:
     * it boots the real `web/dist` bundle, which needs a build first, so it
     * cannot be part of a command that must run without one. Vitest would
     * otherwise collect it and fail with "no test suite found".
     */
    exclude: ["node_modules/**", "dist/**", ".next/**", "test/**"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
