# syntax=docker/dockerfile:1

# Stage 1: Install production-only dependencies
FROM node:22.14.0-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Stage 2: Minimal non-root runtime image shared by API, workers, migrate, and init jobs
FROM node:22.14.0-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node scripts ./scripts

USER node
EXPOSE 3000

# Exec form runs node directly as PID 1 so SIGTERM reaches the process cleanly (Change #3)
CMD ["node", "src/server.js"]
