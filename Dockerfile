# One image, several entrypoints (api, processor, poller, migrate, fake-csms).

FROM node:22.20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Test image: full source and dev dependencies; runs vitest against the compose DB.
FROM deps AS test
COPY . .
CMD ["npx", "vitest", "run"]

FROM node:22.20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY seed ./seed
COPY fixtures ./fixtures
COPY public ./public
USER node
