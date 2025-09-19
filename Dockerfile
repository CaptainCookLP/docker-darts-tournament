# syntax=docker/dockerfile:1

##########
# Stage 1: Dependencies bauen (inkl. native Addons wie better-sqlite3)
##########
FROM node:20-bookworm-slim AS deps
WORKDIR /app

# Build-Tools für native Node-Addons
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates openssl \
 && rm -rf /var/lib/apt/lists/*

# Nur package-Dateien kopieren, um Layer-Caching zu nutzen
COPY package*.json ./

# Install: wenn lockfile vorhanden -> npm ci, sonst npm install
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev; \
    else \
      npm install --omit=dev; \
    fi

##########
# Stage 2: Runtime (schlank, ohne Build-Tools)
##########
FROM node:20-bookworm-slim AS runner
ENV NODE_ENV=production
WORKDIR /app

# Runtime-Env Defaults (kannst du via .env / compose überschreiben)
ENV PORT=8080 \
    DB_PATH=/data/tournament.sqlite \
    CORS_ORIGINS=* \
    TLS_ENABLED=false \
    TLS_KEY_FILE=/certs/privkey.pem \
    TLS_CERT_FILE=/certs/fullchain.pem

# Nur die zur Laufzeit nötigen Artefakte kopieren
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY src ./src
COPY public ./public

# Daten- & Zert-Pfade anlegen (werden i. d. R. gemountet)
RUN mkdir -p /data /certs && chown -R node:node /app /data /certs

USER node
EXPOSE 8080

# Healthcheck ohne curl/wget
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "require('http').get('http://localhost:'+(process.env.PORT||8080),r=>process.exit(r.statusCode<400?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "src/index.js"]
