#!/bin/bash
set -euo pipefail

BOT_DISPLAY_NAME="${BOT_DISPLAY_NAME:-ChronoCrystal}"
DATA_PREFIX="${DATA_PREFIX:-/app/state/simplex}"
SIMPLEX_PORT="${SIMPLEX_PORT:-5225}"
BUN_HTTP_PORT="${PORT:-8080}"
DATA_DIR="$(dirname "$DATA_PREFIX")"

mkdir -p "$DATA_DIR"
chown -R chronocrystal:chronocrystal "$DATA_DIR" /home/chronocrystal

export BOT_DISPLAY_NAME
export DATA_PREFIX
export SIMPLEX_PORT
export BUN_HTTP_PORT
export HOME=/home/chronocrystal

exec su -m -s /bin/bash chronocrystal -c '
set -euo pipefail

simplex-chat -d "$DATA_PREFIX" -p "$SIMPLEX_PORT" --create-bot-display-name "$BOT_DISPLAY_NAME" &

echo "Waiting for simplex-chat to start..."
for i in $(seq 1 30); do
    if { echo > "/dev/tcp/127.0.0.1/$SIMPLEX_PORT"; } 2>/dev/null; then
        echo "simplex-chat is ready"
        break
    fi
    sleep 1
done

if ! { echo > "/dev/tcp/127.0.0.1/$SIMPLEX_PORT"; } 2>/dev/null; then
    echo "ERROR: simplex-chat failed to start"
    exit 1
fi

export SIMPLEX_HOST=127.0.0.1
export SIMPLEX_PORT
export BUN_HTTP_PORT

exec /app/chronocrystal
'
