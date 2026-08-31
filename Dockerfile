# Build
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

# Run
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# The directory ships with the image so the service runs out of the box; mount a
# fresher one over /app/data to update without rebuilding.
COPY data ./data
EXPOSE 8787
CMD ["node", "dist/server.js"]
