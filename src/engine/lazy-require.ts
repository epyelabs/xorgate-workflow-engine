import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

/**
 * The one `require` the package keeps: optional and native packages
 * (onnxruntime-node, the VLM provider client, ffmpeg-static on dev machines)
 * are loaded lazily at executor run time so importing the catalog or the
 * library never touches them. Both builds share this file:
 *
 * - the CJS build has `require` in scope and uses it directly;
 * - the ESM build has no `require`; scripts/finalize-build.mjs rewrites the
 *   placeholder below to `import.meta.url` in dist/esm only, because the
 *   token `import.meta` may not appear in a file that also compiles as
 *   CommonJS. `createRequire` then resolves packages exactly as the CJS
 *   build would, from this file's own location.
 */

const ESM_MODULE_URL = '__XWE_ESM_MODULE_URL__';

let cached: NodeJS.Require | undefined;

function moduleRequire(): NodeJS.Require {
  if (cached) return cached;
  if (ESM_MODULE_URL.startsWith('file:')) {
    // The finalized ESM build: resolve from this file's own location. Checked
    // first because a global `require` can exist around an ES module too
    // (`node -e`, the REPL, some bundlers) and it resolves from the wrong place.
    cached = createRequire(ESM_MODULE_URL);
  } else if (typeof require === 'function') {
    cached = require;
  } else {
    throw new Error(
      'lazyRequire: this ESM build was not finalized (run `npm run build`, which applies scripts/finalize-build.mjs)',
    );
  }
  return cached;
}

/** `require(specifier)` in either module format. Throws like `require` does. */
export function lazyRequire<T = unknown>(specifier: string): T {
  return moduleRequire()(specifier) as T;
}

/** Whether `specifier` resolves from here, without loading it. */
export function canResolve(specifier: string): boolean {
  try {
    moduleRequire().resolve(specifier);
    return true;
  } catch {
    return false;
  }
}

/**
 * The installed version of a package, or null when it is not installed.
 * Packages with an `exports` map (the VLM client) block `<pkg>/package.json`,
 * so fall back to walking up from the resolved entry file.
 */
export function installedVersion(pkg: string): string | null {
  const req = moduleRequire();
  try {
    return (req(`${pkg}/package.json`) as { version: string }).version;
  } catch {
    // fall through to the walk
  }
  let entry: string;
  try {
    entry = req.resolve(pkg);
  } catch {
    return null;
  }
  let dir = dirname(entry);
  for (let i = 0; i < 12; i++) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string; version?: string };
        if (parsed.name === pkg && parsed.version) return parsed.version;
      } catch {
        // keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * This package's own version. Both builds place this file at
 * dist/<format>/engine/lazy-require.js, three levels under the package root.
 */
export function ownPackageVersion(): string {
  return (moduleRequire()('../../../package.json') as { version: string }).version;
}
