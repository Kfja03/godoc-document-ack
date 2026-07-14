# --- build stage: compile TypeScript ---
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- runtime stage: only what's needed to run the compiled app ---
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist

# Data and uploads are written under /app/data and /app/uploads at runtime -
# mount these as volumes (see docker-compose.yml) so they survive container
# restarts/rebuilds instead of living only in the container's writable layer.
EXPOSE 4000
CMD ["node", "--experimental-sqlite", "dist/server.js"]
