# FlowForge

Visual workflow automation builder with real-time collaboration.

## Quick start

```bash
# 1. Copy env template and fill in values
cp .env.example .env

# 2. Start all services
docker-compose up --build

# 3. Open the app
open http://localhost:5173
```

## Services

| Service    | URL                      | Purpose                      |
|------------|--------------------------|------------------------------|
| client     | http://localhost:5173    | React UI                     |
| server     | http://localhost:3001    | REST API + Socket.io         |
| ai-service | http://localhost:5000    | LLM node suggestions         |
| redis      | localhost:6379           | Bull queue + Socket pub/sub  |

## Common commands

```bash
# Rebuild after package.json changes
docker-compose up --build server

# Open a shell in a running container
docker-compose exec server sh
docker-compose exec ai-service bash

# View logs
docker-compose logs -f server

# Run tests
docker-compose exec server npm test
docker-compose exec client npm test
docker-compose exec ai-service python -m pytest

# Stop everything
docker-compose down

# Wipe database and volumes (fresh start)
docker-compose down -v
```

## Environment variables

| Variable        | Description                              |
|-----------------|------------------------------------------|
| JWT_SECRET      | Secret for signing JWTs                  |
| OPENAI_API_KEY  | OpenAI API key for AI node suggestions   |
| VITE_API_URL    | Browser-facing URL for the server API    |
