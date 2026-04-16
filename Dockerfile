FROM oven/bun:1.3.12 AS build

WORKDIR /app

COPY package.json bun.lock* ./
COPY .husky/install.mjs ./.husky/install.mjs
RUN bun install --frozen-lockfile

COPY src ./src
COPY public ./public
COPY scripts ./scripts
RUN bun run build

FROM debian:bookworm-slim AS simplex-download

ARG DEBIAN_FRONTEND=noninteractive
ARG SIMPLEX_VERSION=v6.4.11
ARG SIMPLEX_SHA256=b4b32953880cbc157dc05b2465b9f151c48ce609089031aa4737ce2d17d71f2d

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL -o /tmp/simplex-chat \
    "https://github.com/simplex-chat/simplex-chat/releases/download/${SIMPLEX_VERSION}/simplex-chat-ubuntu-22_04-x86_64" \
    && echo "${SIMPLEX_SHA256}  /tmp/simplex-chat" | sha256sum -c - \
    && chmod +x /tmp/simplex-chat

FROM debian:bookworm-slim AS runtime

ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates libgmp10 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system chronocrystal \
    && useradd --system --gid chronocrystal --create-home --home-dir /home/chronocrystal chronocrystal \
    && mkdir -p /app/data /app/state \
    && chown -R chronocrystal:chronocrystal /app /home/chronocrystal

WORKDIR /app

COPY --from=build /app/dist/chronocrystal /app/chronocrystal
COPY --from=simplex-download /tmp/simplex-chat /usr/local/bin/simplex-chat
COPY package.json /app/package.json
COPY --chown=chronocrystal:chronocrystal data ./data
COPY entrypoint.sh /entrypoint.sh

RUN chmod 755 /entrypoint.sh /app/chronocrystal /usr/local/bin/simplex-chat \
    && /usr/local/bin/simplex-chat -h >/dev/null

EXPOSE 8080

ENTRYPOINT ["/entrypoint.sh"]
