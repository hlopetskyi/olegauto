#!/bin/bash
# Deploy local-server to Hetzner cx23 (167.233.90.80)

set -e

SERVER="167.233.90.80"
SSH_KEY="/tmp/olegauto_key"
REMOTE_DIR="/root/olegauto"
LOCAL_DIR="$(dirname "$0")/local-server"

# Regenerate SSH key if missing (uploads to Hetzner automatically)
if [ ! -f "$SSH_KEY" ]; then
  echo "SSH key missing at $SSH_KEY — regenerating..."
  HETZNER_TOKEN="xaurMzbkJApcvsxTFPPNYSZ8snpdDiMPwzUT30SSQZjxWuKju071Fqix2T4cGeOK"
  ssh-keygen -t ed25519 -f "$SSH_KEY" -N "" -q
  # Remove old key and upload new one
  curl -s -X DELETE "https://api.hetzner.cloud/v1/ssh_keys/113722044" \
    -H "Authorization: Bearer $HETZNER_TOKEN" > /dev/null
  curl -s -X POST https://api.hetzner.cloud/v1/ssh_keys \
    -H "Authorization: Bearer $HETZNER_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"claude-deploy\",\"public_key\":\"$(cat ${SSH_KEY}.pub)\"}" > /dev/null
  echo "New SSH key uploaded. You may need to add it via Hetzner rescue mode."
  echo "See Obsidian 2026-06-14.md for instructions."
  exit 1
fi

SSH_OPTS="-i $SSH_KEY -o StrictHostKeyChecking=no"

echo "==> Copying files to server..."
scp $SSH_OPTS -r \
  "$LOCAL_DIR/server.js" \
  "$LOCAL_DIR/package.json" \
  "$LOCAL_DIR/package-lock.json" \
  "$LOCAL_DIR/public" \
  "$LOCAL_DIR/data" \
  "root@$SERVER:$REMOTE_DIR/"

echo "==> Installing dependencies..."
ssh $SSH_OPTS root@$SERVER "cd $REMOTE_DIR && npm install --omit=dev"

echo "==> Restarting app..."
ssh $SSH_OPTS root@$SERVER "pm2 restart olegauto"

echo "==> Done. Checking status..."
ssh $SSH_OPTS root@$SERVER "pm2 status olegauto"

echo ""
echo "Site live at: http://olegavto.com"
