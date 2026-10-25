# Pinned multi-architecture base image.
FROM node:24-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53

ARG COMPANION_VERSION
ENV COMPANION_VERSION=${COMPANION_VERSION}

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
