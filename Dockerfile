# MosBot API - Multi-stage Docker build
FROM node:18-alpine AS base

# Install security updates and dumb-init for proper signal handling
RUN apk update && \
    apk upgrade && \
    apk add --no-cache dumb-init && \
    rm -rf /var/cache/apk/*

# Create app directory and user
WORKDIR /app
RUN addgroup -g 1000 node && \
    adduser -u 1000 -G node -s /bin/sh -D node || true

# Production dependencies stage
FROM base AS dependencies
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production && \
    npm cache clean --force

# Development dependencies stage (for future test/build stages)
FROM base AS dev-dependencies
WORKDIR /app
COPY package*.json ./
RUN npm ci && \
    npm cache clean --force

# Final production stage
FROM base AS production

# Set production environment
ENV NODE_ENV=production

WORKDIR /app

# Copy production dependencies
COPY --from=dependencies /app/node_modules ./node_modules

# Copy application source
COPY --chown=node:node . .

# Switch to non-root user
USER node

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Start the application
CMD ["node", "src/index.js"]
