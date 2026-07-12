import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * The source uses NodeNext-style `.js` import specifiers that actually point at
 * `.ts` files. Map them back to `.ts` so tests can import source directly
 * without a build step. (Stress tests still run against the compiled dist.)
 */
function jsToTs() {
  return {
    name: "js-to-ts",
    enforce: "pre" as const,
    resolveId(source: string, importer: string | undefined) {
      if (importer && source.startsWith(".") && source.endsWith(".js")) {
        const candidate = resolve(dirname(importer), source.slice(0, -3) + ".ts");
        if (existsSync(candidate)) return candidate;
      }
      return null;
    },
  };
}

export default defineConfig({
  plugins: [jsToTs()],
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    pool: "forks",
    root: fileURLToPath(new URL(".", import.meta.url)),
  },
});
