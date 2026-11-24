# syntax=docker/dockerfile:1

# Stage 1: Build static React + Vite bundle (no build-time API URL baked in)
FROM node:22.14.0-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# Stage 2: Unprivileged Nginx server with runtime /config.js generation (Change #4)
FROM nginxinc/nginx-unprivileged:1.27.4-alpine AS runner

USER root

# Dedicated directory writable by nginx user (UID 101) for runtime config.js
RUN mkdir -p /etc/nginx/runtime && chown -R 101:101 /etc/nginx/runtime

COPY --chown=101:101 --from=builder /app/dist /usr/share/nginx/html
COPY --chown=101:101 nginx.conf /etc/nginx/conf.d/default.conf
COPY --chown=101:101 docker-entrypoint.sh /docker-entrypoint.d/40-runtime-config.sh
RUN chmod +x /docker-entrypoint.d/40-runtime-config.sh

USER 101
EXPOSE 8080

CMD ["nginx", "-g", "daemon off;"]
