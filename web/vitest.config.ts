import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Only the path alias.
 *
 * Until now every test imported relatively or imported types, which are erased
 * before anything has to resolve them — so `@/…` in a value position failed at
 * run time while typechecking fine, which is a confusing way to find out.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
