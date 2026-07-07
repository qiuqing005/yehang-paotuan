#!/bin/sh
set -eu

stamp="${1:?release stamp is required}"
remote_dir="${REMOTE_DIR:-/opt/paotuan}"
archive="/tmp/paotuan-release-${stamp}.tgz"
release="${remote_dir}/releases/${stamp}"

if [ ! -f "$archive" ]; then
  echo "Archive not found: $archive" >&2
  exit 1
fi

mkdir -p "$release"
tar -xzf "$archive" -C "$release"
rm -f "$archive"

if [ -f "${remote_dir}/current/deploy/.env" ] && [ ! -f "${release}/deploy/.env" ]; then
  cp "${remote_dir}/current/deploy/.env" "${release}/deploy/.env"
fi

ln -sfn "$release" "${remote_dir}/current"

cd "${remote_dir}/current/deploy"
docker compose --env-file .env -f docker-compose.yml config >/dev/null

docker cp "${remote_dir}/current/apps/server/dist/." paotuan-server-1:/app/apps/server/dist/
docker restart paotuan-server-1 >/dev/null
docker commit paotuan-server-1 paotuan-server:latest >/dev/null

docker exec paotuan-web-1 sh -lc 'rm -rf /usr/share/caddy/*'
docker cp "${remote_dir}/current/apps/web/dist/." paotuan-web-1:/usr/share/caddy/
docker restart paotuan-web-1 >/dev/null
docker commit paotuan-web-1 paotuan-web:latest >/dev/null

docker compose --env-file .env -f docker-compose.yml ps
