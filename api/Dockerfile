# Payables API (NestJS + BullMQ workers + chain sync) — one long-running container.
# Build from the repo root:  docker build -f api/Dockerfile -t payables-api .
FROM node:24-slim
WORKDIR /app
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NODE_ENV=production
RUN corepack enable

# Install deps for the api workspace only (scripts skipped; prisma generate runs below with the schema present).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY api/package.json api/
RUN pnpm install --frozen-lockfile --filter api... --ignore-scripts --prod=false

COPY api api
WORKDIR /app/api
RUN DATABASE_URL=postgresql://build:build@localhost:5432/build pnpm exec prisma generate && pnpm build

ENV PORT=4000 LOCAL_STORAGE_DIR=/data/uploads
EXPOSE 4000
# Apply pending migrations, then start the API (HTTP + queue workers + chain sync).
CMD ["sh", "-c", "pnpm exec prisma migrate deploy && node dist/main.js"]
