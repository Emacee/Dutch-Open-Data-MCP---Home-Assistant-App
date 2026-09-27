# Dutch Open Data MCP — Home Assistant add-on

Serve **46 Dutch government open-data sources** to AI assistants from your own
Home Assistant, over the [Model Context Protocol](https://modelcontextprotocol.io).
CBS, KNMI, RDW, Tweede Kamer, PDOK/BAG, Rechtspraak, Rijkswaterstaat,
data.overheid.nl, DUO, Eurostat and more — around 74 tools in total.

Ask an assistant *"hoeveel woningen zijn er gebouwd in Utrecht sinds 2020?"* or
*"welke moties zijn er ingediend over stikstof?"* and it queries the actual
registers, with provenance, instead of guessing.

> **Powered by [NL-GOV-MCP](https://github.com/WAINUTAI/NL-GOV-MCP), built by
> [WAINUT](https://wainut.ai).** All the data connectors — the hard part — are
> theirs. This add-on packages their server for Home Assistant and adds
> authentication, per-source gating and a management UI on top. It is an
> independent project: **not affiliated with, endorsed by, or supported by
> WAINUT B.V.** Please direct questions about the connectors themselves
> upstream, and questions about this add-on here.

## What this add-on adds

Upstream NL-GOV-MCP is designed to be run next to a client you trust. Running
it from Home Assistant — potentially reachable from the internet — needs a bit
more, which is what lives here:

- **Authentication.** A bearer token on every MCP endpoint, generated for you
  on first start. Plus an OAuth 2.1 layer (dynamic client registration + PKCE)
  for clients such as the Claude mobile apps that offer no header field.
- **Per-source gating.** A source whose API key you have not configured is
  left out of the tool list entirely, so an assistant never sees a tool that
  would fail when it called it. Most sources need no key at all.
- **A management UI** via Home Assistant Ingress: which sources are
  configured, which tools are published or withheld and why, and somewhere to
  set your API keys.

## Install

> [!NOTE]
> **HACS cannot install this.** HACS handles integrations, dashboard cards,
> themes, templates, python_scripts and AppDaemon apps — not Home Assistant
> add-ons. Add-ons are Supervisor packages and come from the **Add-on Store**.
> The steps below are the add-on equivalent of adding a HACS custom repository.

[![Open your Home Assistant instance and show the add add-on repository dialog with a specific repository URL pre-filled.](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2FEmacee%2FDutch-Open-Data-MCP---Home-Assistant-App)

1. Click the button above, or go to **Settings → Add-ons → Add-on Store → ⋮
   (top right) → Repositories** and add:
   ```
   https://github.com/Emacee/Dutch-Open-Data-MCP---Home-Assistant-App
   ```
2. Refresh the page, find **Dutch Open Data MCP** in the store, and
   click **Install**.
3. **Start** it. On first start it generates a random bearer token and saves it
   into its own configuration — you never have to invent one.
4. Open the **Documentation** tab for configuration, connecting a client, and
   the security notes.

Requires a 64-bit Home Assistant OS/Supervised install (`amd64` or `aarch64`).

## Using it from your own network

Point your MCP client at `http://<home-assistant-host>:8098/mcp` with an
`Authorization: Bearer <token>` header. That is the whole setup — no tunnel,
no certificates, nothing exposed to the internet.

## Using it from outside your network

To reach it from a phone or a hosted assistant you need a way in. The add-on
does not do this itself; use a tunnel or reverse proxy in front of it.

**[Cloudflared add-on](https://github.com/brenner-tobias/ha-addons)** — the
usual choice, and what this add-on is documented against. It opens an outbound
tunnel to Cloudflare, so nothing is port-forwarded and no ports are opened on
your router. You need a domain using Cloudflare for DNS.

```
https://github.com/brenner-tobias/ha-addons
```

Add that repository the same way as above, install **Cloudflared**, then give
this add-on its own hostname (e.g. `mcp.example.com` → `<HA host>:8098`). The
full walkthrough, including what to set for `mcp_url`, is in this add-on's
Documentation tab under *Exposing it to the internet*.

Any other reverse proxy works too, with two requirements: forward the
`Authorization` header unchanged, and don't buffer responses (the MCP
transports stream).

> [!IMPORTANT]
> Exposing this publicly means a bearer token is the only thing between the
> internet and an endpoint that spends **your** API quotas. Read the *Security*
> section of the documentation before you do it — in particular, keep the
> generated token rather than replacing it with something memorable.

## API keys

Most of the ~35 connectors (CBS, RDW, PDOK, Tweede Kamer, Rechtspraak,
data.overheid.nl, Rijkswaterstaat, Luchtmeetnet, DUO, Eurostat…) need **no key
at all** and work immediately.

Eight sources need a personal key, all free to request: KNMI, NS, DNB, DSO,
NED, EP-Online, the Overheid API register, and BAG (which only improves
detail). Leave one blank and its tools are simply not published. The
Documentation tab lists which tools each key unlocks and where to get it.

Keys live only in the add-on's own configuration, stored by Supervisor on your
own host. Nothing is committed to this repository and nothing is sent anywhere
but the relevant government API.

## Credits and licence

- **[NL-GOV-MCP](https://github.com/WAINUTAI/NL-GOV-MCP)** by
  **[WAINUT B.V.](https://wainut.ai)** — the MCP server and all 46 data
  connectors this add-on runs. Licensed Apache-2.0; see [`NOTICE`](NOTICE),
  retained as that licence requires.
- *WAINUT* and *NL-GOV-MCP* are trademarks of WAINUT B.V. They are used here
  descriptively, to say what this add-on runs. This project is not endorsed by
  WAINUT.
- This add-on is licensed [Apache-2.0](LICENSE), matching upstream.
- The data itself comes from Dutch public bodies under their own terms;
  upstream returns provenance with every result.

## Contributing

Issues and pull requests welcome. Bugs in the *connectors or the data* belong
[upstream](https://github.com/WAINUTAI/NL-GOV-MCP/issues); bugs in
packaging, auth, gating or the UI belong here.

Upstream is pinned to a specific commit in
`dutch_open_data_mcp/app/package.json`, so new upstream sources arrive when that
pin is bumped — see *Development notes* in the documentation.
