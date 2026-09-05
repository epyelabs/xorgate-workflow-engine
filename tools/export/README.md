# Model export tools

The first-party way to turn weights into a registry directory the engine can
load: `model.onnx` plus a `manifest.json` that carries the input geometry,
normalization, class names, post-processing parameters and the file checksum
the engine verifies on pull. Python, developer tooling only: nothing in this
directory ships in the npm package or the container image (the `files`
whitelist in `package.json` excludes it, and `npm run verify:tarball` asserts
that).

The produced layout is the registry layout, which is also what a directory
passed as `--models-dir` and what `~/.xorgate/models` hold:

```
<out>/<family>/<name>/<version>/manifest.json
<out>/<family>/<name>/<version>/model.onnx
<out>/<family>/<name>/<version>/fixtures/   (parity fixtures, small, optional)
```

## Setup

```bash
cd tools/export
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

`requirements.txt` pins export-time dependencies only. The YOLO exporter
uses the `ultralytics` package, whose weights and code are AGPL-3.0; read the
license note on the docs' Models page before shipping a product on the
first-party detectors.

## Your own model (bring-your-own)

A YOLOv8 fine-tune keeps the output layout the engine decodes, so exporting
one is the documented path for a private detector. Given training output at
`runs/train/forklift/weights/best.pt` with two classes:

```bash
python tools/export/export_yolo.py \
  --weights runs/train/forklift/weights/best.pt \
  --name acme-forklift --version 1 \
  --out ./models
```

It exports `best.pt` to `model.onnx` at the training image size (override
with `--imgsz`), reads the class names from the weights in class-index order,
detects a segmentation model from the weights' task, and writes the manifest
next to it, including `files["model.onnx"].sha256` and `sizeBytes`:

```json
{
  "manifestVersion": 1,
  "family": "detection",
  "name": "acme-forklift",
  "version": 1,
  "label": "acme-forklift",
  "backend": "cpu-onnx",
  "input": {
    "width": 640,
    "height": 640,
    "layout": "nchw",
    "colorSpace": "rgb",
    "normalize": { "scale": 0.00392156862745098 },
    "letterbox": { "enabled": true, "padValue": 114 }
  },
  "classNames": ["forklift", "pallet"],
  "postprocess": { "kind": "yolov8", "nmsIouThreshold": 0.45 },
  "quantization": "fp32",
  "files": {
    "model.onnx": { "sha256": "9f2c…", "sizeBytes": 12212736 }
  }
}
```

`--label "Forklift detector (site A, 2026-09)"` sets the human name pickers
show. Then check the directory, name the model in a template, and run:

```bash
xwe models check ./models/detection/acme-forklift/1
xwe run forklift.json --input video=yard.mp4 --models-dir ./models --out out
```

`check` loads the model through ONNX Runtime, runs one blank letterboxed
frame and asserts the output shape matches `4 + classNames.length` rows for
`yolov8`, so a class-count mismatch fails there rather than mid-run. If you
exported another way (`yolo export format=onnx`, or a framework's exporter),
write the manifest by hand in the shape above and run `check`: it fills in
`files.sha256` and `sizeBytes` when they are missing.

## First-party models

```bash
# yolov8n at registry version 1 -> ./out/detection/yolov8n/1/
python export_yolo.py --name yolov8n --version 1 --out ./out

# instance segmentation (family segmentation, postprocess yolov8-seg)
python export_yolo.py --name yolov8n-seg --version 1 --out ./out

# Depth Anything V2 Small (family depth)
python export_depth.py --version 1 --out ./out
```

Registry names for the catalog defaults: `yolov8n` (default), `yolov8s`,
`rtdetr` for family `detection`; `yolov8n-seg` for family `segmentation`;
`depth-anything-v2-small` for family `depth`. The engine implements the
`yolov8`, `yolov8-seg` and `depth-anything` decoders; an `rtdetr` manifest is
accepted by the schema and refused by the node until its decoder lands.

## Publishing

A registry is a static file server in the layout with an `index.json` (an
array of the manifests) at the root. `scripts/registry-sync.mjs` validates
every manifest (identity matches its path, `files.sha256` matches the file),
copies the version directories and writes the index:

```bash
node scripts/registry-sync.mjs ./out ./registry-mirror          # a directory (serve it with `npx serve`)
node scripts/registry-sync.mjs ./out s3://<bucket>[/<prefix>]    # the public registry, owner only
```

Versions are immutable: publish a new `--version` instead of overwriting.
Consumers pull with `xwe models pull <family>/<name>[@<version>]` against
`XWE_MODEL_REGISTRY`.

## Parity fixtures

Both scripts render a deterministic synthetic image, run the exported ONNX
over it with the same letterbox and normalization the manifest declares, and
write `fixtures/fixture_0.png` + `fixtures/expected_0.json` (raw output stats
plus decoded rows) next to the model. They are small, immutable, and travel
with the version; engine-side parity assertions against them are a later
milestone.

## Provenance

These scripts were copied from the platform's `model-export/` pipeline and
extended with `--weights`, `--label`, `--imgsz` and the `files` block. The
platform side stays the writer of the platform registry; this copy is the
writer for developers' own models and for the public registry mirror.
