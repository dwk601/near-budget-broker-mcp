FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
# Stable OS-account home is on the SAME private volume as the data; key-scoped
# SQLite locks remain writable with a read-only rootfs (no /tmp key locks).
RUN mkdir -p /var/lib/budget-broker && chown node:node /var/lib/budget-broker \
    && usermod --home /var/lib/budget-broker node
ENV HOME=/var/lib/budget-broker
USER node
EXPOSE 3210 3211
ENTRYPOINT ["node", "dist/main.js"]
CMD ["daemon", "--config", "/run/secrets/bb_config"]
