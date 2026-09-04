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
# dev machines). onnxruntime-node installs its prebuilt binding for the build
# platform via npm. No model is baked in: models resolve from the mounted
# workspace (./fixtures/models) or --models-dir.
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
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /build/dist ./dist

# The mounted workspace: relative template/input/output paths resolve here.
WORKDIR /work
ENTRYPOINT ["node", "/app/dist/cjs/cli/index.js"]
CMD ["--help"]
