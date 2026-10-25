FROM node:22-bookworm-slim

WORKDIR /app

COPY . .

RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends ca-certificates
RUN npm ci --no-audit --no-fund