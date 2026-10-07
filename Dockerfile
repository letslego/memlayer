FROM node:22-bookworm-slim

RUN corepack enable && corepack prepare pnpm@10.33.3 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json vitest.config.ts ./
COPY src src
COPY examples examples

ENV HOST=0.0.0.0 \
    PORT=43123 \
    DATABASE_PATH=/data/memlayer.sqlite \
    NODE_ENV=production

RUN mkdir -p /data

EXPOSE 43123

CMD ["pnpm", "start"]
