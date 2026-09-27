// Thin gateway around the upstream NL-GOV-MCP server (WAINUTAI/NL-GOV-MCP,
// vendored as a git dependency, see package.json).
//
// It adds two things the upstream server does not do on its own:
//   1. Bearer-token auth in front of the externally-reachable /mcp and
//      /sse|/messages endpoints (upstream ships with none at all).
//   2. Tool-level gating: a source whose required API key is missing is
//      removed from the MCP tool list entirely, instead of being listed and
//      failing with a "not_configured" error the first time a client calls
//      it. This is done by monkey-patching McpServer.prototype.registerTool
//      before upstream's own createServer() runs, rather than by forking
//      upstream's ~3300-line tools.ts — that keeps this gateway trivial to
//      re-point at a newer upstream commit.
//
// GATED_TOOLS below was derived by reading upstream's src/tools.ts (commit
// pinned in package.json) for every tool whose handler hard-fails with
// error "not_configured" when a given env var is absent. Tools that merely
// degrade gracefully without a key (e.g. bag_address_detail, or the
// OVERHEID_API_KEY-enrichment inside overheidsorganisaties_search /
// nl_gov_ask) are intentionally NOT listed here, since they still return
// useful results without the key. If upstream adds new key-gated tools in a
// later commit, add them here too.
import { randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer as createUpstreamServer } from "nl-gov-mcp/dist/src/server.js";
import { getAllConnectorHealth } from "nl-gov-mcp/dist/src/utils/connector-runtime.js";
import {
  createOAuthRouter,
  isValidOAuthAccessToken,
  listOAuthClients,
  revokeAllOAuthTokens,
} from "./oauth.mjs";

const PORT = Number(process.env.NL_GOV_HTTP_PORT ?? 8098);
const INGRESS_PORT = Number(process.env.INGRESS_PORT ?? 8099);
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN ?? "";
const MCP_URL = process.env.MCP_URL ?? "";
const LOG_LEVEL = process.env.LOG_LEVEL ?? "info";

// The public origin OAuth discovery should advertise, taken from the
// operator's configured mcp_url rather than from the request, which can
// carry a forwarded Host the caller chose. Blank when mcp_url is unset, in
// which case the request host is used instead.
const PUBLIC_ORIGIN = (() => {
  try {
    return MCP_URL ? new URL(MCP_URL).origin : "";
  } catch {
    log("warning", "mcp_url is not a valid URL; OAuth metadata will use the request host", { mcp_url: MCP_URL });
    return "";
  }
})();

// Supervisor's internal API, same one run.sh writes the generated bearer
// token through. Used so the ingress dashboard can save API keys into the
// add-on's own options — i.e. the exact same store the Configuration tab
// writes to, not a second copy that could drift out of sync. The base URL
// is overridable for local testing, matching bashio's own convention.
// Home Assistant Ingress authenticates the user but tells the add-on
// nothing about them: the only header it adds is X-Ingress-Path, and
// `panel_admin` merely hides the sidebar entry from non-admins — it does not
// restrict the ingress URL itself. So this add-on cannot tell an admin from
// any other logged-in household member, and anything it renders is readable
// by all of them. Secrets are therefore hidden unless the operator (who
// edits Configuration, which IS admin-only) opts in. With it off, keys stay
// write-only: settable from the dashboard, never echoed back.
const SHOW_SECRETS = /^(true|yes|1)$/i.test(process.env.SHOW_SECRETS_IN_UI ?? "");
// Escape hatch for running the dashboard outside Supervisor (local dev).
const ALLOW_ANY_INGRESS_SOURCE = /^(true|yes|1)$/i.test(process.env.ALLOW_ANY_INGRESS_SOURCE ?? "");

const SUPERVISOR_API = process.env.SUPERVISOR_API ?? "http://supervisor";
const SUPERVISOR_TOKEN = process.env.SUPERVISOR_TOKEN ?? "";
const OPTIONS_PATH = process.env.OPTIONS_PATH ?? "/data/options.json";

/** The add-on's current options as Supervisor has them stored. */
function readStoredOptions() {
  try {
    return JSON.parse(fs.readFileSync(OPTIONS_PATH, "utf8"));
  } catch (err) {
    log("warning", "Could not read stored options", { path: OPTIONS_PATH, err: String(err) });
    return {};
  }
}

async function supervisorPost(path, body) {
  if (!SUPERVISOR_TOKEN) {
    throw new Error("SUPERVISOR_TOKEN is not set — is hassio_api still enabled in config.yaml?");
  }
  const res = await fetch(`${SUPERVISOR_API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SUPERVISOR_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Supervisor ${path} → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return res.json().catch(() => ({}));
}

// Metadata for the dashboard: which option unlocks which tools, and where
// to get a free key. Kept in sync by hand with GATED_TOOLS above and with
// DOCS.md's "Which tools need a key" table.
const SOURCE_INFO = [
  { envVar: "KNMI_API_KEY", label: "KNMI (weer)", url: "https://developer.dataplatform.knmi.nl/" },
  { envVar: "OVERHEID_API_KEY", label: "Overheid API-register", url: "https://developer.overheid.nl/" },
  { envVar: "DSO_API_KEY", label: "DSO Omgevingsdocumenten", url: "https://developer.omgevingswet.overheid.nl/formulieren/api-key-aanvragen-0/" },
  { envVar: "NED_API_KEY", label: "NED (Nationaal Energie Dashboard)", url: "https://ned.nl/nl/api" },
  { envVar: "EP_ONLINE_API_KEY", label: "EP-Online (energielabels)", url: "https://www.ep-online.nl/" },
  { envVar: "NS_API_KEY", label: "NS Reisinformatie", url: "https://apiportal.ns.nl/" },
  { envVar: "DNB_API_KEY", label: "DNB Statistics", url: "https://api.portal.dnb.nl/" },
  { envVar: "BAG_API_KEY", label: "BAG (adresdetails — altijd actief, deze sleutel verbetert alleen de kwaliteit)", url: "https://formulieren.kadaster.nl/aanvraag_bag_api_individuele_bevragingen_1" },
];

// Known key-gated tools, derived by reading upstream's src/tools.ts (pinned
// commit in package.json) for every handler that hard-fails with
// error "not_configured" when an env var is absent. This is the backstop;
// the primary gate is the description scan below, which also catches tools
// upstream adds later without anyone updating this list.
const GATED_TOOLS = {
  knmi_datasets: "KNMI_API_KEY",
  knmi_search_datasets: "KNMI_API_KEY",
  knmi_latest_files: "KNMI_API_KEY",
  knmi_latest_observations: "KNMI_API_KEY",
  knmi_warnings: "KNMI_API_KEY",
  knmi_earthquakes: "KNMI_API_KEY",
  overheid_api_register_search: "OVERHEID_API_KEY",
  dso_omgevingsdocumenten_search: "DSO_API_KEY",
  ned_energie_search: "NED_API_KEY",
  ep_online_energielabel: "EP_ONLINE_API_KEY",
  ns_reisinformatie: "NS_API_KEY",
  dnb_statistics_search: "DNB_API_KEY",
};

// Tools whose description names a key but which genuinely work without it,
// returning less detail rather than an error. Upstream says so explicitly
// for bag_address_detail: "Requires BAG_API_KEY for full detail; falls back
// to Locatieserver-only when missing." Hiding these would remove working
// functionality, so they are exempt from the description scan.
const DEGRADES_GRACEFULLY = new Set(["bag_address_detail"]);

const API_KEY_PATTERN = /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_API_KEY)\b/g;

/**
 * A key counts as configured only if it could plausibly BE a key.
 * "Non-empty" is not enough: Home Assistant's Companion app has a config-form
 * bug that wrote this add-on's mcp_url into api_keys.ned_api_key, which the
 * old presence-only check happily accepted — publishing a tool backed by a
 * credential that is actually a URL. Whitespace-only values came through the
 * same way.
 */
function inspectKey(envVar) {
  const raw = process.env[envVar];
  if (raw === undefined) return { configured: false, reason: "not set" };
  const value = raw.trim();
  if (value === "") return { configured: false, reason: "empty" };
  if (/^https?:\/\//i.test(value)) {
    return { configured: false, reason: "looks like a URL, not an API key — check that the right value was pasted into this field" };
  }
  return { configured: true };
}

// Resolved once at startup so the published tool set is identical for every
// MCP session this process serves, and so problems are reported once.
const keyStatus = new Map();
function isKeyConfigured(envVar) {
  if (!keyStatus.has(envVar)) keyStatus.set(envVar, inspectKey(envVar));
  return keyStatus.get(envVar).configured;
}

/** Every API key a tool needs, from upstream's own description plus our map. */
function requiredKeysFor(name, description) {
  const keys = new Set();
  if (GATED_TOOLS[name]) keys.add(GATED_TOOLS[name]);
  if (!DEGRADES_GRACEFULLY.has(name)) {
    for (const [, key] of String(description ?? "").matchAll(API_KEY_PATTERN)) keys.add(key);
  }
  return [...keys];
}

function log(level, msg, extra) {
  const order = { debug: 0, info: 1, warning: 2, error: 3 };
  if ((order[level] ?? 1) < (order[LOG_LEVEL] ?? 1)) return;
  const line = { time: new Date().toISOString(), level, msg, ...extra };
  process.stderr.write(JSON.stringify(line) + "\n");
}

/* ------------------------------------------------------------------ */
/* Tool gating: patch registerTool once, before any McpServer is built */
/* ------------------------------------------------------------------ */

const skippedTools = [];
const enabledGatedTools = [];
const publishedTools = [];
const originalRegisterTool = McpServer.prototype.registerTool;
McpServer.prototype.registerTool = function patchedRegisterTool(name, config, ...rest) {
  const required = requiredKeysFor(name, config?.description);
  const missing = required.filter((key) => !isKeyConfigured(key));

  if (missing.length > 0) {
    if (!skippedTools.some((t) => t.tool === name)) {
      skippedTools.push({
        tool: name,
        requires: missing.join(", "),
        reason: missing.map((key) => `${key}: ${keyStatus.get(key).reason}`).join("; "),
      });
    }
    // Don't call through: the tool is simply never registered on this
    // McpServer instance, so it never appears in tools/list and can never
    // be called.
    return undefined;
  }

  if (required.length > 0 && !enabledGatedTools.includes(name)) enabledGatedTools.push(name);
  if (!publishedTools.includes(name)) publishedTools.push(name);
  return originalRegisterTool.call(this, name, config, ...rest);
};

function createServer() {
  return createUpstreamServer();
}

// Resolve the published tool set at startup rather than on first client
// connection: build one server, which runs every registerTool through the
// gate above, then throw it away. Every later session registers the same
// set, so what a client sees is decided here, once, and reported below.
{
  const probe = createServer();
  probe.close().catch(() => undefined);

  for (const { envVar, label } of SOURCE_INFO) {
    const status = keyStatus.get(envVar);
    if (status && !status.configured && status.reason !== "not set" && status.reason !== "empty") {
      log("warning", `Ignoring ${envVar}: ${status.reason}`, { source: label });
    }
  }

  // Surfaced because nothing else would: npm only warns about engines, so an
  // unsupported Node silently "works" until some upstream code path doesn't.
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor < 22) {
    log("warning", `Running on Node ${process.versions.node}, but nl-gov-mcp asks for >=22`, {
      hint: "Bump build_from in build.yaml to an Alpine release that ships Node 22+",
    });
  } else {
    log("info", `Node ${process.versions.node} satisfies nl-gov-mcp's >=22 requirement`);
  }

  if (skippedTools.length > 0) {
    log("warning", "Not publishing these tools over MCP — their API key is not usable", {
      skipped: skippedTools,
    });
  }
  log("info", "Tool set resolved at startup", {
    published: publishedTools.length,
    withheld: skippedTools.length,
    publishedNeedingAKey: enabledGatedTools,
  });
}

/* ------------------------------------------------------------------ */
/* Auth                                                                */
/* ------------------------------------------------------------------ */

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function requireBearerAuth(req, res, next) {
  const header = req.headers["authorization"] ?? "";
  const [scheme, token] = header.split(" ");
  // Accepts either the static shared secret (existing clients: Claude
  // Desktop config, curl, scripts) or a token minted by the OAuth flow in
  // oauth.mjs (clients that only support OAuth, e.g. the Claude iOS app).
  const valid = scheme === "Bearer" && Boolean(token) && (
    timingSafeEqualStr(token, AUTH_TOKEN) || isValidOAuthAccessToken(token)
  );
  if (!valid) {
    // Points MCP clients that speak the MCP Authorization spec at OAuth
    // discovery instead of just failing (RFC 9728 §5.1).
    const origin = PUBLIC_ORIGIN || `${req.protocol}://${req.get("host")}`;
    res.set("WWW-Authenticate", `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`);
    res.status(401).json({ error: "unauthorized", message: "Missing or invalid bearer token" });
    return;
  }
  next();
}

/* ------------------------------------------------------------------ */
/* Express app                                                        */
/* ------------------------------------------------------------------ */

const app = express();
// Cloudflare Tunnel terminates TLS and forwards X-Forwarded-Proto/-For; without
// this, req.protocol would report "http" and OAuth metadata would advertise
// the wrong (non-https) issuer/endpoint URLs.
app.set("trust proxy", true);
app.use(express.json({ limit: "1mb" }));
app.disable("x-powered-by");

app.use(createOAuthRouter({ getAuthToken: () => AUTH_TOKEN, log, publicOrigin: PUBLIC_ORIGIN }));

const activeTransports = new Set();
const activeMcpServers = new Set();

function trackServer(server, transport) {
  activeMcpServers.add(server);
  activeTransports.add(transport);
}
function untrackServer(server, transport) {
  activeMcpServers.delete(server);
  activeTransports.delete(transport);
}

// Liveness only, deliberately contentless: this is the one endpoint on the
// internet-facing port that needs no credentials, so it must not describe
// the installation. Uptime monitors and the tunnel use it.
app.get("/health", (_req, res) => {
  res.json({ ok: true, name: "dutch-open-data-mcp" });
});

// Authenticated: it reports which sources the operator configured and which
// tools exist, which is a map of the install that an anonymous caller on the
// public hostname has no business reading. The same detail is on the ingress
// dashboard without needing the token.
app.get("/health/sources", requireBearerAuth, (_req, res) => {
  res.json({
    ok: true,
    name: "dutch-open-data-mcp",
    connectors: getAllConnectorHealth(),
    gating: {
      published_count: publishedTools.length,
      published: publishedTools,
      disabled_missing_key: skippedTools,
      enabled_key_gated: enabledGatedTools,
    },
  });
});

/* ------------------------------------------------------------------ */
/* Ingress dashboard (separate app + port — see below for why)        */
/* ------------------------------------------------------------------ */

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function renderDashboard({ banner } = {}) {
  // Editable values come from the stored options, not from process.env:
  // env is the snapshot taken at startup, so right after a save (before a
  // restart) it is stale, while options.json is what is actually stored.
  const storedKeys = readStoredOptions().api_keys ?? {};
  const keyFields = SOURCE_INFO.map(({ envVar, label, url }) => {
    const field = envVar.toLowerCase();
    const stored = typeof storedKeys[field] === "string" ? storedKeys[field].trim() : "";
    const link = url ? ` <a href="${escapeHtml(url)}" target="_blank" rel="noopener">sleutel aanvragen ↗</a>` : "";
    // Write-only unless secrets are explicitly exposed: the field is empty
    // and a blank submit leaves the stored key untouched (see /save-keys),
    // so a key can be set or replaced here but never read back out.
    const value = SHOW_SECRETS ? stored : "";
    const placeholder = SHOW_SECRETS ? "" : stored ? "•••••••• (ingesteld — leeg laten om te behouden)" : "niet ingesteld";
    const reveal = SHOW_SECRETS
      ? `<button type="button" onclick="const i=document.getElementById('f_${escapeHtml(field)}'); i.type = i.type === 'password' ? 'text' : 'password'">Toon</button>`
      : "";
    return `<div class="keyrow">
      <label for="f_${escapeHtml(field)}"><code>${escapeHtml(field)}</code> — ${escapeHtml(label)}${link}</label>
      <div class="field">
        <input class="mono" type="password" id="f_${escapeHtml(field)}" name="${escapeHtml(field)}" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" autocomplete="off" spellcheck="false">
        ${reveal}
      </div>
    </div>`;
  }).join("\n");

  const sourceRows = SOURCE_INFO.map(({ envVar, label, url }) => {
    const info = keyStatus.get(envVar) ?? inspectKey(envVar);
    const rejected = !info.configured && info.reason !== "not set" && info.reason !== "empty";
    const status = info.configured
      ? '<span class="ok">● geconfigureerd</span>'
      : rejected
      ? `<span class="bad">● genegeerd — ${escapeHtml(info.reason)}</span>`
      : '<span class="off">○ niet ingesteld</span>';
    const link = url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">sleutel aanvragen</a>` : "";
    return `<tr><td>${escapeHtml(label)}</td><td>${status}</td><td>${link}</td></tr>`;
  }).join("\n");

  const disabledList = skippedTools.length
    ? `<ul>${skippedTools.map((t) => `<li><code>${escapeHtml(t.tool)}</code> — ${escapeHtml(t.reason)}</li>`).join("")}</ul>`
    : "<p>Alle tools met een optionele sleutel zijn actief.</p>";

  const clients = listOAuthClients();
  const clientRows = clients.length
    ? clients.map((c) => `<tr><td>${escapeHtml(c.client_name || "(naamloos)")}</td><td>${escapeHtml(new Date(c.created_at).toLocaleString("nl-NL"))}</td></tr>`).join("\n")
    : `<tr><td colspan="2">Nog geen clients via OAuth gekoppeld.</td></tr>`;

  return `<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dutch Open Data MCP</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 760px; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.4rem; }
  h2 { font-size: 1.05rem; margin-top: 2rem; border-bottom: 1px solid color-mix(in srgb, currentColor 20%, transparent); padding-bottom: .3rem; }
  code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  table { width: 100%; border-collapse: collapse; margin-top: .5rem; }
  td, th { text-align: left; padding: .35rem .5rem; border-bottom: 1px solid color-mix(in srgb, currentColor 10%, transparent); font-size: .92rem; }
  .ok { color: #1a7f37; } .off { color: #999; } .bad { color: #c0392b; }
  .field { display: flex; gap: .5rem; align-items: center; margin: .5rem 0; }
  .field input { flex: 1; font-family: inherit; padding: .4rem .5rem; border-radius: 6px; border: 1px solid color-mix(in srgb, currentColor 25%, transparent); background: transparent; color: inherit; }
  button { padding: .4rem .7rem; border-radius: 6px; border: 1px solid color-mix(in srgb, currentColor 25%, transparent); background: transparent; color: inherit; cursor: pointer; }
  .warn { font-size: .85rem; opacity: .8; }
  a { color: inherit; }
  .keyrow { margin: .9rem 0; }
  .keyrow label { display: block; font-size: .85rem; margin-bottom: .2rem; }
  .actions { margin: 1rem 0; }
  .banner { padding: .6rem .8rem; border-radius: 6px; margin: 1rem 0; font-size: .9rem; }
  .banner.good { border: 1px solid #1a7f37; }
  .banner.err { border: 1px solid #c0392b; }
</style>
</head>
<body>
  <h1>Dutch Open Data MCP</h1>
  ${banner ?? ""}
  <p class="warn">Let op: Home Assistant Ingress geeft deze pagina aan <em>iedere</em> ingelogde
  gebruiker, niet alleen aan beheerders — Ingress vertelt een add-on niets over wie er kijkt.
  Daarom worden geheimen hier standaard niet getoond. Zet <code>show_secrets_in_ui</code> aan
  in Configuratie (alleen beheerders) als je ze hier wél wilt zien.</p>

  <h2>Verbindingsgegevens voor je MCP-client</h2>
  <div class="field">
    <input class="mono" readonly value="${escapeHtml(MCP_URL || "(stel mcp_url in via Configuratie)")}" onclick="this.select()">
    <button onclick="navigator.clipboard.writeText(this.previousElementSibling.value)">Kopieer URL</button>
  </div>
  ${SHOW_SECRETS ? `<div class="field">
    <input class="mono" readonly type="password" value="${escapeHtml(AUTH_TOKEN)}" onclick="this.select()" id="tok">
    <button onclick="document.getElementById('tok').type = document.getElementById('tok').type === 'password' ? 'text' : 'password'">Toon/verberg</button>
    <button onclick="navigator.clipboard.writeText(document.getElementById('tok').value)">Kopieer token</button>
  </div>` : `<p class="warn">Het bearer-token staat in het tabblad <strong>Configuratie</strong>
  (<code>mcp_auth_token</code>), dat alleen voor beheerders is.</p>`}
  <p class="warn">Stuur het token als <code>Authorization: Bearer &lt;token&gt;</code> header — nooit als onderdeel van de URL.</p>

  <h2>Clients zonder headerondersteuning (bijv. Claude iOS)</h2>
  <p>Voeg hierboven de URL toe als connector. Als de app alleen "OAuth"
  aanbiedt in plaats van een header-veld, opent hij vanzelf een
  inlogscherm dat om dit <strong>zelfde bearer-token</strong> vraagt — daarna
  hoef je niets handmatig te kopiëren.</p>
  <table>
    <tr><th>Client</th><th>Gekoppeld op</th></tr>
    ${clientRows}
  </table>
  <form method="post" action="revoke-oauth" onsubmit="return confirm('Alle via OAuth uitgegeven tokens intrekken? Gekoppelde apps moeten dan opnieuw autoriseren.')">
    <button type="submit">Trek alle OAuth-tokens in</button>
  </form>

  <h2>API-sleutels</h2>
  <p class="warn">Deze velden schrijven naar exact dezelfde opslag als het tabblad
  Configuratie (de opties van deze add-on, beheerd door Supervisor) — je kunt dus
  beide door elkaar gebruiken. Leeg laten = bron overslaan; die tools worden dan
  niet over MCP gepubliceerd.</p>
  <form method="post" action="save-keys">
    ${keyFields}
    <div class="actions">
      <button type="submit">Opslaan</button>
    </div>
  </form>
  <p class="warn">Na opslaan is een herstart nodig voordat de wijziging effect heeft:
  de sleutels worden bij het starten ingelezen en de toollijst wordt dan opnieuw bepaald.</p>
  <form method="post" action="restart" onsubmit="return confirm('Add-on nu herstarten? De verbinding met deze pagina valt even weg.')">
    <div class="actions"><button type="submit">Herstart add-on</button></div>
  </form>

  <h2>Status van de bronnen (zoals nu actief)</h2>
  <p class="warn">Dit is de stand sinds de laatste herstart — niet per se wat hierboven is opgeslagen.</p>
  <table>
    <tr><th>Bron</th><th>Status</th><th></th></tr>
    ${sourceRows}
  </table>

  <h2>Tools die momenteel uitgeschakeld zijn</h2>
  <p class="warn">${publishedTools.length} tools worden gepubliceerd over MCP, ${skippedTools.length} worden achtergehouden.
  Dit wordt bij het starten van de add-on bepaald: een tool waarvan de API-sleutel ontbreekt of onbruikbaar is,
  wordt niet geregistreerd en verschijnt dus ook niet in de toollijst van je client.</p>
  ${disabledList}

  <h2>Meer info</h2>
  <p>
    Volledige documentatie staat in het tabblad <strong>Documentatie</strong> van deze add-on ·
    <a href="https://github.com/WAINUTAI/NL-GOV-MCP" target="_blank" rel="noopener">upstream NL-GOV-MCP</a>
  </p>
</body>
</html>`;
}

const webApp = express();
webApp.disable("x-powered-by");

// Home Assistant requires that an ingress app accept connections ONLY from
// the Supervisor proxy: "Only connections from 172.30.32.2 must be allowed.
// You should deny access to all other IP addresses within your app server."
// That matters here beyond compliance: ingress_port is not published under
// `ports`, but it IS reachable from other containers on the Supervisor's
// Docker network, and this app can read and write API keys and restart the
// add-on. Without this check any other add-on could do the same.
//
// The comparison is against the raw socket address on purpose — never a
// forwarded header, which the caller controls.
const INGRESS_PROXY_IP = "172.30.32.2";
const TRUSTED_INGRESS_IPS = new Set([INGRESS_PROXY_IP, "127.0.0.1", "::1", "::ffff:127.0.0.1"]);

webApp.use((req, res, next) => {
  if (ALLOW_ANY_INGRESS_SOURCE) return next();
  const raw = req.socket.remoteAddress ?? "";
  const normalised = raw.startsWith("::ffff:") ? raw.slice(7) : raw;
  if (TRUSTED_INGRESS_IPS.has(raw) || TRUSTED_INGRESS_IPS.has(normalised)) return next();
  log("warning", "Refused a non-ingress connection to the dashboard", { from: raw, path: req.path });
  res.status(403).type("text/plain").send(
    "This page is only reachable through Home Assistant Ingress — open the add-on from the Home Assistant UI.",
  );
});
webApp.get("/", (req, res) => {
  let banner;
  if (req.query.saved !== undefined) {
    banner = '<div class="banner good">API-sleutels opgeslagen in de add-on-configuratie. Herstart de add-on om ze te activeren.</div>';
  } else if (req.query.restarting !== undefined) {
    banner = '<div class="banner good">Herstart aangevraagd — ververs deze pagina over een paar seconden.</div>';
  } else if (typeof req.query.error === "string") {
    banner = `<div class="banner err">Opslaan mislukt: ${escapeHtml(req.query.error)}</div>`;
  }
  res.type("html").send(renderDashboard({ banner }));
});

// Writes the submitted keys straight into this add-on's own options through
// Supervisor, so the Configuration tab and this page are the same store
// rather than two copies that can disagree.
webApp.post("/save-keys", express.urlencoded({ extended: false }), async (req, res) => {
  try {
    const options = readStoredOptions();
    const apiKeys = { ...(options.api_keys ?? {}) };
    for (const { envVar } of SOURCE_INFO) {
      const field = envVar.toLowerCase();
      if (!(field in req.body)) continue;
      const submitted = String(req.body[field] ?? "").trim();
      // In write-only mode the form never shows the stored key, so a blank
      // field means "unchanged" — treating it as "clear" would wipe every
      // key the moment anyone pressed Save. Clearing a key is done from the
      // Configuration tab, which is admin-only.
      if (!submitted && !SHOW_SECRETS) continue;
      apiKeys[field] = submitted;
    }
    await supervisorPost("/addons/self/options", { options: { ...options, api_keys: apiKeys } });
    const set = Object.entries(apiKeys).filter(([, v]) => v).map(([k]) => k);
    log("info", "API keys saved from the ingress dashboard", { configured: set });
    res.redirect(303, ".?saved");
  } catch (err) {
    log("error", "Saving API keys failed", { err: String(err) });
    res.redirect(303, `.?error=${encodeURIComponent(err.message)}`);
  }
});

webApp.post("/restart", (_req, res) => {
  // Respond first: the restart tears down this very process, so the redirect
  // has to be on the wire before Supervisor stops the container.
  res.redirect(303, ".?restarting");
  setTimeout(() => {
    supervisorPost("/addons/self/restart").catch((err) => {
      log("error", "Restart request failed", { err: String(err) });
    });
  }, 500).unref();
});

webApp.post("/revoke-oauth", express.urlencoded({ extended: false }), (_req, res) => {
  revokeAllOAuthTokens();
  log("info", "All OAuth-issued tokens revoked from the ingress dashboard");
  // Relative, not "/": under ingress this page lives at
  // /api/hassio_ingress/<token>/, so an absolute path would leave it.
  res.redirect(303, ".");
});

const webServer = webApp.listen(INGRESS_PORT, () => {
  log("info", `Ingress dashboard listening on :${INGRESS_PORT}`);
});
webServer.on("error", (err) => {
  log("error", "Ingress dashboard HTTP server error", { err: String(err) });
});

// --- SSE (legacy transport, e.g. Open WebUI) ---
const sseTransports = {};

app.get("/sse", requireBearerAuth, async (_req, res) => {
  const server = createServer();
  const transport = new SSEServerTransport("/messages", res);
  sseTransports[transport.sessionId] = transport;
  trackServer(server, transport);
  transport.onclose = () => {
    delete sseTransports[transport.sessionId];
    untrackServer(server, transport);
    server.close().catch(() => undefined);
  };
  await server.connect(transport);
});

app.post("/messages", requireBearerAuth, async (req, res) => {
  const sessionId = req.query.sessionId;
  if (!sessionId || typeof sessionId !== "string") {
    res.status(400).send("Missing sessionId");
    return;
  }
  const transport = sseTransports[sessionId];
  if (!transport) {
    res.status(404).send("Unknown sessionId");
    return;
  }
  await transport.handlePostMessage(req, res, req.body);
});

// --- Streamable HTTP (MCP spec 2025-03-26) ---
const httpSessions = new Map();

app.all("/mcp", requireBearerAuth, async (req, res) => {
  if (req.method === "DELETE") {
    const sessionId = req.headers["mcp-session-id"];
    const session = sessionId ? httpSessions.get(sessionId) : undefined;
    if (session) {
      await session.transport.close();
      httpSessions.delete(sessionId);
      res.status(200).end();
    } else {
      res.status(404).end();
    }
    return;
  }

  const sessionId = req.headers["mcp-session-id"];
  if (sessionId) {
    const session = httpSessions.get(sessionId);
    if (!session) {
      res.status(404).json({ error: "Unknown session" });
      return;
    }
    await session.transport.handleRequest(req, res, req.body);
    return;
  }

  if (req.method !== "POST") {
    res.status(400).json({ error: "New sessions must be initialized via POST" });
    return;
  }

  const server = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  trackServer(server, transport);
  transport.onclose = () => {
    const sid = transport.sessionId;
    if (sid) httpSessions.delete(sid);
    untrackServer(server, transport);
    server.close().catch(() => undefined);
  };

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);

  const sid = transport.sessionId;
  if (sid && !httpSessions.has(sid)) {
    httpSessions.set(sid, { server, transport });
  }
});

const httpServer = app.listen(PORT, () => {
  log("info", `MCP endpoint listening on :${PORT}`, {
    endpoints: [
      "/mcp", "/sse", "/messages", "/health", "/health/sources",
      "/.well-known/oauth-protected-resource", "/.well-known/oauth-authorization-server",
      "/register", "/authorize", "/token",
    ],
  });
});

httpServer.on("error", (err) => {
  log("error", "HTTP server error", { err: String(err) });
  process.exit(1);
});

/* ------------------------------------------------------------------ */
/* Shutdown                                                            */
/* ------------------------------------------------------------------ */

let shuttingDown = false;
function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("info", "Shutting down…", { reason });

  const drainTimer = setTimeout(() => process.exit(0), 5000);
  drainTimer.unref();

  httpServer.close();
  webServer.close();

  const pending = [];
  for (const transport of activeTransports) {
    pending.push(Promise.resolve(transport.close()).catch(() => undefined));
  }
  for (const server of activeMcpServers) {
    pending.push(server.close().catch(() => undefined));
  }
  activeTransports.clear();
  activeMcpServers.clear();

  Promise.all(pending).finally(() => {
    clearTimeout(drainTimer);
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
