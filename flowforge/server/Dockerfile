# --- Build stage: install production deps (compiles native modules:
#     better-sqlite3, bcrypt) using the build toolchain ---
FROM node:20-alpine AS build
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# --- Runtime stage: slim image without the compiler toolchain ---
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
# Bring over the already-compiled dependencies, then the source.
COPY --from=build /app/node_modules ./node_modules
COPY . .
RUN mkdir -p data
EXPOSE 3001
CMD ["npm", "start"]
