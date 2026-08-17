#!/bin/bash
#
# Ставить Inventa на автозапуск при вході в систему (macOS, launchd).
# Після цього додаток завжди доступний на http://localhost:3200
# і сам піднімається, якщо впаде або після перезавантаження комп'ютера.
#
# Запуск:   bash scripts/install-autostart.sh
# Зняти:    bash scripts/uninstall-autostart.sh
#
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.inventa.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE="$(command -v node || echo /usr/local/bin/node)"
PORT="${PORT:-3200}"
LOG_DIR="$APP_DIR/data/logs"

if [ ! -x "$NODE" ]; then
  echo "Не знайдено node. Встановіть Node.js і повторіть." >&2
  exit 1
fi

mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"

# Ключ підпису сесій зберігаємо один раз: якщо він мінятиметься при кожному
# запуску, усі входи злітатимуть після кожного перезавантаження.
SECRET_FILE="$APP_DIR/data/.session-secret"
if [ ! -f "$SECRET_FILE" ]; then
  head -c 48 /dev/urandom | xxd -p | tr -d '\n' > "$SECRET_FILE"
  chmod 600 "$SECRET_FILE"
fi
SECRET="$(cat "$SECRET_FILE")"

cat > "$PLIST" <<PLIST_END
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>

  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$APP_DIR/server.js</string>
  </array>

  <key>WorkingDirectory</key>
  <string>$APP_DIR</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key>
    <string>$PORT</string>
    <key>INVENTA_SECRET</key>
    <string>$SECRET</string>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>$LOG_DIR/server.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/server.log</string>
</dict>
</plist>
PLIST_END

# Знімаємо попередню версію, якщо була, і ставимо нову.
launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$PLIST"
launchctl enable "gui/$UID/$LABEL"

echo "Готово. Inventa запускатиметься автоматично."
echo "Адреса: http://localhost:$PORT"
echo "Журнал: $LOG_DIR/server.log"
