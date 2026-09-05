# @xorgate/workflow-engine — the portable engine image. Adapted from
# xorgate-core-service/engine-runner/Dockerfile; the Fargate session/S3 runner
# stayed behind, the entrypoint here is the xwe CLI.
#
# Multi-arch (amd64 + arm64) via buildx:
#   docker buildx build --platform linux/amd64,linux/arm64 -t xwe .
# Single-arch local build:
#   docker build -t xwe .
#
# Run with the workspace (templates/fixtures/output) mounted at /work:
#   docker run --rm -v "$PWD":/work xwe \
#     run fixtures/templates/overspeed.json \
#     --input telemetry=fixtures/telemetry/window.csv --out out
#
# ffmpeg comes from apt (the executors spawn `ffmpeg`; FFMPEG_PATH is only for
# dev machines). onnxruntime-node ships a prebuilt binding for every platform
# and architecture (about 280 MB); the runtime stage keeps only this image's
# (linux/<arch>). No model is baked in: models resolve from the mounted
# workspace via --models-dir, the cache (mount a volume at /root/.xorgate/models),
# or the registry with --pull.
#
# The golden suite inside the image (the checkout mounted at /work, fixtures
# pulled on the host first with `npm run fixtures:pull`); the mounted
# node_modules are the host's, so a named volume shadows them with a Linux
# install on the first run (`--include=dev` because the image sets
# NODE_ENV=production; the suite rebuilds /work/dist with that install):
#   docker run --rm -v "$PWD":/work -v xwe-test-modules:/work/node_modules \
#     --entrypoint sh xwe -c 'npm ci --include=dev && npm test'
FROM node:20-slim AS build

WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.esm.json tsconfig.cjs.json ./
COPY scripts/finalize-build.mjs ./scripts/
COPY src ./src
RUN npm run build

FROM node:20-slim

ENV NODE_ENV=production \
    # onnxruntime is CPU-only here; keep it to the cores the host allots.
    OMP_NUM_THREADS=2

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
# After the install, drop the ONNX Runtime bindings for the other platforms
# (darwin, win32) and the other Linux architecture; the binding that stays is
# the one `node -p process.arch` names. The x64 binding also ships the CUDA
# and TensorRT execution providers (loaded only when a session asks for
# them); this image is CPU-only, so they go too. A build without the optional
# dependency has no bin/ directory and skips the trim.
RUN npm ci --omit=dev && npm cache clean --force \
    && ORT_BIN=node_modules/onnxruntime-node/bin/napi-v6 \
    && if [ -d "$ORT_BIN" ]; then \
         ARCH="$(node -p 'process.arch')" \
         && find "$ORT_BIN" -mindepth 1 -maxdepth 1 -type d ! -name linux -exec rm -rf {} + \
         && find "$ORT_BIN/linux" -mindepth 1 -maxdepth 1 -type d ! -name "$ARCH" -exec rm -rf {} + \
         && find "$ORT_BIN/linux" -type f \( -name 'libonnxruntime_providers_cuda*' -o -name 'libonnxruntime_providers_tensorrt*' \) -delete \
         && echo "onnxruntime-node binding kept:" && du -sh "$ORT_BIN"/*/* && ls "$ORT_BIN"/*/* ; \
       fi
COPY --from=build /build/dist ./dist

# The mounted workspace: relative template/input/output paths resolve here.
WORKDIR /work
ENTRYPOINT ["node", "/app/dist/cjs/cli/index.js"]
CMD ["--help"]
