"""Export Depth Anything V2 Small (relative or metric outdoor) to the model registry layout.

--variant relative (default) exports depth-anything-v2-small; --variant
metric-outdoor exports depth-anything-v2-metric-outdoor-small (checkpoint
depth-anything/Depth-Anything-V2-Metric-Outdoor-Small-hf, same architecture,
fine-tuned on outdoor driving scenes, output in METRES, postprocess kind
depth-anything-metric).

Produces, under --out/depth/<name>/<version>/:
  model.onnx                torch.onnx export of the HF checkpoint
                            (depth-anything/Depth-Anything-V2-Small-hf),
                            static 518x518, opset 17
  manifest.json             the registry manifest (src/models/registry.ts),
                            including files["model.onnx"].sha256 / sizeBytes
  fixtures/fixture_0.png    deterministic synthetic parity image
  fixtures/expected_0.json  output shape/stats + a 16x16 normalized-map grid
                            for engine-side parity assertion

Preprocessing is data in the manifest: plain resize to 518x518 (letterbox
disabled; the map is stretched over the frame, which is what the TS engine's
box mapping assumes), scale 1/255, ImageNet mean/std. The relative output is
inverse depth (higher = closer), per-frame normalized by the engine; the
metric output is depth in metres, which the engine inverts before the same
normalization and also reads directly for each box's distanceM.

Then: `xwe models check <out>/depth/depth-anything-v2-small/<version>` and
publish with `node scripts/registry-sync.mjs <out> <target>` (see README.md).
Versions are immutable: bump --version instead of overwriting.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np

VARIANTS = {
    "relative": {
        "hf": "depth-anything/Depth-Anything-V2-Small-hf",
        "name": "depth-anything-v2-small",
        "label": "Depth Anything V2 Small",
        "kind": "depth-anything",
    },
    "metric-outdoor": {
        "hf": "depth-anything/Depth-Anything-V2-Metric-Outdoor-Small-hf",
        "name": "depth-anything-v2-metric-outdoor-small",
        "label": "Depth Anything V2 Metric Outdoor Small",
        "kind": "depth-anything-metric",
    },
}
INPUT_SIZE = 518  # 37 * 14: DINOv2 patch size
IMAGENET_MEAN = [0.485, 0.456, 0.406]
IMAGENET_STD = [0.229, 0.224, 0.225]


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def files_block(dest: Path) -> dict:
    """The additive `files` block the engine verifies on pull (`xwe models pull`)."""
    model = dest / "model.onnx"
    return {"model.onnx": {"sha256": sha256_of(model), "sizeBytes": model.stat().st_size}}


def build_manifest(version: int, variant: dict = VARIANTS["relative"]) -> dict:
    """Mirror of modelManifestSchema in src/models/registry.ts (files added after export)."""
    return {
        "manifestVersion": 1,
        "family": "depth",
        "name": variant["name"],
        "version": version,
        "label": variant["label"],
        "backend": "cpu-onnx",
        "input": {
            "width": INPUT_SIZE,
            "height": INPUT_SIZE,
            "layout": "nchw",
            "colorSpace": "rgb",
            "normalize": {"scale": 1.0 / 255.0, "mean": IMAGENET_MEAN, "std": IMAGENET_STD},
            "letterbox": {"enabled": False, "padValue": 114},
        },
        "classNames": [],
        "postprocess": {"kind": variant["kind"]},
        "quantization": "fp32",
    }


def synthetic_fixture(width: int = 640, height: int = 480) -> np.ndarray:
    """Deterministic RGB test card (same recipe as export_yolo.py)."""
    rng = np.random.default_rng(1234)
    img = np.zeros((height, width, 3), dtype=np.uint8)
    img[..., 0] = np.linspace(0, 255, width, dtype=np.uint8)[None, :]
    img[..., 1] = np.linspace(0, 255, height, dtype=np.uint8)[:, None]
    img[..., 2] = 96
    img[80:300, 100:220] = (200, 40, 40)
    img[200:420, 380:560] = (40, 160, 220)
    img += rng.integers(0, 8, img.shape, dtype=np.uint8)
    return img


def preprocess(img: np.ndarray) -> np.ndarray:
    from PIL import Image

    resized = np.asarray(
        Image.fromarray(img).resize((INPUT_SIZE, INPUT_SIZE), Image.BILINEAR), dtype=np.float32
    )
    blob = resized / 255.0
    blob = (blob - np.array(IMAGENET_MEAN, dtype=np.float32)) / np.array(IMAGENET_STD, dtype=np.float32)
    return blob.transpose(2, 0, 1)[None].astype(np.float32)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", type=int, default=1)
    parser.add_argument("--out", type=Path, default=Path("out"))
    parser.add_argument("--variant", choices=sorted(VARIANTS), default="relative")
    args = parser.parse_args()
    variant = VARIANTS[args.variant]

    import torch  # heavy imports, keep local
    from transformers import AutoModelForDepthEstimation

    dest = args.out / "depth" / variant["name"] / str(args.version)
    fixtures = dest / "fixtures"
    fixtures.mkdir(parents=True, exist_ok=True)

    model = AutoModelForDepthEstimation.from_pretrained(variant["hf"])
    model.eval()

    class DepthWrapper(torch.nn.Module):
        """(1, 3, H, W) pixel_values -> (1, H, W) depth map (relative inverse, or metres)."""

        def __init__(self, inner: torch.nn.Module) -> None:
            super().__init__()
            self.inner = inner

        def forward(self, pixel_values: torch.Tensor) -> torch.Tensor:
            return self.inner(pixel_values=pixel_values).predicted_depth

    dummy = torch.zeros(1, 3, INPUT_SIZE, INPUT_SIZE)
    torch.onnx.export(
        DepthWrapper(model),
        (dummy,),
        str(dest / "model.onnx"),
        input_names=["pixel_values"],
        output_names=["predicted_depth"],
        opset_version=17,
        dynamo=False,
    )

    manifest = build_manifest(args.version, variant)
    manifest["files"] = files_block(dest)
    (dest / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")

    # Parity fixture: run the exported ONNX exactly as the manifest describes.
    import onnxruntime as ort
    from PIL import Image

    img = synthetic_fixture()
    Image.fromarray(img).save(fixtures / "fixture_0.png")
    session = ort.InferenceSession(str(dest / "model.onnx"), providers=["CPUExecutionProvider"])
    (output,) = session.run(None, {session.get_inputs()[0].name: preprocess(img)})
    depth = output[0] if output.ndim == 3 else output[0, 0]

    # 16x16 grid of per-frame normalized values: what the TS engine's
    # normalizeDepthMap + downsample sees, tolerant of tiny numeric drift.
    # Metric maps are inverted first, as the engine does (invertMetres: 1 / max(d, 0.1)).
    dmin, dmax = float(depth.min()), float(depth.max())
    rel = 1.0 / np.maximum(depth, 0.1) if variant["kind"] == "depth-anything-metric" else depth
    rmin, rmax = float(rel.min()), float(rel.max())
    norm = (rel - rmin) / (rmax - rmin) if rmax > rmin else np.zeros_like(rel)
    ys = (np.arange(16) * depth.shape[0]) // 16
    xs = (np.arange(16) * depth.shape[1]) // 16
    grid = norm[np.ix_(ys, xs)]
    expected = {
        "outputShape": list(output.shape),
        "outputStats": {
            "min": dmin,
            "max": dmax,
            "mean": float(depth.mean()),
        },
        "normalizedGrid16": [[round(float(v), 4) for v in row] for row in grid],
    }
    (fixtures / "expected_0.json").write_text(json.dumps(expected, indent=2) + "\n")
    print(f"exported depth/{variant['name']} v{args.version} -> {dest} (sha256 {manifest['files']['model.onnx']['sha256'][:12]}...)")
    print(f"next: xwe models check {dest}")


if __name__ == "__main__":
    main()
