#!/bin/bash
#
# Знімає Inventa з автозапуску. Дані не чіпає — база лишається на місці.
#
set -euo pipefail

LABEL="com.inventa.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
rm -f "$PLIST"

echo "Автозапуск знято. Запустити вручну: npm start"
