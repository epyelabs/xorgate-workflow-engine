// The example node pack: one node, `acme.scale`. A pack is a versioned list
// of node modules; the engine (or `xwe --pack ./examples/packs/acme-scale`)
// reads the `pack` export or the default export.
//
// This directory has no package.json on purpose: inside the engine
// repository the import of "@xorgate/workflow-engine" resolves to the
// checkout itself (Node's package self-reference), so the example runs
// against the local build. A published pack adds a package.json naming the
// engine as a peer dependency; see README.md.
import * as scale from './nodes/scale.js';

export const pack = {
  name: '@acme/xwe-nodes-scale',
  version: '1.0.0',
  nodes: [scale],
};

export default pack;
