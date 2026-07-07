#!/usr/bin/env sh
set -eu

DEPLOY_DIR="${DEPLOY_DIR:-/opt/paotuan/current/deploy}"
COMPOSE_FILES="${COMPOSE_FILES:--f docker-compose.yml}"

cd "$DEPLOY_DIR"

if [ ! -f .env ]; then
  echo "deploy/.env is missing" >&2
  exit 1
fi

read_env_value() {
  key="$1"
  awk -v key="$key" '
    BEGIN { bom = sprintf("%c%c%c", 239, 187, 191) }
    {
      sub(/\r$/, "", $0)
      if (NR == 1) {
        sub("^" bom, "", $0)
      }

      line = $0
      if (line ~ /^[[:space:]]*$/ || line ~ /^[[:space:]]*#/) {
        next
      }

      sub(/^[[:space:]]*export[[:space:]]+/, "", line)
      eq = index(line, "=")
      if (!eq) {
        next
      }

      name = substr(line, 1, eq - 1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", name)
      if (name != key) {
        next
      }

      value = substr(line, eq + 1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      if (value ~ /^".*"$/ || value ~ /^'\''.*'\''$/) {
        value = substr(value, 2, length(value) - 2)
      }

      print value
      exit
    }
  ' .env
}

docker compose --env-file .env $COMPOSE_FILES config >/dev/null
docker compose --env-file .env $COMPOSE_FILES ps

docker compose --env-file .env $COMPOSE_FILES exec -T server node -e "
const checks = [
  ['health', 'http://127.0.0.1:8787/health'],
];
for (const [name, url] of checks) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(name + ' failed: ' + res.status);
}
console.log(JSON.stringify({ok:true, checks: checks.map(([name]) => name)}));
"

if command -v curl >/dev/null 2>&1; then
  APP_DOMAIN="$(read_env_value APP_DOMAIN)"
  verify_socket_origin() {
    curl -fsS -H "Origin: $1" "$PUBLIC_BASE/socket.io/?EIO=4&transport=polling" >/dev/null
  }
  if [ -n "$APP_DOMAIN" ] && [ "${VERIFY_PUBLIC_HTTP:-0}" = "0" ]; then
    case "$APP_DOMAIN" in
      http://*|https://*) PUBLIC_BASE="${APP_DOMAIN%/}" ;;
      *) PUBLIC_BASE="https://$APP_DOMAIN" ;;
    esac
    curl -fsS "$PUBLIC_BASE/health" >/dev/null
    curl -fsS "$PUBLIC_BASE/site.webmanifest" >/dev/null
    verify_socket_origin "$PUBLIC_BASE"
    verify_socket_origin "https://appassets.androidplatform.net"
    verify_socket_origin "paotuan://app"
  elif [ -n "$APP_DOMAIN" ]; then
    case "$APP_DOMAIN" in
      http://*|https://*) PUBLIC_BASE="${APP_DOMAIN%/}" ;;
      *) PUBLIC_BASE="http://$APP_DOMAIN" ;;
    esac
    curl -fsS "$PUBLIC_BASE/health" >/dev/null
    curl -fsS "$PUBLIC_BASE/site.webmanifest" >/dev/null
    verify_socket_origin "$PUBLIC_BASE"
    verify_socket_origin "https://appassets.androidplatform.net"
    verify_socket_origin "paotuan://app"
  fi
fi

echo "server verify passed"
