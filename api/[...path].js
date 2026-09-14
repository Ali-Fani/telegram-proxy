// Transparent proxy for Telegram Bot API on Vercel.
// Usage: replace https://api.telegram.org with https://<your-app>.vercel.app/api
// Example:
//   https://api.telegram.org/bot123:ABC/sendMessage
//   -> https://<your-app>.vercel.app/api/bot123:ABC/sendMessage
//
// Supports GET, POST, JSON and multipart/form-data (sendDocument, sendPhoto, etc.)
// Env vars (optional, recommended):
//   PROXY_SECRET   - if set, client must send header x-proxy-secret or ?secret=
//   ALLOWED_TOKENS - comma-separated bot tokens, e.g. "123:ABC,456:DEF". Empty = allow all.

const TELEGRAM_API = "https://api.telegram.org";

function setCors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    req.headers["access-control-request-headers"] || "Content-Type, X-Proxy-Secret"
  );
  res.setHeader("Access-Control-Max-Age", "86400");
}

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    // Vercel may have already parsed the body when bodyParser is enabled.
    // We disable it below, but keep this fallback for safety.
    if (req.body !== undefined && !req.readable) {
      if (Buffer.isBuffer(req.body)) return resolve(req.body);
      if (typeof req.body === "string") return resolve(Buffer.from(req.body));
      try {
        return resolve(Buffer.from(JSON.stringify(req.body)));
      } catch {
        return resolve(Buffer.alloc(0));
      }
    }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function extractToken(pathname) {
  // pathname like "bot123:ABC/sendMessage" or "file/bot123:ABC/...."
  const m = pathname.match(/(?:^|\/)bot([^/]+)(\/|$)/);
  return m ? m[1] : null;
}

module.exports = async (req, res) => {
  setCors(req, res);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  // Rebuild target URL from path + query. Works regardless of Vercel routing.
  const base = `http://${req.headers.host || "localhost"}`;
  const incoming = new URL(req.url || "/", base);
  let pathname = incoming.pathname.replace(/^\/api\/?/, "");
  pathname = pathname.replace(/^\/+/, "");

  if (!pathname || pathname === "/") {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    return res.end(
      JSON.stringify({
        ok: false,
        description: "Missing Telegram path. Use /api/bot<token>/<method>",
      })
    );
  }

  // Only allow Telegram Bot API paths (bot... and file...).
  if (!/^bot[^/]+\/.+/.test(pathname) && !/^file\/bot[^/]+\/.+/.test(pathname)) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ ok: false, description: "Not a Telegram Bot API path" }));
  }

  // Optional shared-secret check (prevents strangers burning your Vercel bandwidth).
  const requiredSecret = process.env.PROXY_SECRET;
  if (requiredSecret) {
    const got =
      req.headers["x-proxy-secret"] || incoming.searchParams.get("secret");
    if (got !== requiredSecret) {
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ ok: false, description: "Invalid proxy secret" }));
    }
    // Don't forward the secret to Telegram.
    incoming.searchParams.delete("secret");
  }

  // Optional token allowlist.
  if (process.env.ALLOWED_TOKENS) {
    const allowed = process.env.ALLOWED_TOKENS.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const token = extractToken(pathname);
    if (!token || !allowed.includes(token)) {
      res.statusCode = 403;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ ok: false, description: "Bot token not allowed" }));
    }
  }

  const target = `${TELEGRAM_API}/${pathname}${incoming.search ? incoming.search : ""}`;

  try {
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const rawBody = hasBody ? await getRawBody(req) : undefined;

    const headers = {};
    if (req.headers["content-type"]) headers["content-type"] = req.headers["content-type"];

    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body: hasBody && rawBody && rawBody.length ? rawBody : undefined,
    });

    const buf = Buffer.from(await upstream.arrayBuffer());

    res.statusCode = upstream.status;
    const ct = upstream.headers.get("content-type");
    res.setHeader("Content-Type", ct || "application/json");
    res.setHeader("Cache-Control", "no-store");
    return res.end(buf);
  } catch (err) {
    console.error("proxy error:", err);
    res.statusCode = 502;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ ok: false, description: "Proxy error: upstream fetch failed" }));
  }
};

module.exports.config = {
  api: { bodyParser: false },
};
