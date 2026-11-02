# The control service image: `taa serve` with the console, API and watcher.
#
# Built from the repository root by `deploy/compose.yaml`:
#   podman compose ... up -d      (or make stack-up)
#
# Node 24 runs the TypeScript sources directly, so there is no build step. The
# image installs production dependencies only and keeps the SQLite file on a
# named volume.

FROM docker.io/library/node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY tsconfig.json ./
COPY config ./config
COPY src ./src

RUN mkdir -p /data && chown -R node:node /data /app
USER node

ENV NODE_ENV=production \
    TAA_HOST=0.0.0.0 \
    TAA_PORT=8080 \
    TAA_DB_PATH=/data/taa.db \
    TAA_HINTS_FILE=/app/config/model-hints.json

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "src/cli/index.ts", "serve"]
