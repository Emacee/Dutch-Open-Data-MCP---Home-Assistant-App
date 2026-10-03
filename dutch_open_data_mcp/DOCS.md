# Dutch Open Data MCP

Runs [NL-GOV-MCP](https://github.com/WAINUTAI/NL-GOV-MCP) — an MCP server
exposing 46 Dutch government open-data sources (CBS, KNMI, RDW, Tweede
Kamer, PDOK/BAG, Rechtspraak, Rijkswaterstaat and more, ~74 tools) — as a
Home Assistant add-on, so AI assistants can query Dutch public data from
your own host.

**Credit:** the MCP server and all 46 data connectors are
[NL-GOV-MCP](https://github.com/WAINUTAI/NL-GOV-MCP), built by
[WAINUT](https://wainut.ai) and licensed Apache-2.0. This add-on packages
that server for Home Assistant and adds authentication, per-source gating
and this dashboard. It is an independent project, not affiliated with or
endorsed by WAINUT B.V. Problems with the data or a connector belong
upstream; problems with the packaging belong with this add-on.

It does **not** touch Home Assistant's own conversation or MCP integration.
It is a separate, independent MCP server that happens to run on the same
machine, usable alongside your Home Assistant MCP endpoint by any
MCP-capable assistant (Claude desktop and mobile, ChatGPT connectors,
Open WebUI, and so on).

## Quick start

1. **Install** the add-on and start it. On first start it generates a random
   bearer token and saves it into its own Configuration — you never have to
   invent one.
2. **Decide how clients reach it.**
   - *Local only:* point your client at `http://<HA host>:8098/mcp`. Nothing
     else to do.
   - *Over the internet:* give it its own subdomain through a Cloudflare
     Tunnel (or another reverse proxy) — see "Exposing it" below — and set
     `mcp_url` to the public URL, e.g. `https://nlgov-mcp.example.com/mcp`.
3. **Optionally add API keys** for the handful of sources that need one
   (Configuration tab, or the add-on's own web UI). Sources you skip are
   simply left out; everything else works without any key.
4. **Connect your client** with the URL plus an
   `Authorization: Bearer <token>` header, or via OAuth for clients that
   have no header field — see "Connecting a client".

Read **Security** below before exposing it to the internet.

## Why a gateway instead of running upstream directly

Upstream NL-GOV-MCP ships with:

- **No authentication** on its HTTP/SSE transports at all.
- **All ~74 tools always registered**, even for the 8 or so tools that need
  a personal API key (KNMI, NS, DNB, DSO, NED, EP-Online, the Overheid API
  register). Calling one of those without a key doesn't error until the LLM
  actually invokes the tool.

Both matter as soon as the server is reachable by anything but you: an
unauthenticated endpoint lets anyone who finds the URL spend your API
quotas, and an assistant that sees a tool it cannot actually use will keep
trying it and getting errors.

This add-on wraps upstream's server with:

1. A required bearer token on `/mcp` and `/sse` + `/messages` (`/health` and
   only `/health` stays open, for tunnel/uptime checks) — plus a minimal
   OAuth 2.1 layer (Dynamic Client Registration + PKCE) for clients that
   only offer an "OAuth" connector option and no raw header field, such as
   the Claude iOS app. See "Connecting a client" below.
2. Tool-list filtering: a tool whose required API key isn't usable is left
   out of `tools/list` entirely, so an assistant never sees it as an option
   in the first place. See "Which tools need a key" and "How the tool set is
   decided" below.

The upstream package is pulled straight from its GitHub repository, pinned
to a fixed commit (see `app/package.json`), not forked — so picking up
upstream's new sources later is a one-line version bump, not a merge.

## Configuration

| Option | Description |
|---|---|
| `mcp_url` | The public URL clients use, e.g. `https://nlgov-mcp.example.com/mcp`. Shown on the dashboard for copying, and used as the issuer in the OAuth discovery documents instead of trusting the request's `Host` header — so set it if you expose this publicly. Leave blank for local-only use. Never append the bearer token to it; it goes in an `Authorization` header. |
| `mcp_auth_token` | Starts blank — no secret is committed to this repo. On first start, `run.sh` generates a random 256-bit token and writes it straight back into this add-on's Configuration via the Supervisor API, so reopening the tab (no restart needed) shows it — no log-digging required. Set your own value here at any time to override it; Home Assistant persists whatever you put here across restarts and updates like any other option. Clients must send `Authorization: Bearer <token>`. |
| `timezone` | Default timezone for date/time parsing in tools like `nl_gov_ask`. Defaults to `Europe/Amsterdam`. |
| `log_level` | `debug` \| `info` \| `warning` \| `error`. |
| `show_secrets_in_ui` | Default `false`. Home Assistant Ingress is reachable by *every* logged-in user, not just admins, so by default the add-on's web UI never renders the bearer token or your API keys (keys stay write-only there). Turn it on only if every Home Assistant user on this install may see those secrets. See "Who can see this page". |
| `api_keys.*` | One optional field per gated source (see table below). Leave blank to skip that source — its tools simply won't appear in the MCP tool list. |

### Which tools need a key

| API key option | Tools hidden without it | Where to get a free key |
|---|---|---|
| `knmi_api_key` | `knmi_datasets`, `knmi_search_datasets`, `knmi_latest_files`, `knmi_latest_observations`, `knmi_warnings`, `knmi_earthquakes` | https://developer.dataplatform.knmi.nl/ |
| `overheid_api_key` | `overheid_api_register_search` | https://developer.overheid.nl/ |
| `dso_api_key` | `dso_omgevingsdocumenten_search` | https://developer.omgevingswet.overheid.nl/formulieren/api-key-aanvragen-0/ |
| `ned_api_key` | `ned_energie_search` | https://ned.nl/nl/api |
| `ep_online_api_key` | `ep_online_energielabel` | RVO EP-Online registration |
| `ns_api_key` | `ns_reisinformatie` | https://apiportal.ns.nl/ |
| `dnb_api_key` | `dnb_statistics_search` | https://api.portal.dnb.nl/ |
| `bag_api_key` | *(none — always registered)* | Improves `bag_address_detail` result quality; the tool still works and degrades gracefully without it, so it is never hidden. |
| `lido_username` + `lido_password` | *(none — always registered)* | Optional LiDO account (https://linkeddata.overheid.nl). LiDO documents its link list as account-only but does not enforce that today, so `lido_verwijzingen_lijst` works without them. Set both and they are sent as HTTP Basic auth, which keeps it working if LiDO starts enforcing. |

The other ~35 connectors (CBS, RDW, PDOK, Tweede Kamer, Rechtspraak, data.overheid.nl,
Rijksoverheid, Rijkswaterstaat, Luchtmeetnet, DUO, Eurostat, etc.) need no key
and are always registered.

The ingress dashboard shows exactly which tools are published and which are
withheld and why. The same detail is available as JSON at
`/health/sources`, which requires the bearer token — it describes your
install, so it is not public. `/health` is unauthenticated but returns
nothing but liveness, for uptime checks and the tunnel.

### How the tool set is decided

The published set is resolved **once at startup**, not per request: the
add-on builds one throwaway MCP server, every `registerTool` call passes
through the gate in `app/gateway.mjs`, and the result is what every client
session gets. The add-on log reports the outcome on each start — how many
tools are published, which are withheld, and the reason per key.

A tool is withheld when any API key it needs isn't *usable*. Two independent
checks decide that:

1. **Is the value plausibly a key?** Not merely non-empty: values are
   trimmed, and anything that looks like a URL is rejected. That case is
   real — the Companion app bug in 0.7.1 wrote this add-on's `mcp_url` into
   `api_keys.ned_api_key`, and a presence-only check accepted it, publishing
   a tool backed by a URL. Rejections are logged and shown on the dashboard
   with the reason, so a mis-pasted value is visible rather than silent.
2. **Which keys does the tool need?** Taken from upstream's own tool
   descriptions (each gated tool says "Requires `X_API_KEY`"), unioned with
   a hand-maintained list in `gateway.mjs`. The description scan is what
   keeps this honest across upstream updates: a key-gated tool added in a
   future pin is withheld automatically instead of leaking until someone
   re-reads upstream's `tools.ts`.

`bag_address_detail` is explicitly exempt from (2). Its description mentions
`BAG_API_KEY`, but upstream states it falls back to Locatieserver-only data
rather than failing, so hiding it would remove working functionality.

What this does *not* do is verify a key actually works — a syntactically
plausible but wrong or expired key still publishes its tools, and they'll
fail when called. Catching that needs a live authenticated request per
source at every boot, which would make the tool set depend on network
conditions at startup. Ask if you'd like that added.

## Status dashboard (Ingress)

Open the add-on from the Home Assistant sidebar (or **Settings → Add-ons →
Dutch Open Data MCP → Open Web UI**) for a small status page: which sources
are configured, which tools are currently published or withheld and why,
and the MCP URL to copy.

You can also **set the API keys** from this page. They are written through
Supervisor into this add-on's own options — the same store the Configuration
tab writes to, so the two never hold different values and you can use
whichever is convenient. Keys are read into the environment at startup and
the tool set is resolved there, so a save needs a restart to take effect;
there's a button for that below the form. The status table underneath shows
what's *currently active* (the startup snapshot), deliberately separate from
the stored values in the form above — they differ between saving and
restarting.

### Who can see this page

**Ingress is not admin-only.** Home Assistant authenticates the visitor and
then tells the add-on nothing about them — the only header it adds is
`X-Ingress-Path`. `panel_admin: true` hides the *sidebar entry* from
non-admins, but it does not restrict the ingress URL itself, so any
logged-in user of your Home Assistant can open this page.

Because of that, the dashboard does **not** show secrets by default:

- The bearer token is not rendered; it lives in the Configuration tab,
  which *is* admin-only.
- Key fields are **write-only** — blank, with a placeholder saying whether
  a key is set. You can set or replace a key, but not read one back. A
  blank field means "leave unchanged", so pressing Save never wipes keys.
  Clearing a key is done from the Configuration tab.

Set `show_secrets_in_ui: true` if every Home Assistant user on your install
is trusted with those values; then the token and stored keys are shown and
a blank field clears a key.

The page is served by a **second, ingress-only port** (`8099`,
`app/gateway.mjs`'s `webApp`), deliberately not listed in `config.yaml`'s
`ports`, so it is never reachable from your LAN or through the tunnel —
those only reach port `8098`. On top of that the app rejects any connection
whose source address is not the Supervisor ingress proxy (`172.30.32.2`),
as Home Assistant requires, because an unpublished port is still reachable
from other containers on the same Docker network — and this page can write
API keys and restart the add-on.

## Exposing it to the internet (Cloudflare Tunnel or any proxy)

You only need this if a client outside your network must reach the server.
For a client on your own LAN, `http://<HA host>:8098/mcp` is enough.

The add-on listens on port **8098** for MCP traffic (published to the same
host port by default; change it in the add-on's Network tab if it clashes).
That port deliberately does **not** go through Home Assistant Ingress — MCP
clients need a plain URL and a token, not an authenticated browser session.
Ingress serves only the separate status dashboard, on its own port.

Give the add-on **its own subdomain**, e.g. `nlgov-mcp.example.com`, not a
path under the hostname you already use for Home Assistant. Each MCP add-on
you run (this one, the Picnic MCP add-on, …) gets its own hostname, so they
stay fully independent — each serves at the root of its hostname with its
own token and OAuth login, and stopping one never affects another. A
subdomain costs one extra route in your tunnel and nothing else.

### Cloudflare Tunnel

You need a domain whose DNS is on Cloudflare, and the **Cloudflared**
add-on (repository `https://github.com/homeassistant-apps/repository`).
Cloudflared opens an outbound tunnel, so no ports are opened on your
router. How you add a hostname depends on how the tunnel is set up:

**A. Tunnel managed in the Cloudflare dashboard** — the Cloudflared add-on
has a `tunnel_token` in its Configuration. Routes live in Cloudflare:

1. In the Cloudflare dashboard open **Zero Trust → Networks → Tunnels**,
   pick your tunnel, then **Edit**.
2. Open **Public hostnames** (called **Published application routes** in
   newer dashboards) and **Add a public hostname**:
   - *Subdomain* `nlgov-mcp` (or whatever you prefer), *Domain* your
     domain, *Path* empty.
   - *Service type* `HTTP`, *URL* `<HA host>:8098` — the LAN address your
     other hostnames already point at, with port 8098.
   - HTTP, not HTTPS: Cloudflare terminates TLS; the hop inside your
     network is plain HTTP.
3. **Save.** Cloudflare creates the DNS record itself (a proxied `CNAME` to
   `<tunnel-id>.cfargotunnel.com`) and the running Cloudflared add-on picks
   up the new route without a restart.

**B. Tunnel configured in the Cloudflared add-on** — no `tunnel_token`.
Add the hostname to the add-on's `additional_hosts` and restart Cloudflared:

```yaml
additional_hosts:
  - hostname: nlgov-mcp.example.com
    service: http://<HA host>:8098
```

**Then, either way:**

1. Set `mcp_url` in this add-on's Configuration to the full endpoint,
   `https://nlgov-mcp.example.com/mcp`. The add-on uses it as the OAuth
   issuer, so it must match what clients actually call.
2. Restart the add-on and open `https://nlgov-mcp.example.com/health` — it
   should answer `{"ok":true,...}`.
3. Connect your client (see *Connecting a client*).

If you change the add-on's host port in the Network tab, update the
tunnel's service URL to match.

**Troubleshooting**

| You see | Likely cause |
|---|---|
| `502` / *Bad gateway* at `/health` | The add-on isn't running, or the service URL has the wrong IP or port. |
| Cloudflare error *1033* | The tunnel itself is down — check the Cloudflared add-on's log. |
| `401` on `/mcp` in a browser | Expected — the endpoint needs a token. |
| Claude can't connect, `/health` works | Check that `mcp_url` is exactly the URL you gave Claude. Cloudflare **Access** or a bot challenge in front of the hostname will also block Claude's login flow. |

### Not using Cloudflare?

Nothing here is Cloudflare-specific. Any reverse proxy works as long as it
terminates TLS and forwards to `<HA host>:8098`. Two requirements:

- **Forward the `Authorization` header unchanged** — it carries the bearer
  token. Proxies that strip it will make every request look unauthenticated.
- **Don't buffer responses.** The Streamable HTTP and SSE transports stream;
  a proxy that buffers will make clients look like they hang. For nginx that
  means `proxy_buffering off;`.

## Connecting a client

**Clients with a plain header/URL field** (Claude Desktop's `mcpServers`
config, curl, scripts, Open WebUI): use `https://nlgov-mcp.example.com/mcp`
(or `/sse` for the legacy transport) with `Authorization: Bearer <token>`,
`<token>` being whatever the Configuration tab shows for `mcp_auth_token`.
Nothing below applies to these — they keep working exactly as before.

**Claude (web, desktop, iOS, Android):** on claude.ai go to **Settings →
Connectors → Add custom connector**, enter
`https://nlgov-mcp.example.com/mcp` and press **Connect**, then paste
`mcp_auth_token` on the page that opens. Connectors added on claude.ai
appear in the desktop and mobile apps as well. What happens underneath:

**Clients that only offer "OAuth"** (no header field — e.g. the Claude
apps, and likely other mobile/managed MCP connector UIs): add
`https://nlgov-mcp.example.com/mcp` as the connector URL and start the
connection. The client will:

1. Get a `401` from `/mcp` with a `WWW-Authenticate` header pointing at
   `/.well-known/oauth-protected-resource`, discover
   `/.well-known/oauth-authorization-server` from there, and register
   itself via `POST /register` (Dynamic Client Registration, RFC 7591) —
   no manual client ID/secret entry needed.
2. Open `/authorize` in an in-app browser. This shows a small consent page
   asking for **the same `mcp_auth_token`** shown in Configuration or on
   the ingress dashboard — type it in once.
3. Exchange the resulting code for an access + refresh token
   (`POST /token`, PKCE-verified, no client secret — this is a public
   client). The client stores these itself and refreshes silently from
   then on; you won't be asked again unless you revoke.

The static `mcp_auth_token` is never handed to the client itself — only
used once, server-side, to approve the OAuth grant. Revoke everything
issued this way at any time from the ingress dashboard ("Trek alle
OAuth-tokens in" / "Revoke all OAuth tokens"); this clears every OAuth
access/refresh token but leaves registered client IDs in place; the
static `mcp_auth_token` itself is completely unaffected either way.

Implementation: `app/oauth.mjs`, a minimal single-user OAuth 2.1
authorization server — opaque server-side tokens (no JWT/signing), a
single fixed `mcp` scope, and a flat JSON file
(`/data/oauth-store.json`, persists across restarts/updates) for
registered clients and issued tokens. Tokens are stored only as SHA-256
hashes, so the file is useless to anyone who gets hold of a Home Assistant
backup. Refresh tokens rotate on every use and expire after 90 days unused.
See the comment at the top of that file for the reasoning.

## Security

### What is exposed where

| Port | Reachable from | Protection |
|---|---|---|
| `8098` `/mcp`, `/sse`, `/messages` | Your LAN, and the internet if you put a tunnel/proxy in front | Bearer token, or an OAuth-issued token |
| `8098` `/authorize`, `/token`, `/register`, `/.well-known/*` | Same | Public by design (OAuth discovery/registration). `/authorize` requires the bearer token to approve a client |
| `8098` `/health` | Same | None — returns only `{"ok":true}` |
| `8098` `/health/sources` | Same | Bearer token |
| `8099` dashboard | Home Assistant Ingress only | Ingress session **+** source-address check; secrets hidden unless `show_secrets_in_ui` |

Note the first row carefully: **publishing port 8098 makes it reachable
from your whole LAN**, tunnel or not. The bearer token is the only thing
protecting it there.

### What an attacker gets with the token

Read-only queries against Dutch government open data, executed with *your*
API keys — so the realistic damage is your rate limits and quotas being
consumed, and your IP making the requests. The add-on holds no personal
data of yours beyond the keys themselves, and every upstream tool is
read-only. It cannot reach Home Assistant: `homeassistant_api` is off, and
the Supervisor access it does have is limited to its own options and its
own restart.

### Keeping it safe

- **Leave the generated token alone.** It is 256-bit random. If you replace
  it with something memorable, you have replaced the only lock on the
  internet-facing endpoint. There is a throttle on `/authorize`, but it
  cannot save a weak token from an attacker who can reach `/mcp` directly.
- **Consider not exposing it at all.** If your MCP client runs on your own
  network, skip the tunnel entirely and point it at `http://<HA host>:8098`.
- **Consider Cloudflare Access** (Zero Trust → Access → Applications) in
  front of the hostname, so a request must pass identity checks before it
  ever reaches the add-on. Note that Access will interfere with the OAuth
  flow for mobile clients, so this suits header-based clients best.
- **Rotate a key** by pasting a new value in Configuration or the dashboard
  and restarting. Rotate the bearer token the same way; any OAuth clients
  keep working, because their tokens are separate — use "revoke all OAuth
  tokens" on the dashboard for those.
- **Keep the add-on updated**: it pins upstream NL-GOV-MCP to a specific
  commit, so upstream fixes only arrive when this add-on bumps that pin.

### Where your secrets live

`mcp_auth_token` and every `api_keys.*` value live only in this add-on's
options, which Supervisor stores in `/data/options.json` on your own host —
the same place every add-on keeps its secrets. Nothing is sent anywhere
else, and nothing is written to the add-on's log. `config.yaml` ships every
one of those fields blank, so nothing is baked into the image or the
repository. OAuth clients and the tokens issued to them live beside it in
`/data/oauth-store.json` (mode `0600`), as SHA-256 hashes rather than the
tokens themselves — `/data` is included in every Home Assistant backup.

Upstream tool calls do send your API key to the relevant government API —
that is the point of the key — over HTTPS, to that API only.

## Development notes

- `app/gateway.mjs` + `app/oauth.mjs` are the entire add-on. `gateway.mjs`
  imports upstream's `createServer()`/`getAllConnectorHealth()` and
  monkey-patches `McpServer.prototype.registerTool` to implement gating
  (see the comment at the top of that file for why). It runs two
  independent Express apps in one process: `app` (port `8098`,
  bearer-or-OAuth-protected, MCP + health + the OAuth router from
  `oauth.mjs`) and `webApp` (port `8099`, ingress-only, the dashboard) —
  keep that split when adding routes; nothing that should require
  ingress-level trust belongs on the `8098` app, and nothing
  bearer-protected belongs on `webApp`.
- `app/oauth.mjs` is self-contained (its own persistence, its own consent
  HTML) and exposes exactly four things to `gateway.mjs`:
  `createOAuthRouter` (mounted on `app`), `isValidOAuthAccessToken` (used
  by `requireBearerAuth`), and `listOAuthClients` /
  `revokeAllOAuthTokens` (used by the ingress dashboard).
- To pick up upstream changes: bump the commit hash in
  `app/package.json`'s `nl-gov-mcp` git dependency, re-check `GATED_TOOLS`
  in `gateway.mjs` against upstream's `src/tools.ts` for any newly
  key-gated tools, bump this add-on's `version` in `config.yaml`, and add a
  `CHANGELOG.md` entry.
