# The Claude Agent SDK ships a ~200MB platform-specific binary through
# optionalDependencies, and better-sqlite3 compiles native code. Both mean
# dependencies must be installed inside the image, never copied from a Mac.
FROM node:22-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# The SDK extracts and runs its bundled CLI; it needs a writable HOME.
ENV HOME=/app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public

# Mounted Railway volume. DB_PATH points here so the mirror survives deploys.
ENV DB_PATH=/data/canvas.db
VOLUME ["/data"]

EXPOSE 3000
CMD ["node", "src/server.js"]
