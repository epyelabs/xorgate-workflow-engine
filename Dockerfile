# xorgate-workflow-engine — portable engine image. Adapted from
# xorgate-core-service/engine-runner/Dockerfile (path fixes only; the source
# built the whole service src/ tree via engine-runner/tsconfig.json and ran the
# Fargate session/S3 runner, which stays behind).
#
#   docker build --platform linux/arm64 .
#
# Multi-arch (amd64 + arm64 via buildx) comes with the M4 milestone, as does
# the real entrypoint (the xwe CLI, M3). Until then CMD runs the smoke script.
#
# ffmpeg comes from apt (the executors spawn `ffmpeg`; FFMPEG_PATH is only for
# dev machines). onnxruntime-node installs its prebuilt binding via npm. No
# model is baked in.
FROM --platform=linux/arm64 node:20-slim AS build

WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json

FROM --platform=linux/arm64 node:20-slim

ENV NODE_ENV=production \
    # onnxruntime is CPU-only here; keep it to the vCPUs the host is sized for.
    OMP_NUM_THREADS=2

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /build/dist ./dist
COPY scripts ./scripts

# Placeholder entrypoint until the xwe CLI lands (M3).
CMD ["node", "scripts/smoke.mjs"]
