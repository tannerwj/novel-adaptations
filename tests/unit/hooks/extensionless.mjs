// tests/unit/hooks/extensionless.mjs — ESM resolve hook for node type-stripped
// tests: resolves extensionless relative imports ('./tmdb' → './tmdb.ts'),
// which TypeScript's bundler resolution (and wrangler) allow but node does
// not. Registered via node:module register() before importing src/*.ts.
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (e) {
    if (e?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) {
      const base = path.resolve(
        path.dirname(fileURLToPath(context.parentURL)),
        specifier,
      );
      for (const ext of ['.ts', '.tsx', '.js', '.mjs']) {
        if (existsSync(base + ext)) {
          return { url: pathToFileURL(base + ext).href, shortCircuit: true };
        }
      }
    }
    throw e;
  }
}
