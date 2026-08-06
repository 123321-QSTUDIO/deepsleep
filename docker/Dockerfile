FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git sqlite3 python3 ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

RUN npm i -g opencode-ai

RUN mkdir -p /root/.config/opencode /workspace
COPY opencode.json /root/.config/opencode/opencode.json

WORKDIR /workspace
ENTRYPOINT ["opencode"]
