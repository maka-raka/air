# AIR runtime image: the comment poller (default), the agent CLI and the
# deploy reporter. See docs/engineering/docker.md and ADR-0011.
#
#   docker build -t air .
#   docker compose up -d poller

# Base image pinned by digest (ADR-0010); Dependabot bumps it. Keep the
# Node major in step with .nvmrc.
FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS runtime
ENV NODE_ENV=production \
    AIR_STATE_DIR=/var/lib/air
WORKDIR /opt/air
COPY --from=build /src/package.json ./
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/dist/src ./dist/src
COPY templates ./templates
COPY .env.example ./
RUN find dist -name '*.test.js' -delete \
 && mkdir -p /var/lib/air \
 && chown node:node /var/lib/air
USER node
VOLUME ["/var/lib/air"]
ENTRYPOINT ["node", "/opt/air/dist/src/delivery/composition/local.js"]
