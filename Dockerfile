# MosBot API - Multi-stage Docker build
# Use Debian slim for better multi-platform (arm64) build compatibility under QEMU
FROM node:25-alpine3.22 AS base

# Install security updates and dumb-init for proper signal handling
RUN apk update && \
    apk upgrade && \
    apk add --no-cache dumb-init && \
    rm -rf /var/cache/apk/*

# App directory (node user already exists in official image)
WORKDIR /app

# Production dependencies stage
FROM base AS dependencies
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && \
    npm cache clean --force

# Development dependencies stage (for future test/build stages)
FROM base AS dev-dependencies
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts && \
    npm cache clean --force

# Development stage (for local development with hot reload)
FROM base AS development

# Set development environment
ENV NODE_ENV=development

WORKDIR /app

# Copy all dependencies (including dev dependencies)
COPY --from=dev-dependencies /app/node_modules ./node_modules

# Copy application source
COPY --chown=node:node . .

# Switch to non-root user
USER node

# Expose port
EXPOSE 3000

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Start with nodemon for hot reload
CMD ["npm", "run", "dev"]

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
