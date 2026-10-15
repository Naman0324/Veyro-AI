import app from "../server/server.js";

export default function apiHandler(req, res) {
  if (req.url === "/api") req.url = "/api/";
  else if (!req.url?.startsWith("/api/")) {
    req.url = `/api${req.url?.startsWith("/") ? req.url : `/${req.url || ""}`}`;
  }
  return app(req, res);
}
