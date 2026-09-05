import { createRequire } from 'node:module';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { NodePack } from '../catalog/pack';
import { XweUsageError } from '../create-engine';
import { displayPath } from '../local/paths';

/**
 * `--pack <module>` (cli.mdx, extending.mdx "Loading packs"): a module
 * specifier resolved from the working directory the way `require` would
 * (an npm package name, or a relative path to a file or directory), whose
 * `pack` export or default export is the pack. CommonJS and ES modules both
 * load: `require` first, and when Node refuses to `require` an ES module
 * (versions before 20.19 / 22.12) a dynamic `import` of the resolved file.
 */

export interface LoadedPack {
  pack: NodePack;
  /** The resolved module file. */
  file: string;
}

function looksLikePack(value: unknown): value is NodePack {
  const v = value as { name?: unknown; version?: unknown; nodes?: unknown } | null;
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof v.name === 'string' &&
    typeof v.version === 'string' &&
    Array.isArray(v.nodes)
  );
}

/** `pack` export, then the default export (or its `pack`), then the module itself. */
function pickPack(mod: unknown): NodePack | undefined {
  const m = mod as { pack?: unknown; default?: { pack?: unknown } } | null;
  const candidates: unknown[] = [m?.pack, m?.default?.pack, m?.default, m];
  return candidates.find(looksLikePack);
}

// tsc compiles `import()` to `require()` in the CommonJS build; a real
// dynamic import is needed for an ES module, and `Function` hides it from tsc.
const dynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<unknown>;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function loadPack(spec: string, cwd = process.cwd()): Promise<LoadedPack> {
  const req = createRequire(path.join(cwd, '__xwe_pack_resolve__.js'));
  let file: string;
  try {
    file = req.resolve(spec);
  } catch (err) {
    throw new XweUsageError(`--pack ${spec}: cannot resolve it from ${cwd} (${errorMessage(err)})`, { cause: err });
  }
  let mod: unknown;
  try {
    mod = req(file);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ERR_REQUIRE_ESM' || code === 'ERR_REQUIRE_ASYNC_MODULE') {
      try {
        mod = await dynamicImport(pathToFileURL(file).href);
      } catch (importErr) {
        throw new XweUsageError(`--pack ${spec}: ${errorMessage(importErr)}`, { cause: importErr });
      }
    } else {
      throw new XweUsageError(`--pack ${spec}: ${errorMessage(err)}`, { cause: err });
    }
  }
  const pack = pickPack(mod);
  if (!pack) {
    throw new XweUsageError(
      `--pack ${spec}: ${displayPath(file, cwd)} exports no pack (export \`pack\`, or a default export, shaped { name, version, nodes })`,
    );
  }
  return { pack, file };
}

/** Loads every `--pack` in order; a `[xwe] pack ...` line per pack through `log`. */
export async function loadPacks(
  specs: string[],
  opts: { cwd?: string; log?: (line: string) => void } = {},
): Promise<NodePack[]> {
  const cwd = opts.cwd ?? process.cwd();
  const packs: NodePack[] = [];
  for (const spec of specs) {
    const { pack, file } = await loadPack(spec, cwd);
    opts.log?.(
      `[xwe] pack ${pack.name} v${pack.version} (${pack.nodes.length} node${pack.nodes.length === 1 ? '' : 's'}) <- ${displayPath(file, cwd)}`,
    );
    packs.push(pack);
  }
  return packs;
}
