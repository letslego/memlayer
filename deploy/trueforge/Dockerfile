# Standalone TrueForge from the published build of
# https://github.com/truefoundry/trueforge (npm @truefoundry/trueforge@0.3.1).
# The upstream docker-compose.yml builds the whole pnpm workspace (UI, Postgres,
# Redis, controller). This image is the local-mode server: SQLite, no login.
# `ai@7.0.130` is the range tip and its npm tarball 404s, so the override
# installs 7.0.129, which is still inside trueforge-core's ^7 range.
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/trueforge

COPY package.json ./
RUN npm install --omit=dev

ENV HOST=0.0.0.0 \
    PORT=8791 \
    STANDALONE=true \
    NODE_ENV=production \
    SQLITE_PATH=/data/trueforge.sqlite \
    PATH="/opt/trueforge/node_modules/.bin:${PATH}"

RUN mkdir -p /data

EXPOSE 8791

CMD ["trueforge"]
