# v0.7.8

# Build API, Client and Data Provider
FROM --platform=linux/amd64 node:20-alpine AS base-min

WORKDIR /app
COPY package*.json ./
COPY packages/data-provider/package*.json ./packages/data-provider/
COPY packages/mcp/package*.json ./packages/mcp/
COPY client/package*.json ./client/
COPY api/package*.json ./api/

# Install all dependencies for every build
FROM base-min AS base
WORKDIR /app
RUN npm ci

# Build data-provider
FROM base AS data-provider-build
WORKDIR /app/packages/data-provider
COPY ./packages/data-provider ./
RUN npm run build
RUN npm prune --production

# Build mcp package
FROM base AS mcp-build
WORKDIR /app/packages/mcp
COPY ./packages/mcp ./
COPY --from=data-provider-build /app/packages/data-provider/dist /app/packages/data-provider/dist
RUN npm run build
RUN npm prune --production

# React client build
FROM base AS client-build
WORKDIR /app/client
COPY ./client/package*.json ./
# Copy data-provider to client's node_modules
COPY --from=data-provider-build /app/packages/data-provider/dist /app/packages/data-provider/dist
COPY ./client/ ./
ENV NODE_OPTIONS="--max-old-space-size=2048"
RUN npm run build


# Node API setup
FROM base AS api-build
WORKDIR /app
COPY api/ ./api
COPY config/ ./config
# Copy data-provider to API's node_modules
COPY --from=data-provider-build /app/packages/data-provider/dist /app/packages/data-provider/dist
COPY --from=mcp-build /app/packages/mcp/dist /app/packages/mcp/dist
COPY --from=client-build /app/client/dist /app/client/dist
WORKDIR /app/api
RUN npm prune --production
EXPOSE 3080
ENV HOST=0.0.0.0
CMD ["node", "server/index.js"]
