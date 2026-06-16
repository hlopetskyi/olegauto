#!/bin/bash
# Deploy local-server to Hetzner cx23 (167.233.90.80)
# Requires: HETZNER_TOKEN env var, or set in .env file

set -e

SERVER="167.233.90.80"
SSH_KEY="$HOME/.ssh/olegauto_deploy"
REMOTE_DIR="/root/olegauto"
LOCAL_DIR="$(dirname "$0")/local-server"

# Load .env if exists
[ -f "$(dirname "$0")/.env" ] && source "$(dirname "$0")/.env"

# Regenerate SSH key if missing (uploads to Hetzner automatically)
if [ ! -f "$SSH_KEY" ]; then
  echo "SSH key missing at $SSH_KEY — regenerating..."
  if [ -z "$HETZNER_TOKEN" ]; then
    echo "ERROR: HETZNER_TOKEN not set. Add to .env file or export in shell."
    exit 1
  fi
  ssh-keygen -t ed25519 -f "$SSH_KEY" -N "" -q
  # Remove old key and upload new one
  curl -s -X DELETE "https://api.hetzner.cloud/v1/ssh_keys/113722044" \
    -H "Authorization: Bearer $HETZNER_TOKEN" > /dev/null
  curl -s -X POST https://api.hetzner.cloud/v1/ssh_keys \
    -H "Authorization: Bearer $HETZNER_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"claude-deploy\",\"public_key\":\"$(cat ${SSH_KEY}.pub)\"}" > /dev/null
  echo "New SSH key uploaded. See Obsidian 2026-06-14.md for next steps."
  exit 1
fi

SSH_OPTS="-i $SSH_KEY -o StrictHostKeyChecking=no"

echo "==> Copying files to server..."
scp $SSH_OPTS -r \
  "$LOCAL_DIR/server.js" \
  "$LOCAL_DIR/package.json" \
  "$LOCAL_DIR/package-lock.json" \
  "$LOCAL_DIR/public" \
  "root@$SERVER:$REMOTE_DIR/"

# Data files live only on server — managed via admin UI. NEVER overwrite from local.
# Bootstrap: create empty files on first deploy if they don't exist yet.
ssh $SSH_OPTS root@$SERVER "mkdir -p $REMOTE_DIR/data && \
  [ -f $REMOTE_DIR/data/products.json ] || echo '[]' > $REMOTE_DIR/data/products.json && \
  [ -f $REMOTE_DIR/data/orders.json ]   || echo '[]' > $REMOTE_DIR/data/orders.json && \
  [ -f $REMOTE_DIR/data/admins.json ]   || echo '[]' > $REMOTE_DIR/data/admins.json"

echo "==> Installing dependencies..."
ssh $SSH_OPTS root@$SERVER "cd $REMOTE_DIR && npm install --omit=dev"

echo "==> Restarting app..."
ssh $SSH_OPTS root@$SERVER "pm2 restart olegauto"

echo "==> Done. Checking status..."
ssh $SSH_OPTS root@$SERVER "pm2 status olegauto"

echo ""
echo "Site live at: https://olegavto.com"
