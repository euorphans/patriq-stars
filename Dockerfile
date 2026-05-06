# ============================================
# Stage 1: Install dependencies
# ============================================
FROM node:20-slim AS deps

WORKDIR /app

COPY package.json package-lock.json* yarn.lock* bun.lockb* ./
COPY prisma ./prisma/

# Install dependencies (npm fallback if no lock file found)
RUN if [ -f "bun.lockb" ]; then \
      npm install -g bun && bun install --frozen-lockfile; \
    elif [ -f "yarn.lock" ]; then \
      yarn install --frozen-lockfile; \
    elif [ -f "package-lock.json" ]; then \
      npm ci; \
    else \
      npm install; \
    fi

# Generate Prisma client
RUN npx prisma generate

# ============================================
# Stage 2: Build the application
# ============================================
FROM node:20-slim AS builder

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN npm run build

# ============================================
# Stage 3: Production image
# ============================================
FROM node:20-slim AS production

RUN apt-get update && apt-get install -y --no-install-recommends \
    dumb-init openssl fontconfig fonts-dejavu-core \
    chromium fonts-liberation \
    && rm -rf /var/lib/apt/lists/* && fc-cache -f

ENV CHROMIUM_PATH=/usr/bin/chromium

WORKDIR /app

ENV NODE_ENV=production

# Create non-root user
RUN groupadd -g 1001 appgroup && \
    useradd -u 1001 -g appgroup -m appuser

# Copy only what's needed for production (--chown avoids slow separate chown layer)
COPY --from=deps --chown=appuser:appgroup /app/node_modules ./node_modules
COPY --from=builder --chown=appuser:appgroup /app/dist ./dist
COPY --from=builder --chown=appuser:appgroup /app/prisma ./prisma
COPY --from=builder --chown=appuser:appgroup /app/images ./images
COPY --from=builder --chown=appuser:appgroup /app/package.json ./
COPY --chown=appuser:appgroup scripts ./scripts
COPY --chown=appuser:appgroup fragment-assets ./fragment-assets

USER appuser

EXPOSE 3001

# Use dumb-init as PID 1 for proper signal handling
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main.js"]
