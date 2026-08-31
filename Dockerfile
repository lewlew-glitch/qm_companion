# Pinned multi-architecture base image.
FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf

WORKDIR /app

COPY package.json package-lock.json ./
RUN apk upgrade --no-cache \
    && npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force \
    && rm -rf /usr/local/lib/node_modules/npm \
              /usr/local/lib/node_modules/corepack \
              /usr/local/bin/npm \
              /usr/local/bin/npx \
              /usr/local/bin/corepack \
              /usr/local/bin/yarn \
              /usr/local/bin/yarnpkg \
              /usr/local/bin/pnpm \
              /usr/local/bin/pnpx \
              /opt/yarn-v*

COPY src ./src
COPY LICENSE THIRD_PARTY_NOTICES.md ./
# State validation utility.
COPY scripts/check-state.mjs ./scripts/check-state.mjs

# Runtime state directory.
RUN mkdir -p /data && chown -R node:node /data /app
ENV DATA_DIR=/data

# Run the application as a non-root user.
USER node

EXPOSE 8787

ENTRYPOINT ["node", "src/index.js"]
