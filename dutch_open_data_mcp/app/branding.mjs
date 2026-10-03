// The add-on's icon, offered to MCP clients in two places, so whichever a
// client looks at shows the logo instead of a generic tile:
//
//   1. serverInfo.icons in the initialize response (MCP spec 2025-11-25,
//      SEP-973): a URL on this server plus the same image as a data: URI,
//      so a client can render it without fetching anything.
//   2. /favicon.ico, /favicon.png, /icon.png and /apple-touch-icon.png on
//      the public hostname, for clients that look up a site icon instead.
//
// Neither needs credentials: the icon is public, and nothing here touches
// the MCP or OAuth endpoints.
import fs from "node:fs";

const ICON_PATHS = ["/favicon.ico", "/favicon.png", "/icon.png", "/apple-touch-icon.png"];

/** The PNG next to the running script, or null when it isn't shipped. */
export function loadIcon(url) {
  try {
    return fs.readFileSync(url);
  } catch {
    return null;
  }
}

/** serverInfo.icons entries for an icon PNG (128x128). */
export function serverIcons(png, publicOrigin) {
  if (!png) return [];
  const icons = [];
  if (publicOrigin) icons.push({ src: `${publicOrigin}/icon.png`, mimeType: "image/png", sizes: ["128x128"] });
  icons.push({ src: `data:image/png;base64,${png.toString("base64")}`, mimeType: "image/png", sizes: ["128x128"] });
  return icons;
}

/**
 * Adds a title and icons to an McpServer's serverInfo. The SDK takes
 * serverInfo only in the constructor, which upstream calls, so it is set on
 * the underlying Server before the session's initialize is answered.
 */
export function withBranding(mcpServer, { title, icons }) {
  const server = mcpServer?.server;
  if (!server || typeof server._serverInfo !== "object") return mcpServer;
  server._serverInfo = {
    ...server._serverInfo,
    ...(title ? { title } : {}),
    ...(icons?.length ? { icons } : {}),
  };
  return mcpServer;
}

/** Public, cacheable icon routes. */
export function iconRoutes(app, png) {
  if (!png) return;
  for (const path of ICON_PATHS) {
    app.get(path, (_req, res) => {
      res.set("Cache-Control", "public, max-age=86400");
      res.type("image/png").send(png);
    });
  }
}
