#!/bin/sh
set -eu

# Escape single/double quotes and backslashes for safe JS literal embedding
API_URL="${API_BASE_URL:-/api/v1}"
ESCAPED_URL=$(printf '%s' "$API_URL" | sed 's/\\/\\\\/g; s/"/\\"/g')

cat <<EOF > /etc/nginx/runtime/config.js
window.__NESTLY_CONFIG__ = {
  API_BASE_URL: "${ESCAPED_URL}"
};
EOF

echo "[client-entrypoint] Generated /etc/nginx/runtime/config.js with API_BASE_URL=${API_URL}"

# Optional dynamic DNS resolver (e.g., 127.0.0.11 for multi-replica Docker Compose API scaling).
# When unset (default), keeps the static proxy_pass http://api:3000/api/; behavior untouched.
RESOLVER="${API_UPSTREAM_RESOLVER:-}"
if [ -n "$RESOLVER" ]; then
  if ! printf '%s' "$RESOLVER" | grep -Eq '^[0-9a-fA-F.:]+$'; then
    echo "[client-entrypoint] Invalid API_UPSTREAM_RESOLVER value: ${RESOLVER}" >&2
    exit 1
  fi
  CONF_FILE="/etc/nginx/conf.d/default.conf"
  TMP_FILE="/tmp/default.conf.next"
  sed "s|proxy_pass http://api:3000/api/;|resolver ${RESOLVER} valid=5s ipv6=off;\n        set \$api_upstream http://api:3000;\n        proxy_pass \$api_upstream;|g" "$CONF_FILE" > "$TMP_FILE"
  cp "$TMP_FILE" "$CONF_FILE"
  rm -f "$TMP_FILE"
  echo "[client-entrypoint] Enabled dynamic API upstream resolver=${RESOLVER}"
fi
