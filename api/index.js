module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.statusCode = 200;
  res.end(
    JSON.stringify({
      ok: true,
      service: "telegram-proxy",
      endpoints: {
        health: "GET /api/health",
        transparent_proxy: "/api/bot<token>/<method> (drop-in for api.telegram.org)",
        send: "POST /api/send { chat_id?, text, ... }",
        generic: "POST /api/generic (shoutrrr generic: raw text or template=json { title?, message })",
      },
      docs: "https://github.com/Ali-Fani/telegram-proxy",
    })
  );
};
