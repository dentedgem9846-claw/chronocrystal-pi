FROM ubuntu:22.04

ARG DEBIAN_FRONTEND=noninteractive
ARG SIMPLEX_VERSION=v6.4.11

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl libgmp10 unzip \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

RUN curl -fsSL -o /usr/local/bin/simplex-chat \
    "https://github.com/simplex-chat/simplex-chat/releases/download/${SIMPLEX_VERSION}/simplex-chat-ubuntu-22_04-x86_64" \
    && chmod +x /usr/local/bin/simplex-chat

WORKDIR /app

COPY package.json bun.lock* ./
COPY .husky/install.mjs ./.husky/install.mjs
RUN bun install --frozen-lockfile --production

COPY src ./src
COPY data ./data
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]