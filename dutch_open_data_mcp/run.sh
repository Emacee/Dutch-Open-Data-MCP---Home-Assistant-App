#!/usr/bin/with-contenv bashio
# Home Assistant supplies /data/options.json and SUPERVISOR_TOKEN in the environment.
set -e

# bashio::config prints the literal string "null" for an option that is
# missing or null — e.g. a key added in an update, or an optional field
# Home Assistant stored as null. Passed through as-is, "null" would look like
# a real API key and publish a tool that cannot work, or (for LiDO) send
# Basic auth as null:null. Normalise it to empty.
opt() {
  local v
  v="$(bashio::config "$1")"
  [ "$v" = "null" ] && v=""
  printf '%s' "$v"
}


export NL_GOV_HTTP_PORT="8098"
export INGRESS_PORT="8099"
export NL_GOV_TIMEZONE
NL_GOV_TIMEZONE="$(opt 'timezone')"
export LOG_LEVEL
LOG_LEVEL="$(opt 'log_level')"
export MCP_URL
MCP_URL="$(opt 'mcp_url')"
export SHOW_SECRETS_IN_UI
SHOW_SECRETS_IN_UI="$(opt 'show_secrets_in_ui')"

export KNMI_API_KEY
KNMI_API_KEY="$(opt 'api_keys.knmi_api_key')"
export OVERHEID_API_KEY
OVERHEID_API_KEY="$(opt 'api_keys.overheid_api_key')"
export BAG_API_KEY
BAG_API_KEY="$(opt 'api_keys.bag_api_key')"
export DSO_API_KEY
DSO_API_KEY="$(opt 'api_keys.dso_api_key')"
export NED_API_KEY
NED_API_KEY="$(opt 'api_keys.ned_api_key')"
export EP_ONLINE_API_KEY
EP_ONLINE_API_KEY="$(opt 'api_keys.ep_online_api_key')"
export NS_API_KEY
NS_API_KEY="$(opt 'api_keys.ns_api_key')"
export DNB_API_KEY
DNB_API_KEY="$(opt 'api_keys.dnb_api_key')"
export LIDO_USERNAME
LIDO_USERNAME="$(opt 'api_keys.lido_username')"
export LIDO_PASSWORD
LIDO_PASSWORD="$(opt 'api_keys.lido_password')"

# Bearer token: no secret ships in config.yaml or this repo. If the
# Configuration field is blank, generate one and write it straight back
# into this add-on's own Configuration (via the Supervisor API) so it's
# visible in the UI on the very next tab open — no log-reading needed.
# Setting mcp_auth_token in Configuration yourself always takes precedence
# and is what Home Assistant persists across restarts/updates, same as
# every other add-on option.
TOKEN_FILE="/data/mcp_auth_token"
CONFIGURED_TOKEN="$(opt 'mcp_auth_token')"

if [ -n "$CONFIGURED_TOKEN" ]; then
  MCP_AUTH_TOKEN="$CONFIGURED_TOKEN"
  bashio::log.info "Using mcp_auth_token from the add-on's Configuration tab."
else
  if [ -s "$TOKEN_FILE" ]; then
    # Persisting to Configuration earlier failed (see below); don't
    # generate a second, different token on top of that failure.
    MCP_AUTH_TOKEN="$(cat "$TOKEN_FILE")"
  else
    MCP_AUTH_TOKEN="$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))')"
    ( umask 077; printf '%s' "$MCP_AUTH_TOKEN" > "$TOKEN_FILE" )
  fi

  NEW_OPTIONS="$(jq --arg token "$MCP_AUTH_TOKEN" '.mcp_auth_token = $token' /data/options.json)"
  if bashio::api.supervisor POST "/addons/self/options" "{\"options\": ${NEW_OPTIONS}}" >/dev/null; then
    bashio::log.info "Generated a bearer token and saved it into this add-on's Configuration tab (open it there any time)."
  else
    bashio::log.warning "Generated a bearer token but could not save it into Configuration automatically."
    bashio::log.warning "It's still in effect for this run — copy it from the next log line, or from ${TOKEN_FILE}, and paste it into 'mcp_auth_token' in Configuration to pin it."
    bashio::log.info "MCP bearer token — send as 'Authorization: Bearer <token>': ${MCP_AUTH_TOKEN}"
  fi
fi
export MCP_AUTH_TOKEN

bashio::log.info "Starting NL-GOV-MCP gateway on :${NL_GOV_HTTP_PORT}"

cd /app || exit 1
exec node gateway.mjs
