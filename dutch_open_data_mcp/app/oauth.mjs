// Minimal OAuth 2.1 authorization server for this single-user MCP gateway.
//
// Why this exists: MCP clients that only offer an "OAuth" connector option
// (no raw header field — e.g. the Claude iOS/mobile app) speak the MCP
// Authorization spec, which is OAuth 2.1 + Dynamic Client Registration
// (RFC 7591) + PKCE (RFC 7636), discovered via RFC 9728/RFC 8414 metadata.
// There is no separate identity provider here, so the existing shared
// mcp_auth_token doubles as the login credential on the /authorize consent
// screen: whoever knows that token can approve a new OAuth client, which
// then gets its own opaque access/refresh tokens instead of the shared
// secret itself. gateway.mjs's requireBearerAuth accepts EITHER the static
// mcp_auth_token OR a token issued here, so existing static-header clients
// (Claude Desktop config, curl, scripts) keep working unchanged.
//
// Everything here is intentionally simple: opaque random tokens looked up
// server-side (no JWT/signing), a single fixed scope, no client secrets
// (public clients + PKCE only, as recommended for native/mobile apps), and
// a flat JSON file for persistence — proportionate to a personal, one-user
// deployment, not a multi-tenant identity provider.
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import express from "express";

const STORE_PATH = process.env.OAUTH_STORE_PATH ?? "/data/oauth-store.json";
const STORE_VERSION = 2;
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
// Refresh tokens expire after this long unused. Each use issues a new one
// (rotation, below), so an assistant that is actually being used never hits
// it; a phone you stopped using stops holding a live credential.
const REFRESH_TOKEN_IDLE_MS = 90 * 24 * 60 * 60 * 1000;
const AUTH_CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_CLIENTS = 200; // basic hygiene cap on the persisted client list

/**
 * Tokens are stored as SHA-256 hashes, never as themselves. /data — and so
 * this file — is included in every Home Assistant backup, which people copy
 * to NAS shares and cloud drives. A plaintext store would let anyone holding
 * a backup call /mcp as you until the tokens expired or were revoked; hashes
 * are useless to them. The tokens are 256-bit random, so a plain unsalted
 * hash is enough — there is nothing to brute-force.
 */
function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function emptyStore() {
  return { version: STORE_VERSION, clients: {}, accessTokens: {}, refreshTokens: {} };
}

function loadStore() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
  } catch {
    return emptyStore();
  }
  const loaded = { ...emptyStore(), ...raw };
  if (raw.version !== STORE_VERSION) {
    // v1 keyed tokens by their plaintext value. Re-key by hash so existing
    // clients keep working across the upgrade, then the plaintext is gone
    // from disk on the next save.
    const rekey = (map) => Object.fromEntries(Object.entries(map ?? {}).map(([t, rec]) => [hashToken(t), rec]));
    loaded.accessTokens = rekey(raw.accessTokens);
    loaded.refreshTokens = rekey(raw.refreshTokens);
    loaded.version = STORE_VERSION;
    store = loaded;
    saveStore();
  }
  return loaded;
}

let store;
store = loadStore();

function saveStore() {
  const tmp = `${STORE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, STORE_PATH);
}

function pruneExpired() {
  const now = Date.now();
  for (const [hash, rec] of Object.entries(store.accessTokens)) {
    if (rec.expires_at && rec.expires_at < now) delete store.accessTokens[hash];
  }
  for (const [hash, rec] of Object.entries(store.refreshTokens)) {
    if ((rec.last_used ?? rec.issued_at) + REFRESH_TOKEN_IDLE_MS < now) delete store.refreshTokens[hash];
  }
}

// In-memory only: authorization codes are one-time, short-lived, and
// meaningless to keep across a restart.
const pendingCodes = new Map();

// In-memory brute-force throttle on the master-token login form. The token
// is 256-bit random, so this is defense in depth, not the primary defense.
const authAttempts = new Map();
const MAX_ATTEMPTS = 8;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

function tooManyAttempts(ip) {
  const rec = authAttempts.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.windowStart > ATTEMPT_WINDOW_MS) {
    authAttempts.delete(ip);
    return false;
  }
  return rec.count >= MAX_ATTEMPTS;
}
function recordAttempt(ip) {
  const rec = authAttempts.get(ip);
  if (!rec || Date.now() - rec.windowStart > ATTEMPT_WINDOW_MS) {
    authAttempts.set(ip, { count: 1, windowStart: Date.now() });
  } else {
    rec.count += 1;
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

/**
 * Prefers the operator's configured public URL over the request's own host.
 * With "trust proxy" enabled, req.get("host") honours X-Forwarded-Host, so a
 * caller can otherwise make this server advertise OAuth endpoints on a
 * hostname they chose. Falling back to the request host keeps setups that
 * left mcp_url blank working.
 */
function baseUrl(req, configuredOrigin) {
  if (configuredOrigin) return configuredOrigin;
  return `${req.protocol}://${req.get("host")}`;
}

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function verifyPkce(codeVerifier, codeChallenge) {
  if (!codeVerifier || typeof codeVerifier !== "string") return false;
  const computed = createHash("sha256").update(codeVerifier).digest("base64url");
  return computed === codeChallenge;
}

function consentPage({ clientName, error, formAction, hiddenFields }) {
  const hidden = Object.entries(hiddenFields)
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize — Dutch Open Data MCP</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 420px; margin: 3rem auto; padding: 0 1rem; }
  h1 { font-size: 1.2rem; }
  input[type="password"] { width: 100%; box-sizing: border-box; font-family: ui-monospace, monospace; padding: .6rem; border-radius: 6px; border: 1px solid color-mix(in srgb, currentColor 25%, transparent); background: transparent; color: inherit; margin: .5rem 0 1rem; }
  button { width: 100%; padding: .6rem; border-radius: 6px; border: 1px solid color-mix(in srgb, currentColor 25%, transparent); background: transparent; color: inherit; cursor: pointer; font-size: 1rem; }
  .error { color: #c0392b; font-size: .9rem; }
  p.warn { font-size: .85rem; opacity: .8; }
</style>
</head>
<body>
  <h1>Authorize ${escapeHtml(clientName || "MCP client")}</h1>
  <p>This client wants to query Dutch government open data through your server.</p>
  ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
  <form method="post" action="${escapeHtml(formAction)}">
    ${hidden}
    <label for="token">Bearer token</label>
    <input type="password" id="token" name="token" autocomplete="off" autofocus required>
    <button type="submit">Authorize</button>
  </form>
  <p class="warn">This is the same token shown on this add-on's ingress dashboard
  (Configuration tab, or open the add-on from the Home Assistant sidebar).</p>
</body>
</html>`;
}

/**
 * @param {{ getAuthToken: () => string, log: (level: string, msg: string, extra?: object) => void }} deps
 */
export function createOAuthRouter({ getAuthToken, log, publicOrigin }) {
  const router = express.Router();

  router.use((_req, res, next) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    next();
  });
  router.options(/.*/, (_req, res) => res.sendStatus(204));

  // --- RFC 9728: protected resource metadata (what /mcp points clients at) ---
  router.get("/.well-known/oauth-protected-resource", (req, res) => {
    const base = baseUrl(req, publicOrigin);
    res.json({
      resource: `${base}/mcp`,
      authorization_servers: [base],
    });
  });
  // Some clients look for resource-specific metadata under /mcp too.
  router.get("/.well-known/oauth-protected-resource/mcp", (req, res) => {
    const base = baseUrl(req, publicOrigin);
    res.json({
      resource: `${base}/mcp`,
      authorization_servers: [base],
    });
  });

  // --- RFC 8414: authorization server metadata ---
  router.get("/.well-known/oauth-authorization-server", (req, res) => {
    const base = baseUrl(req, publicOrigin);
    res.json({
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["mcp"],
    });
  });

  // --- RFC 7591: Dynamic Client Registration ---
  router.post("/register", (req, res) => {
    const body = req.body ?? {};
    const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u) => typeof u === "string" && u.length > 0) : [];
    if (redirectUris.length === 0) {
      res.status(400).json({ error: "invalid_client_metadata", error_description: "redirect_uris is required" });
      return;
    }

    const clientIds = Object.keys(store.clients);
    if (clientIds.length >= MAX_CLIENTS) {
      // Registration is unauthenticated by design (RFC 7591), so make room
      // by evicting the oldest client that holds no live refresh token.
      // Plain oldest-first would let anyone flood /register until the
      // client you actually authorised was pushed out.
      const active = new Set(Object.values(store.refreshTokens).map((r) => r.client_id));
      const evictable = clientIds.filter((id) => !active.has(id));
      const pool = evictable.length > 0 ? evictable : clientIds;
      const oldest = pool.reduce((a, b) => (store.clients[a].created_at <= store.clients[b].created_at ? a : b));
      delete store.clients[oldest];
    }

    const clientId = randomBytes(16).toString("hex");
    const record = {
      client_id: clientId,
      client_name: typeof body.client_name === "string" ? body.client_name.slice(0, 200) : undefined,
      redirect_uris: redirectUris,
      created_at: Date.now(),
    };
    store.clients[clientId] = record;
    saveStore();

    log("info", "Registered a new OAuth client", { clientId, clientName: record.client_name });

    res.status(201).json({
      client_id: clientId,
      client_id_issued_at: Math.floor(record.created_at / 1000),
      client_name: record.client_name,
      redirect_uris: redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  });

  // --- /authorize: render a consent form gated by the existing bearer token ---
  router.get("/authorize", (req, res) => {
    const { client_id, redirect_uri, response_type, code_challenge, code_challenge_method, state } = req.query;
    const client = typeof client_id === "string" ? store.clients[client_id] : undefined;

    if (!client) {
      res.status(400).send("Unknown client_id. Try adding the connector again from your MCP client.");
      return;
    }
    if (typeof redirect_uri !== "string" || !client.redirect_uris.includes(redirect_uri)) {
      res.status(400).send("redirect_uri does not match what this client registered.");
      return;
    }

    const redirectWithError = (error) => {
      const url = new URL(redirect_uri);
      url.searchParams.set("error", error);
      if (typeof state === "string") url.searchParams.set("state", state);
      res.redirect(302, url.toString());
    };

    if (response_type !== "code") {
      redirectWithError("unsupported_response_type");
      return;
    }
    if (code_challenge_method !== "S256" || typeof code_challenge !== "string" || !code_challenge) {
      redirectWithError("invalid_request");
      return;
    }

    res.type("html").send(consentPage({
      clientName: client.client_name,
      formAction: "/authorize",
      hiddenFields: {
        client_id,
        redirect_uri,
        state: typeof state === "string" ? state : "",
        code_challenge,
      },
    }));
  });

  router.post("/authorize", express.urlencoded({ extended: false }), (req, res) => {
    // The raw socket address, never req.ip: the app sets "trust proxy" so
    // that OAuth metadata reports the right public scheme, which also makes
    // req.ip the leftmost X-Forwarded-For entry — a value the caller sets.
    // Keying the lockout on that would let an attacker rotate the header and
    // get unlimited guesses at the token. Behind the tunnel every request
    // shares cloudflared's address, so this throttles consent attempts
    // globally rather than per client, which is the safe direction: consent
    // is a rare, interactive action.
    const ip = req.socket.remoteAddress ?? "unknown";
    const { client_id, redirect_uri, state, code_challenge, token } = req.body ?? {};
    const client = typeof client_id === "string" ? store.clients[client_id] : undefined;

    if (!client || typeof redirect_uri !== "string" || !client.redirect_uris.includes(redirect_uri)) {
      res.status(400).send("Invalid client or redirect_uri.");
      return;
    }

    if (tooManyAttempts(ip)) {
      res.status(429).type("html").send(consentPage({
        clientName: client.client_name,
        error: "Too many attempts. Try again later.",
        formAction: "/authorize",
        hiddenFields: { client_id, redirect_uri, state: state ?? "", code_challenge },
      }));
      return;
    }

    const expected = getAuthToken();
    const ok = typeof token === "string" && token.length > 0 && timingSafeEqualStr(token, expected);
    if (!ok) {
      recordAttempt(ip);
      log("warning", "Rejected OAuth consent: wrong bearer token", { ip, clientId: client_id });
      res.status(401).type("html").send(consentPage({
        clientName: client.client_name,
        error: "That token is not correct.",
        formAction: "/authorize",
        hiddenFields: { client_id, redirect_uri, state: state ?? "", code_challenge },
      }));
      return;
    }

    const code = randomBytes(32).toString("hex");
    pendingCodes.set(code, {
      client_id,
      redirect_uri,
      code_challenge,
      expires_at: Date.now() + AUTH_CODE_TTL_MS,
    });
    setTimeout(() => pendingCodes.delete(code), AUTH_CODE_TTL_MS + 1000).unref();

    log("info", "Issued an OAuth authorization code", { clientId: client_id });

    const url = new URL(redirect_uri);
    url.searchParams.set("code", code);
    if (typeof state === "string" && state) url.searchParams.set("state", state);
    res.redirect(302, url.toString());
  });

  // --- /token: exchange a code (or refresh_token) for an access token ---
  router.post("/token", express.urlencoded({ extended: false }), (req, res) => {
    const body = req.body ?? {};

    if (body.grant_type === "authorization_code") {
      const { code, redirect_uri, client_id, code_verifier } = body;
      const pending = typeof code === "string" ? pendingCodes.get(code) : undefined;
      if (!pending || pending.expires_at < Date.now() || pending.client_id !== client_id || pending.redirect_uri !== redirect_uri) {
        res.status(400).json({ error: "invalid_grant" });
        return;
      }
      if (!verifyPkce(code_verifier, pending.code_challenge)) {
        res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
        return;
      }
      pendingCodes.delete(code); // one-time use

      const tokens = issueTokenPair(client_id);
      res.json({
        access_token: tokens.accessToken,
        token_type: "Bearer",
        expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
        refresh_token: tokens.refreshToken,
        scope: "mcp",
      });
      return;
    }

    if (body.grant_type === "refresh_token") {
      const { refresh_token, client_id } = body;
      const hash = typeof refresh_token === "string" ? hashToken(refresh_token) : undefined;
      const rec = hash ? store.refreshTokens[hash] : undefined;
      const idle = rec && (rec.last_used ?? rec.issued_at) + REFRESH_TOKEN_IDLE_MS < Date.now();
      if (!rec || idle || (client_id && rec.client_id !== client_id)) {
        res.status(400).json({ error: "invalid_grant" });
        return;
      }
      // Rotation: the presented refresh token is spent and a new one issued.
      // OAuth 2.1 (§4.3.1) requires rotation or sender-constraining for
      // public clients, which every client here is — there are no client
      // secrets. Without it a refresh token copied once (a backup, a
      // compromised phone) stays valid indefinitely alongside the real one.
      delete store.refreshTokens[hash];
      const tokens = issueTokenPair(rec.client_id);
      res.json({
        access_token: tokens.accessToken,
        token_type: "Bearer",
        expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
        refresh_token: tokens.refreshToken,
        scope: "mcp",
      });
      return;
    }

    res.status(400).json({ error: "unsupported_grant_type" });
  });

  return router;
}

function issueTokenPair(clientId) {
  pruneExpired();
  const accessToken = randomBytes(32).toString("hex");
  const refreshToken = randomBytes(32).toString("hex");
  const now = Date.now();
  store.accessTokens[hashToken(accessToken)] = { client_id: clientId, issued_at: now, expires_at: now + ACCESS_TOKEN_TTL_MS };
  store.refreshTokens[hashToken(refreshToken)] = { client_id: clientId, issued_at: now, last_used: now };
  saveStore();
  return { accessToken, refreshToken };
}

/**
 * Used by gateway.mjs's bearer-auth middleware on every MCP request, so it
 * stays a pure in-memory lookup: an expired token is simply rejected, and
 * left for pruneExpired() to drop at the next issuance rather than costing a
 * synchronous disk write on the request path.
 */
export function isValidOAuthAccessToken(token) {
  const rec = store.accessTokens[hashToken(token)];
  return Boolean(rec) && !(rec.expires_at && rec.expires_at < Date.now());
}

/** For the ingress dashboard: list registered clients without exposing tokens. */
export function listOAuthClients() {
  return Object.values(store.clients)
    .map((c) => ({ client_id: c.client_id, client_name: c.client_name, created_at: c.created_at }))
    .sort((a, b) => b.created_at - a.created_at);
}

/** For the ingress dashboard's "revoke all" action. Clients stay registered
 * (so Claude doesn't need to re-register), but every issued token becomes
 * invalid, forcing a fresh /authorize round-trip on next use. */
export function revokeAllOAuthTokens() {
  store.accessTokens = {};
  store.refreshTokens = {};
  saveStore();
}
