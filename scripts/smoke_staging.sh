#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${1:-.env.staging}"

host_port="$(grep -E '^VAULTOPS_HOST_PORT=' "$ENV_FILE" 2>/dev/null | head -n1 | cut -d'=' -f2- | tr -d '[:space:]' || true)"
if [[ -z "$host_port" ]]; then
  host_port="3800"
fi
bind_ip="$(grep -E '^TAILSCALE_IP=' "$ENV_FILE" 2>/dev/null | head -n1 | cut -d'=' -f2- | tr -d '[:space:]' || true)"
if [[ -z "$bind_ip" ]]; then
  bind_ip="127.0.0.1"
fi

base_url="http://${bind_ip}:${host_port}/v1"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

container_name="vaultops_api_staging"
transport_mode="host"

request_via_container() {
  local method="$1"
  local path="$2"
  local output_file="$3"
  local payload="${4:-}"
  local auth_header="${5:-}"
  local raw_file="$tmp_dir/container_response.txt"

  docker exec \
    -e API_METHOD="$method" \
    -e API_URL="http://127.0.0.1:3000/v1${path}" \
    -e API_BODY="$payload" \
    -e API_AUTH="$auth_header" \
    "$container_name" \
    node -e '
      const method = process.env.API_METHOD || "GET";
      const url = process.env.API_URL;
      const body = process.env.API_BODY || "";
      const auth = process.env.API_AUTH || "";
      const headers = {};
      if (auth) headers.authorization = auth;
      if (body) headers["content-type"] = "application/json";
      const init = { method, headers };
      if (body) init.body = body;
      fetch(url, init).then(async (res) => {
        const text = await res.text();
        process.stdout.write(`__STATUS__${res.status}\n`);
        process.stdout.write(text);
      }).catch((error) => {
        process.stderr.write(String(error?.message || error));
        process.exit(7);
      });
    ' > "$raw_file"

  local code
  code="$(sed -n '1s/^__STATUS__//p' "$raw_file")"
  sed '1d' "$raw_file" > "$output_file"
  printf '%s' "$code"
}

request_api() {
  local method="$1"
  local path="$2"
  local output_file="$3"
  local payload="${4:-}"
  local auth_header="${5:-}"
  local code=""

  if [[ "$transport_mode" == "host" ]]; then
    local curl_args=(-sS -o "$output_file" -w '%{http_code}' -X "$method")
    if [[ -n "$auth_header" ]]; then
      curl_args+=(-H "authorization: ${auth_header}")
    fi
    if [[ -n "$payload" ]]; then
      curl_args+=(-H 'content-type: application/json' -d "$payload")
    fi

    code="$(curl "${curl_args[@]}" "${base_url}${path}" || true)"
    if [[ "$code" == "000" ]]; then
      transport_mode="container"
      code="$(request_via_container "$method" "$path" "$output_file" "$payload" "$auth_header")"
    fi
  else
    code="$(request_via_container "$method" "$path" "$output_file" "$payload" "$auth_header")"
  fi

  printf '%s' "$code"
}

echo "Smoke: health check"
health_code="$(request_api "GET" "/health" "$tmp_dir/health.json")"
if [[ "$health_code" != "200" ]]; then
  echo "ERROR: health check failed with HTTP ${health_code}"
  cat "$tmp_dir/health.json" || true
  exit 1
fi

if command -v python3 >/dev/null 2>&1; then
  db_ok="$(python3 - "$tmp_dir/health.json" <<'PY'
import json
import sys
with open(sys.argv[1], 'r', encoding='utf-8') as fh:
    payload = json.load(fh)
print('true' if payload.get('checks', {}).get('db', {}).get('ok') else 'false')
PY
)"
  if [[ "$db_ok" != "true" ]]; then
    echo "ERROR: database check is not healthy"
    cat "$tmp_dir/health.json" || true
    exit 1
  fi
fi

echo "Smoke: mint workspace token"
mint_payload='{"workspace_id":"ws_123","repo_id":"repo_smoke","machine_id":"gitlab-smoke","cli_version":"1.0.0"}'
mint_code="$(request_api "POST" "/auth/workspace-token:mint" "$tmp_dir/mint.json" "$mint_payload")"
if [[ "$mint_code" != "200" && "$mint_code" != "201" ]]; then
  echo "ERROR: token mint failed with HTTP ${mint_code}"
  cat "$tmp_dir/mint.json" || true
  exit 1
fi

token="$(sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p' "$tmp_dir/mint.json")"
if [[ -z "$token" ]]; then
  echo "ERROR: token mint response has no access_token"
  cat "$tmp_dir/mint.json" || true
  exit 1
fi

echo "Smoke: open paid run with valid token"
idempotency_key_valid="smoke-valid-$(date +%s)-$$"
open_payload_valid="{\"workspace_id\":\"ws_123\",\"repo_id\":\"repo_smoke\",\"task_id\":\"smoke-task\",\"policy_pack\":\"startup-fastlane\",\"idempotency_key\":\"${idempotency_key_valid}\"}"
open_code="$(request_api "POST" "/team-mode/runs:open" "$tmp_dir/open_valid.json" "$open_payload_valid" "Bearer ${token}")"
if [[ "$open_code" != "200" && "$open_code" != "201" ]]; then
  echo "ERROR: runs:open with valid token failed with HTTP ${open_code}"
  cat "$tmp_dir/open_valid.json" || true
  exit 1
fi

echo "Smoke: start workflow run"
workflow_idempotency="smoke-workflow-$(date +%s)-$$"
workflow_task="EXE-SMOKE-$(date +%s)"
workflow_payload="{\"workspace_id\":\"ws_123\",\"repo_id\":\"repo_smoke\",\"task_id\":\"${workflow_task}\",\"policy_pack\":\"startup-fastlane\",\"idempotency_key\":\"${workflow_idempotency}\"}"
workflow_code="$(request_api "POST" "/workflows/runs:start" "$tmp_dir/workflow_start.json" "$workflow_payload" "Bearer ${token}")"
if [[ "$workflow_code" != "200" && "$workflow_code" != "201" ]]; then
  echo "ERROR: workflows/runs:start failed with HTTP ${workflow_code}"
  cat "$tmp_dir/workflow_start.json" || true
  exit 1
fi

echo "Smoke: reject invalid token"
idempotency_key_invalid="smoke-invalid-$(date +%s)-$$"
open_payload_invalid="{\"workspace_id\":\"ws_123\",\"repo_id\":\"repo_smoke\",\"task_id\":\"smoke-task-invalid\",\"policy_pack\":\"startup-fastlane\",\"idempotency_key\":\"${idempotency_key_invalid}\"}"
open_invalid_code="$(request_api "POST" "/team-mode/runs:open" "$tmp_dir/open_invalid.json" "$open_payload_invalid" "Bearer invalid-token")"
if [[ "$open_invalid_code" != "401" ]]; then
  echo "ERROR: runs:open with invalid token expected HTTP 401, got ${open_invalid_code}"
  cat "$tmp_dir/open_invalid.json" || true
  exit 1
fi

echo "Smoke: passed"
