module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.statusCode = 200;
  res.end(JSON.stringify({ ok: true, service: "telegram-proxy", time: new Date().toISOString() }));
};
