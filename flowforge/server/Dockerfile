FROM node:20-alpine

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm ci

RUN mkdir -p data

COPY . .

EXPOSE 3001

CMD ["npm", "run", "dev"]
