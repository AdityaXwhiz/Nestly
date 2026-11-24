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
