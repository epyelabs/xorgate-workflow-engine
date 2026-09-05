"""Export a YOLOv8 detection or segmentation model to the model registry layout.

Produces, under --out/<family>/<name>/<version>/:
  model.onnx                exported with ultralytics (opset 12, static NxN)
  manifest.json             the registry manifest (src/models/registry.ts),
                            including files["model.onnx"].sha256 / sizeBytes
  fixtures/fixture_0.png    deterministic synthetic parity image
  fixtures/expected_0.json  raw-output stats (+ top head rows) for engine CI

Two ways to name the weights:

  --name yolov8n                       a first-party model (downloaded by ultralytics)
  --weights runs/train/x/best.pt       your own fine-tune; --name is then the
                                       registry name you choose, class names
                                       and the training image size are read
                                       from the weights

Segmentation models publish under family "segmentation" with postprocess kind
"yolov8-seg" (detection head + prototype masks; the engine decoder is
src/engine/vision.ts postprocessYoloV8Seg). The task is read from the weights
when --weights is given, else from the -seg name suffix.

Then: `xwe models check <out>/<family>/<name>/<version>` and publish with
`node scripts/registry-sync.mjs <out> <target>` (see README.md). Versions are
immutable: bump --version instead of overwriting.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np

DEFAULT_INPUT_SIZE = 640
NMS_IOU = 0.45
INPUT_SIZE = DEFAULT_INPUT_SIZE  # set from --imgsz / the weights in main()

# ultralytics model ids for the pinned registry names.
ULTRALYTICS_IDS = {
    "yolov8n": "yolov8n.pt",
    "yolov8s": "yolov8s.pt",
    "yolov8n-seg": "yolov8n-seg.pt",
    "rtdetr": "rtdetr-l.pt",
}


def family_for(name: str, segment: bool | None = None) -> str:
    seg = name.endswith("-seg") if segment is None else segment
    return "segmentation" if seg else "detection"


def postprocess_for(name: str, segment: bool | None = None) -> dict:
    seg = name.endswith("-seg") if segment is None else segment
    if seg:
        return {"kind": "yolov8-seg", "nmsIouThreshold": NMS_IOU, "maskThreshold": 0.5}
    if name == "rtdetr":
        return {"kind": "rtdetr", "nmsIouThreshold": NMS_IOU}
    return {"kind": "yolov8", "nmsIouThreshold": NMS_IOU}


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


def build_manifest(
    name: str,
    version: int,
    class_names: list[str],
    *,
    label: str | None = None,
    segment: bool | None = None,
) -> dict:
    """Mirror of modelManifestSchema in src/models/registry.ts (files added after export)."""
    return {
        "manifestVersion": 1,
        "family": family_for(name, segment),
        "name": name,
        "version": version,
        "label": label or name,
        "backend": "cpu-onnx",
        "input": {
            "width": INPUT_SIZE,
            "height": INPUT_SIZE,
            "layout": "nchw",
            "colorSpace": "rgb",
            "normalize": {"scale": 1.0 / 255.0},
            "letterbox": {"enabled": True, "padValue": 114},
        },
        "classNames": class_names,
        "postprocess": postprocess_for(name, segment),
        "quantization": "fp32",
    }


def synthetic_fixture(width: int = 640, height: int = 480) -> np.ndarray:
    """Deterministic RGB test card: gradient background + solid shapes."""
    rng = np.random.default_rng(1234)
    img = np.zeros((height, width, 3), dtype=np.uint8)
    img[..., 0] = np.linspace(0, 255, width, dtype=np.uint8)[None, :]
    img[..., 1] = np.linspace(0, 255, height, dtype=np.uint8)[:, None]
    img[..., 2] = 96
    img[80:300, 100:220] = (200, 40, 40)
    img[200:420, 380:560] = (40, 160, 220)
    img += rng.integers(0, 8, img.shape, dtype=np.uint8)
    return img


def letterbox(img: np.ndarray) -> tuple[np.ndarray, float, float, float]:
    from PIL import Image

    h, w = img.shape[:2]
    scale = min(INPUT_SIZE / w, INPUT_SIZE / h)
    nw, nh = round(w * scale), round(h * scale)
    resized = np.asarray(Image.fromarray(img).resize((nw, nh), Image.BILINEAR))
    canvas = np.full((INPUT_SIZE, INPUT_SIZE, 3), 114, dtype=np.uint8)
    pad_x, pad_y = (INPUT_SIZE - nw) // 2, (INPUT_SIZE - nh) // 2
    canvas[pad_y : pad_y + nh, pad_x : pad_x + nw] = resized
    blob = (canvas.astype(np.float32) / 255.0).transpose(2, 0, 1)[None]
    return blob, scale, float(pad_x), float(pad_y)


def main() -> None:
    global INPUT_SIZE
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--weights",
        type=Path,
        help="your own .pt weights (a fine-tune); class names and image size come from the file",
    )
    parser.add_argument(
        "--name",
        default=None,
        help=f"registry name; one of {sorted(ULTRALYTICS_IDS)} without --weights (default yolov8n), any name with it",
    )
    parser.add_argument("--version", type=int, default=1)
    parser.add_argument("--label", help="human name pickers show (default: the name)")
    parser.add_argument("--imgsz", type=int, help="export image size (default: the training size from the weights, else 640)")
    parser.add_argument("--out", type=Path, default=Path("out"))
    args = parser.parse_args()

    if args.weights is None:
        name = args.name or "yolov8n"
        if name not in ULTRALYTICS_IDS:
            parser.error(f"--name must be one of {sorted(ULTRALYTICS_IDS)} unless --weights is given")
        source = ULTRALYTICS_IDS[name]
    else:
        if not args.weights.is_file():
            parser.error(f"--weights {args.weights}: not a file")
        if not args.name:
            parser.error("--weights needs --name <registry-name> (for example acme-forklift)")
        name = args.name
        source = str(args.weights)

    from ultralytics import YOLO  # heavy import, keep local

    model = YOLO(source)
    task = getattr(model, "task", None)
    segment = task == "segment" if task in ("detect", "segment") else None
    trained_size = None
    try:
        trained_size = int((getattr(model.model, "args", None) or {}).get("imgsz") or 0) or None
    except (TypeError, ValueError, AttributeError):
        trained_size = None
    if isinstance(trained_size, (list, tuple)):
        trained_size = int(trained_size[0])
    INPUT_SIZE = args.imgsz or trained_size or DEFAULT_INPUT_SIZE

    dest = args.out / family_for(name, segment) / name / str(args.version)
    fixtures = dest / "fixtures"
    fixtures.mkdir(parents=True, exist_ok=True)

    class_names = [model.names[i] for i in sorted(model.names)]
    onnx_path = model.export(format="onnx", imgsz=INPUT_SIZE, opset=12, simplify=True)
    Path(onnx_path).replace(dest / "model.onnx")

    manifest = build_manifest(name, args.version, class_names, label=args.label, segment=segment)
    manifest["files"] = files_block(dest)
    (dest / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")

    # Parity fixture: run the exported ONNX exactly as the manifest describes.
    import onnxruntime as ort
    from PIL import Image

    img = synthetic_fixture()
    Image.fromarray(img).save(fixtures / "fixture_0.png")
    blob, scale, pad_x, pad_y = letterbox(img)
    session = ort.InferenceSession(str(dest / "model.onnx"), providers=["CPUExecutionProvider"])
    outputs = session.run(None, {session.get_inputs()[0].name: blob})
    # Detection exports one output; -seg exports the head + prototype masks.
    head = next(o for o in outputs if o.ndim == 3)

    n_classes = len(class_names)
    preds = head[0].T  # (N, 4 + classes [+ mask coeffs])
    confs = preds[:, 4 : 4 + n_classes].max(axis=1)
    top = preds[confs.argsort()[::-1][:10]]
    expected = {
        "input": {"scale": scale, "padX": pad_x, "padY": pad_y},
        "outputShape": list(head.shape),
        "outputStats": {
            "mean": float(head.mean()),
            "max": float(head.max()),
            "maxClassScore": float(confs.max()),
        },
        # Raw top rows (letterboxed pixels) so the TS decode can be asserted
        # end to end without re-running inference in CI.
        "topRows": [[float(v) for v in row] for row in top],
    }
    proto = next((o for o in outputs if o.ndim == 4), None)
    if proto is not None:
        expected["protoShape"] = list(proto.shape)
        expected["protoStats"] = {"mean": float(proto.mean()), "max": float(proto.max())}
    (fixtures / "expected_0.json").write_text(json.dumps(expected, indent=2) + "\n")
    print(
        f"exported {manifest['family']}/{name} v{args.version} -> {dest} "
        f"({len(class_names)} classes, {INPUT_SIZE}x{INPUT_SIZE}, sha256 {manifest['files']['model.onnx']['sha256'][:12]}...)"
    )
    print(f"next: xwe models check {dest}")


if __name__ == "__main__":
    main()
