# --- Build stage: compile the React app to static assets ---
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
# Vite inlines VITE_* vars at build time, so the API URL must be a build arg
# (not a runtime env var). docker-compose passes it through from .env.
ARG VITE_API_URL=http://localhost:3001
ENV VITE_API_URL=$VITE_API_URL
COPY . .
RUN npm run build

# --- Runtime stage: serve the static build with nginx ---
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
