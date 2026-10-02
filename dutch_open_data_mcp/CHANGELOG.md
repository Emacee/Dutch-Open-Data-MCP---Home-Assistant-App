# Changelog

Versions below 1.0.0 were developed in a private repository; they are kept
here because they document why things are the way they are.


## 1.1.0

Efficiency, security and dependency review.

**Dependencies**
- NL-GOV-MCP upstream bumped to `f875a21`. Adds `lido_verwijzingen_lijst`
  (the actual list of LiDO references, not just counts) plus fixes in the
  KOOP, LiDO and RIVM connectors. Re-audited for new credentials: the only
  new ones are an optional LiDO account (see below); the set of key-gated
  tools is unchanged.
- `@modelcontextprotocol/sdk` 1.30.0 → 1.31.0. Express 5.2.1 is current.
  `npm audit`: 0 vulnerabilities before and after.
- **Added `package-lock.json` and switched the image build to `npm ci`.**
  Previously every user's build resolved ~120 transitive dependencies
  fresh, so builds differed between users and a newly published malicious
  version of a deep dependency could be pulled in. Every build now installs
  exactly the recorded versions and integrity hashes. (The lockfile pins the
  upstream git dependency over HTTPS — npm writes `git+ssh://` by default,
  which would fail on every Home Assistant host, having no SSH key.)
- New optional `lido_username` / `lido_password` options. Not needed today;
  the new tool is published without them.

**Security**
- OAuth tokens are now stored as SHA-256 hashes. `/data` is in every Home
  Assistant backup, so a plaintext store let anyone holding a backup act as
  your connected clients. Existing stores are migrated on first start;
  connected clients keep working.
- Refresh tokens now rotate on every use and expire after 90 days unused,
  as OAuth 2.1 requires for public clients. A copied refresh token used to
  stay valid forever.
- An option read as null no longer becomes the literal string `"null"`.
  `bashio::config` prints `null` for a missing or null option, which the
  add-on used as-is: a null API key counted as configured (publishing a tool
  that cannot work), and a null `mcp_auth_token` would have made the bearer
  token the guessable string `null`.
- `trust proxy` now trusts forwarded headers only from private addresses
  (where cloudflared or a LAN proxy connects from), not from any client.
- `/register` flooding can no longer evict the client you actually
  authorised: eviction now skips clients holding a live refresh token.
- The image is now built in two stages; `npm` and `git` no longer ship in
  the runtime image, only `node` and `jq`.
- Accepts `bearer` in any letter case, per RFC 7235.

**Efficiency**
- MCP sessions are now evicted after 30 minutes idle and capped at 100.
  Sessions only ended on an explicit `DELETE`, which most clients never
  send, and each holds a full server with every tool registered, so memory
  grew for as long as the add-on ran.
- A rejected `initialize` no longer leaks its server and transport.
- The tool gate is decided once per tool, not re-evaluated for every tool
  on every new session.
- Checking an OAuth token no longer writes to disk on the request path.

## 1.0.0

First public release.

- Renamed to **Dutch Open Data MCP** (slug `dutch_open_data_mcp`). The
  add-on packages NL-GOV-MCP but is not endorsed by WAINUT, and their
  notice reserves their marks for exactly that reason, so the product no
  longer carries their name. Credit is given descriptively instead, and
  their NOTICE is retained as Apache-2.0 4(d) requires.

Hardening and documentation pass ahead of a possible public release. The
add-on had been built for one known operator; these are the things that
only bite once strangers run it, or once someone other than the admin can
reach it.

- **Ingress dashboard now rejects non-Supervisor callers.** Home Assistant
  requires an ingress app to accept connections only from `172.30.32.2`.
  The dashboard port isn't published, but unpublished ports are still
  reachable from other containers on the Supervisor network — and this page
  can write API keys and restart the add-on. Checked against the raw socket
  address, never a forwarded header.
- **Secrets are no longer rendered in the dashboard by default.** Ingress
  authenticates the visitor but does not tell the add-on who they are, and
  `panel_admin` only hides the sidebar entry — the ingress URL itself is
  open to every logged-in Home Assistant user. The bearer token is no
  longer shown there (it stays in the admin-only Configuration tab), and
  key fields are write-only: settable, never echoed back, with a blank
  field meaning "unchanged" so Save can't wipe them. New
  `show_secrets_in_ui` option restores the old behaviour.
- **Fixed a brute-force throttle bypass.** The `/authorize` consent page
  rate-limited per `req.ip`, but the app sets `trust proxy`, so `req.ip`
  comes from `X-Forwarded-For` — which the caller sets. An attacker could
  rotate it for unlimited token guesses. Now keyed on the real socket
  address.
- **OAuth metadata no longer trusts the request's Host.** With
  `trust proxy` on, `X-Forwarded-Host` could make the discovery documents
  advertise endpoints on an attacker-chosen hostname. They now use the
  configured `mcp_url` origin, falling back to the request host only when
  it's unset.
- **`/health/sources` now requires the bearer token.** It lists configured
  sources and tool names — a map of the install that anonymous callers on a
  public hostname shouldn't get. `/health` stays open but returns only
  liveness.
- Removed the author's own domain from the shipped defaults and docs:
  `mcp_url` now defaults to blank.
- Rewrote DOCS.md for people who aren't the author: quick start, a full
  Cloudflare Tunnel walkthrough (plus what to do with any other reverse
  proxy), and a Security section covering what's exposed on which port,
  what an attacker with the token actually gets, and where secrets live.

## 0.9.0

- The ingress dashboard can now edit and save the API keys. They are
  written through Supervisor (`POST /addons/self/options`) into the
  add-on's own options — the exact same store the Configuration tab uses,
  not a second copy — so both places stay in sync whichever you use.
- Added a "restart add-on" button next to it, since keys are read into the
  environment at startup and the published tool set is resolved there too.
- Fixed: the "revoke all OAuth tokens" form posted to an absolute
  `/revoke-oauth`, which under ingress (`/api/hassio_ingress/<token>/…`)
  would have left the ingress path and 404'd. All dashboard form actions
  and redirects are now relative, so they resolve under the ingress base.
- The key status table is now labelled as "currently active" (the startup
  snapshot) to distinguish it from the editable stored values above it,
  which can differ until you restart.

## 0.8.0

- Tool gating no longer treats "non-empty" as "configured". A key is only
  accepted if it could plausibly be one: values are trimmed, and a value
  that looks like a URL is rejected outright. This was a real leak — the
  Home Assistant Companion app's config-form bug (see 0.7.1) wrote this
  add-on's own `mcp_url` into `api_keys.ned_api_key`, which the old check
  accepted, so `ned_energie_search` was published backed by a "credential"
  that is actually a URL.
- Gating is now derived from upstream's own tool descriptions (scanning
  each registered tool for the `*_API_KEY` it declares) in addition to the
  hand-maintained list. If a future upstream pin adds a key-gated tool,
  it is withheld automatically instead of leaking until someone notices.
  `bag_address_detail` is explicitly exempt — upstream documents that it
  degrades to Locatieserver-only data rather than failing without a key.
- The startup report now states exactly what was decided: how many tools
  are published, which are withheld and why (per key, with the reason),
  and which keys were ignored as unusable. Same detail on the ingress
  dashboard and in `/health/sources`, which now also lists the published
  tool names.
- Node: bumped the base image from Alpine 3.20 (Node 20) to 3.22, since
  nl-gov-mcp declares `engines.node ">=22"`. The Dockerfile and the
  add-on log now both report the Node version they actually got, so this
  can't drift unnoticed again. Deliberately non-fatal: the Alpine->Node
  mapping couldn't be verified before shipping, and a failing build would
  be worse than an older Node (which did work).

## 0.7.2

- Fixed the crash loop introduced in 0.7.0: the Dockerfile copied only
  `app/gateway.mjs` into the image, so the new `app/oauth.mjs` was never
  shipped and the add-on died on startup with
  `ERR_MODULE_NOT_FOUND: Cannot find module '/app/oauth.mjs'`. Now copies
  `app/*.mjs`, so sibling modules are picked up automatically instead of
  needing a Dockerfile edit each time one is added.
- Corrected the Dockerfile's misleading "Node 22" comment: `apk add
  nodejs` installs whatever the base image's Alpine release ships, which
  for Alpine 3.20 (build.yaml) is Node 20 — while nl-gov-mcp declares
  `engines.node ">=22"`. It runs today (npm treats engines as advisory),
  but the mismatch is now documented rather than implied away.

## 0.7.1

- Fixed: the Home Assistant Companion (mobile) app's Configuration form
  doesn't handle the `url` schema type correctly — saving would fail with
  "Missing option 'mcp_url'" while the value silently ended up written
  into `api_keys.ned_api_key` instead. Changed `mcp_url`'s schema from
  `url` to `str?` (optional plain string): it's a display-only field, so
  no real validation is lost, and `str` is supported everywhere.

## 0.7.0

- Added OAuth 2.1 support (Dynamic Client Registration, RFC 7591 + PKCE,
  RFC 7636) for MCP clients that only offer an "OAuth" connector option
  and no raw bearer-header field — notably the Claude iOS app.
  New module `app/oauth.mjs`; new endpoints on the existing MCP port
  (`8098`): `/.well-known/oauth-protected-resource`,
  `/.well-known/oauth-authorization-server`, `/register`, `/authorize`,
  `/token`.
- The existing `mcp_auth_token` doubles as the login credential on the new
  `/authorize` consent page — there's no separate OAuth password to
  manage. Approving a client there mints it its own opaque access/refresh
  tokens; `requireBearerAuth` now accepts either the static token or a
  valid OAuth-issued one, so existing static-header setups are unaffected.
- `requireBearerAuth` now sends `WWW-Authenticate: Bearer
  resource_metadata="…"` on a `401`, so spec-compliant MCP clients
  auto-discover the OAuth flow instead of just failing.
- Ingress dashboard: added a list of OAuth-registered clients and a
  "revoke all OAuth tokens" action (registered clients stay registered;
  their issued tokens are invalidated, forcing re-authorization).
- Registered clients and issued tokens persist in
  `/data/oauth-store.json` across restarts/updates; authorization codes
  are one-time-use, 5-minute-lived, and kept in memory only.

## 0.6.0

- Added an ingress-accessible status dashboard: `ingress: true` +
  `ingress_port: 8099` in `config.yaml`, with a new sidebar panel. The
  dashboard shows configured/missing sources, currently disabled tools,
  and the MCP URL + bearer token ready to copy.
- The dashboard runs as its own Express app (`webApp` in `gateway.mjs`) on
  its own port, which is intentionally **not** listed under `ports` — so
  it's reachable only through Home Assistant's authenticated ingress
  proxy, never directly and never through the Cloudflare Tunnel (which
  still only reaches port `8098`, the bearer-protected MCP port). That's
  what makes it safe to show the bearer token there without a second
  login.
- Documented (DOCS.md) that `api_keys.*` and `mcp_auth_token` already only
  ever lived in Home Assistant's own Supervisor-managed options storage —
  never in this repo — no behavior change there, just made it explicit.

## 0.5.0

- Added `mcp_url`, an informational-only field in Configuration showing
  the URL to give an MCP client (`https://mcp.example.com/mcp`),
  right next to `mcp_auth_token` — no need to open DOCS.md to find it.
  The add-on doesn't read this value back; it's display only. Deliberately
  kept separate from `mcp_auth_token` so the token is never pasted into
  the URL itself — clients must send it as a header instead.

## 0.4.0

- Reverted the 0.3.0 approach of shipping a real token as `config.yaml`'s
  default: no secret belongs in a git repo, private or not.
- `mcp_auth_token` defaults to `""` again. `run.sh` now generates a random
  token on first start and pushes it back into this add-on's own
  Configuration via the Supervisor API (`POST /addons/self/options`), so
  it shows up in the Configuration tab (reopen it, no restart needed)
  without ever touching source control or requiring a log check.
  Requires `hassio_api: true`, added to `config.yaml`.
- Setting `mcp_auth_token` yourself in Configuration still overrides it,
  and Home Assistant persists that like any other add-on option.
- Added `jq` to the image (used to merge the generated token into
  `options.json` before pushing it back).

## 0.3.0

- `mcp_auth_token` now ships pre-filled with a random token in
  `config.yaml`, visible directly in the add-on's Configuration tab on
  first install — no need to check the log to find it.
- Overriding it in Configuration still works exactly as before, and Home
  Assistant persists whatever value you set there across restarts and
  updates like any other add-on option (the `/data/mcp_auth_token`
  fallback in `run.sh` is now only a safety net for pre-0.3.0 installs
  that still have the option stored blank).

## 0.2.0

- `mcp_auth_token` is now optional: if left blank, `run.sh` generates a
  random 256-bit token on first start, persists it to
  `/data/mcp_auth_token` so it survives restarts/updates, and logs it.
  Setting the option explicitly still overrides and takes precedence.
  The add-on no longer refuses to start when the option is empty.

## 0.1.0

- Initial release: gateway add-on around
  [WAINUTAI/NL-GOV-MCP](https://github.com/WAINUTAI/NL-GOV-MCP) (pinned to
  commit `8ba92d75b5c9b6221b8c87fff5ecc932f95ef122`).
- Required bearer-token auth on `/mcp` and `/sse` + `/messages`.
- Per-source API keys, configurable via add-on options; tools whose key is
  missing are removed from the MCP tool list instead of erroring at call
  time.
- `/health` and `/health/sources` exposed unauthenticated for tunnel/uptime
  checks and to show which tools are currently disabled and why.
