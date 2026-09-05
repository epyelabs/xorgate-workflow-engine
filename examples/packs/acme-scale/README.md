# Example node pack: `@acme/xwe-nodes-scale`

The pack from the docs page [Extending the catalog](https://docs.xorgate.io/docs/workflows/extending):
one node, `acme.scale`, that multiplies a telemetry signal by a constant.

```
index.js                 the pack: { name, version, nodes: [scale] }, as `pack` and as the default export
nodes/scale.js           the node: `def` (defineNode) and `executor` (an async generator)
overspeed-scaled.json    the overspeed template with a Scale node between the derivative and the threshold
```

## Run it from the checkout

```bash
npm run build
npx xwe validate examples/packs/acme-scale/overspeed-scaled.json --pack ./examples/packs/acme-scale
npx xwe run examples/packs/acme-scale/overspeed-scaled.json --pack ./examples/packs/acme-scale \
  --input telemetry=fixtures/telemetry/window.csv --out out
```

`--pack` takes what `require` takes, resolved from the working directory: a
package name or a path to a file or directory. The scaled graph multiplies the
derived speed by 0.05, so the threshold that fires once on the unscaled
overspeed graph never fires here (`true on 0/149 samples`, 0 events). The
golden suite (`npm test`) runs exactly this and asserts the flip.

From the library:

```js
import { createEngine } from '@xorgate/workflow-engine'
import { localHost } from '@xorgate/workflow-engine/local'
import { pack } from './examples/packs/acme-scale/index.js'

const engine = createEngine({ host: localHost({ outDir: 'out' }), packs: [pack] })
const run = await engine.run({
  template: 'examples/packs/acme-scale/overspeed-scaled.json',
  inputs: { telemetry: 'fixtures/telemetry/window.csv' },
})
```

## Why there is no package.json here

Inside the engine repository the `import ... from '@xorgate/workflow-engine'`
in `nodes/scale.js` resolves to the checkout itself through Node's package
self-reference, which works only while the nearest `package.json` is the
engine's own. A pack you publish is an ordinary npm package:

```json
{
  "name": "@acme/xwe-nodes-scale",
  "version": "1.0.0",
  "type": "module",
  "exports": "./index.js",
  "peerDependencies": { "@xorgate/workflow-engine": "^0.1.0" },
  "dependencies": { "zod": "^3.24.0" }
}
```

The engine is a peer dependency so there is one engine in the process. Both
module formats load: the `xwe` command is CommonJS and loads this ES module
pack through `require` (Node 20.19+ and 22.12+) or a dynamic `import` on
older versions; the library works the same way in either direction.

## What the catalog says

With this pack registered the catalog payload lists two packs. The `core`
entry keeps the core hash whatever else is registered; `catalogVersion` hashes
every node:

```json
{
  "catalogVersion": "5c3e079fc2e7f9e8",
  "packs": [
    { "name": "core", "version": "0.1.0-dev", "hash": "e481243f5ffe4678" },
    { "name": "@acme/xwe-nodes-scale", "version": "1.0.0", "hash": "1b1102fe3076cd96" }
  ]
}
```
