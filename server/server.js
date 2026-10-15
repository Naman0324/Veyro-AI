import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import bcrypt from "bcryptjs";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeDatabase, pool, databaseRateLimit } from "./database.js";

const app = express();
const serverDir = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(serverDir, "../client/dist");
const PORT = Number(process.env.PORT) || 5000;
const HOST = process.env.HOST || "0.0.0.0";
const isProduction = process.env.NODE_ENV === "production";
const allowedOrigins = (process.env.CLIENT_ORIGINS || "http://localhost:5173,http://127.0.0.1:5173")
  .split(",").map((origin) => origin.trim()).filter(Boolean);
const timeoutMs = Math.max(10_000, Number(process.env.AI_TIMEOUT_MS) || (process.env.VERCEL ? 50_000 : 90_000));
const dailyChatLimit = Math.max(1, Number(process.env.DAILY_CHAT_LIMIT) || 25);
const PgSession = connectPgSimple(session);

const providerSettings = [
  { id: "gemini", name: "Google Gemini", key: process.env.GEMINI_API_KEY, models: process.env.GEMINI_MODELS || process.env.GEMINI_MODEL || "gemini-3.8-flash" },
  { id: "openai", name: "OpenAI", key: process.env.OPENAI_API_KEY, models: process.env.OPENAI_MODELS || "gpt-5-mini" },
  { id: "anthropic", name: "Anthropic", key: process.env.ANTHROPIC_API_KEY, models: process.env.ANTHROPIC_MODELS || "claude-sonnet-4-5" }
];
const models = providerSettings.flatMap((provider) => provider.key
  ? provider.models.split(",").map((id) => id.trim()).filter(Boolean).map((id) => ({
    id: `${provider.id}:${id}`, provider: provider.id, providerName: provider.name, model: id, label: id
  }))
  : []);

app.disable("x-powered-by");
app.set("trust proxy", process.env.TRUST_PROXY === "true" || Boolean(process.env.VERCEL) ? 1 : false);
app.use(helmet());
app.use((req, res, next) => cors({
  origin(origin, callback) {
    const ownOrigin = `${req.protocol}://${req.get("host")}`;
    if (!origin || origin === ownOrigin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("Origin not allowed by CORS"));
  },
  credentials: true,
  methods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "X-CSRF-Token"]
})(req, res, next));
app.use(express.json({ limit: "100kb" }));
app.use(session({
  store: new PgSession({ pool, tableName: "user_sessions", createTableIfMissing: true, pruneSessionInterval: process.env.VERCEL ? false : 15 * 60 }),
  name: "veyro.sid",
  secret: process.env.SESSION_SECRET || (!isProduction ? "local-only-veyro-session-secret-change-me" : ""),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, secure: isProduction, sameSite: "lax", maxAge: 7 * 24 * 60 * 60 * 1000 }
}));
const databaseReady = initializeDatabase();
app.use((req, res, next) => {
  if (!req.path.startsWith("/api/")) return next();
  databaseReady.then(() => next()).catch(next);
});
app.use((req, res, next) => {
  const startedAt = performance.now();
  res.on("finish", () => {
    if (req.path.startsWith("/api/")) console.log(JSON.stringify({ method: req.method, path: req.path, status: res.statusCode, durationMs: Math.round(performance.now() - startedAt) }));
  });
  next();
});

const generalLimiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: "draft-7", legacyHeaders: false, message: { error: "Too many requests. Please wait a moment and try again." } });
app.use("/api", generalLimiter);
const emailSchema = z.string().trim().email().max(254).transform((email) => email.toLowerCase());
const authSchema = z.object({ email: emailSchema, password: z.string().min(10).max(128) }).strict();
const conversationSchema = z.object({ title: z.string().trim().min(1).max(120).optional(), model: z.string().max(160).optional() }).strict();

function csrfToken(req) {
  if (!req.session.csrfToken) req.session.csrfToken = randomBytes(32).toString("hex");
  return req.session.csrfToken;
}
function requireCsrf(req, res, next) {
  const sent = req.get("X-CSRF-Token") || "";
  const expected = req.session.csrfToken || "";
  const sentBuffer = Buffer.from(sent);
  const expectedBuffer = Buffer.from(expected);
  if (!sent || sentBuffer.length !== expectedBuffer.length || !timingSafeEqual(sentBuffer, expectedBuffer)) {
    return res.status(403).json({ error: "Your session token expired. Refresh the page and try again." });
  }
  return next();
}
function requireUser(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: "Sign in to continue." });
  return next();
}
function regenerateSession(req) {
  return new Promise((resolve, reject) => req.session.regenerate((error) => error ? reject(error) : resolve()));
}
function saveSession(req) {
  return new Promise((resolve, reject) => req.session.save((error) => error ? reject(error) : resolve()));
}

app.get("/api/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    return res.json({ status: "ok", service: "veyro-api", database: "connected", configuredProviders: [...new Set(models.map((item) => item.provider))] });
  } catch {
    return res.status(503).json({ status: "degraded", service: "veyro-api", database: "unavailable" });
  }
});
app.get("/api/csrf", (req, res, next) => {
  csrfToken(req);
  req.session.save((error) => error ? next(error) : res.json({ csrfToken: req.session.csrfToken }));
});
app.get("/api/auth/me", async (req, res, next) => {
  if (!req.session.userId) return res.json({ user: null, csrfToken: csrfToken(req) });
  try {
    const { rows } = await pool.query("SELECT id, email, created_at FROM users WHERE id = $1", [req.session.userId]);
    if (!rows[0]) {
      req.session.destroy(() => {});
      return res.json({ user: null, csrfToken: randomBytes(32).toString("hex") });
    }
    return res.json({ user: rows[0], csrfToken: csrfToken(req) });
  } catch (error) { return next(error); }
});
app.post("/api/auth/signup", requireCsrf, databaseRateLimit("signup", 8, 60 * 60 * 1000), async (req, res, next) => {
  const parsed = authSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Use a valid email and a password with at least 10 characters." });
  try {
    const id = randomUUID();
    const hash = await bcrypt.hash(parsed.data.password, 12);
    await pool.query("INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)", [id, parsed.data.email, hash]);
    await regenerateSession(req);
    req.session.userId = id;
    req.session.csrfToken = randomBytes(32).toString("hex");
    await saveSession(req);
    return res.status(201).json({ user: { id, email: parsed.data.email }, csrfToken: req.session.csrfToken });
  } catch (error) {
    if (error.code === "23505") return res.status(409).json({ error: "An account with this email already exists." });
    return next(error);
  }
});
app.post("/api/auth/login", requireCsrf, databaseRateLimit("login", 12, 15 * 60 * 1000), async (req, res, next) => {
  const parsed = authSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Enter a valid email and password." });
  try {
    const { rows } = await pool.query("SELECT id, email, password_hash FROM users WHERE LOWER(email) = $1", [parsed.data.email]);
    const user = rows[0];
    if (!user || !(await bcrypt.compare(parsed.data.password, user.password_hash))) return res.status(401).json({ error: "Email or password is incorrect." });
    await regenerateSession(req);
    req.session.userId = user.id;
    req.session.csrfToken = randomBytes(32).toString("hex");
    await saveSession(req);
    return res.json({ user: { id: user.id, email: user.email }, csrfToken: req.session.csrfToken });
  } catch (error) { return next(error); }
});
app.post("/api/auth/logout", requireCsrf, requireUser, (req, res) => {
  req.session.destroy((error) => {
    if (error) return res.status(500).json({ error: "Could not sign out. Please try again." });
    res.clearCookie("veyro.sid", { httpOnly: true, secure: isProduction, sameSite: "lax" });
    return res.json({ ok: true });
  });
});
app.delete("/api/auth/account", requireCsrf, requireUser, async (req, res, next) => {
  try {
    await pool.query("DELETE FROM users WHERE id = $1", [req.session.userId]);
    req.session.destroy((error) => {
      if (error) return res.status(500).json({ error: "Account data was removed, but the session could not be cleared." });
      res.clearCookie("veyro.sid", { httpOnly: true, secure: isProduction, sameSite: "lax" });
      return res.json({ ok: true });
    });
  } catch (error) { return next(error); }
});

app.get("/api/models", (_req, res) => res.json({ models, defaultModel: models[0]?.id || null }));
app.get("/api/conversations", requireUser, async (req, res, next) => {
  try {
    const { rows } = await pool.query("SELECT id, title, model_id, created_at, updated_at FROM conversations WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 100", [req.session.userId]);
    return res.json({ conversations: rows });
  } catch (error) { return next(error); }
});
app.post("/api/conversations", requireCsrf, requireUser, async (req, res, next) => {
  const parsed = conversationSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "Invalid conversation details." });
  const id = randomUUID();
  try {
    const { rows } = await pool.query("INSERT INTO conversations (id, user_id, title, model_id) VALUES ($1, $2, $3, $4) RETURNING id, title, model_id, created_at, updated_at", [id, req.session.userId, parsed.data.title || "New chat", parsed.data.model || null]);
    return res.status(201).json({ conversation: rows[0] });
  } catch (error) { return next(error); }
});
app.get("/api/conversations/:id", requireUser, async (req, res, next) => {
  try {
    const { rows: chats } = await pool.query("SELECT id, title, model_id, created_at, updated_at FROM conversations WHERE id = $1 AND user_id = $2", [req.params.id, req.session.userId]);
    if (!chats[0]) return res.status(404).json({ error: "Conversation not found." });
    const { rows: messages } = await pool.query("SELECT role, content, created_at FROM chat_messages WHERE conversation_id = $1 ORDER BY id", [req.params.id]);
    return res.json({ conversation: chats[0], messages });
  } catch (error) { return next(error); }
});
app.delete("/api/conversations/:id", requireCsrf, requireUser, async (req, res, next) => {
  try {
    const { rowCount } = await pool.query("DELETE FROM conversations WHERE id = $1 AND user_id = $2", [req.params.id, req.session.userId]);
    return rowCount ? res.json({ ok: true }) : res.status(404).json({ error: "Conversation not found." });
  } catch (error) { return next(error); }
});

const messageSchema = z.object({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(12_000) });
const chatSchema = z.object({ conversationId: z.string().uuid().optional(), message: z.string().trim().min(1).max(12_000), model: z.string().min(1).max(160) }).strict();
function sendEvent(res, event, payload) { res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`); }
async function* readSse(response, signal) {
  if (!response.body) throw new Error("Provider returned an empty stream.");
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
  try {
    while (true) {
      if (signal.aborted) return;
      const { value, done } = await reader.read(); if (done) break;
      buffer += decoder.decode(value, { stream: true }); const blocks = buffer.split(/\r?\n\r?\n/); buffer = blocks.pop() || "";
      for (const block of blocks) {
        const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
        if (data && data !== "[DONE]") yield JSON.parse(data);
      }
    }
  } finally { reader.releaseLock(); }
}
async function streamGemini(model, messages, signal, onToken) {
  const contents = messages.map(({ role, content }) => ({ role: role === "assistant" ? "model" : "user", parts: [{ text: content }] }));
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
    body: JSON.stringify({ contents, systemInstruction: { parts: [{ text: process.env.AI_SYSTEM_PROMPT || "You are Veyro, a helpful and clear AI assistant." }] }, generationConfig: { maxOutputTokens: 2048 } }), signal
  });
  if (!response.ok) throw new Error(`Gemini provider returned ${response.status}.`);
  for await (const chunk of readSse(response, signal)) { const text = chunk.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join(""); if (text) onToken(text); }
}
async function streamOpenAI(model, messages, signal, onToken) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: JSON.stringify({ model, messages: [{ role: "system", content: process.env.AI_SYSTEM_PROMPT || "You are Veyro, a helpful and clear AI assistant." }, ...messages], stream: true, max_completion_tokens: 2048 }), signal });
  if (!response.ok) throw new Error(`OpenAI provider returned ${response.status}.`);
  for await (const chunk of readSse(response, signal)) { const text = chunk.choices?.[0]?.delta?.content; if (text) onToken(text); }
}
async function streamAnthropic(model, messages, signal, onToken) {
  const response = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model, max_tokens: 2048, system: process.env.AI_SYSTEM_PROMPT || "You are Veyro, a helpful and clear AI assistant.", messages: messages.map(({ role, content }) => ({ role, content })), stream: true }), signal });
  if (!response.ok) throw new Error(`Anthropic provider returned ${response.status}.`);
  for await (const chunk of readSse(response, signal)) { if (chunk.type === "content_block_delta" && chunk.delta?.type === "text_delta") onToken(chunk.delta.text); }
}
const streamers = { gemini: streamGemini, openai: streamOpenAI, anthropic: streamAnthropic };
app.post("/api/chat", requireCsrf, requireUser, databaseRateLimit("chat", 30, 60_000), async (req, res, next) => {
  const parsed = chatSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Please send a valid message and model." });
  const { conversationId, message, model: requestedModel } = parsed.data;
  const selected = models.find((item) => item.id === requestedModel);
  if (!selected) return res.status(400).json({ error: "That model is not configured on this server." });
  let client;
  let conversation;
  let userMessage;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    let chatId = conversationId;
    if (chatId) {
      const { rows } = await client.query("SELECT id, title FROM conversations WHERE id = $1 AND user_id = $2 FOR UPDATE", [chatId, req.session.userId]);
      if (!rows[0]) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Conversation not found." }); }
      conversation = rows[0];
    } else {
      chatId = randomUUID(); conversation = { id: chatId, title: message.slice(0, 72) };
      await client.query("INSERT INTO conversations (id, user_id, title, model_id) VALUES ($1, $2, $3, $4)", [chatId, req.session.userId, conversation.title, selected.id]);
    }
    const { rows: prior } = await client.query("SELECT role, content FROM chat_messages WHERE conversation_id = $1 ORDER BY id", [chatId]);
    const history = [...prior, { role: "user", content: message }];
    const validHistory = z.array(messageSchema).max(120).safeParse(history);
    if (!validHistory.success) { await client.query("ROLLBACK"); return res.status(400).json({ error: "This chat is too long. Start a new conversation to continue." }); }
    const { rows: quota } = await client.query("INSERT INTO user_daily_usage (user_id, usage_date, request_count) VALUES ($1, CURRENT_DATE, 1) ON CONFLICT (user_id, usage_date) DO UPDATE SET request_count = user_daily_usage.request_count + 1 RETURNING request_count", [req.session.userId]);
    if (quota[0].request_count > dailyChatLimit) { await client.query("ROLLBACK"); return res.status(429).json({ error: `You've reached today's ${dailyChatLimit}-message limit. Try again tomorrow.` }); }
    const inserted = await client.query("INSERT INTO chat_messages (conversation_id, role, content) VALUES ($1, 'user', $2) RETURNING id", [chatId, message]);
    userMessage = inserted.rows[0];
    await client.query("UPDATE conversations SET model_id = $2, updated_at = NOW() WHERE id = $1", [chatId, selected.id]);
    await client.query("COMMIT");
    conversation = { ...conversation, id: chatId };
    req.chatHistory = validHistory.data;
  } catch (error) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    return next(error);
  } finally { client?.release(); }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Provider request timed out.")), timeoutMs);
  let responseClosed = false; let assistantReply = "";
  res.on("close", () => { if (!res.writableEnded) { responseClosed = true; controller.abort(); } });
  res.status(200).set({ "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.flushHeaders(); sendEvent(res, "start", { model: selected.id, conversationId: conversation.id, userMessageId: userMessage.id });
  try {
    await streamers[selected.provider](selected.model, req.chatHistory, controller.signal, (text) => { assistantReply += text; if (!responseClosed) sendEvent(res, "token", { text }); });
    if (assistantReply) {
      await pool.query("INSERT INTO chat_messages (conversation_id, role, content) VALUES ($1, 'assistant', $2)", [conversation.id, assistantReply]);
      await pool.query("UPDATE conversations SET updated_at = NOW() WHERE id = $1", [conversation.id]);
    }
    if (!responseClosed) sendEvent(res, "done", {});
  } catch (error) {
    if (!responseClosed && !controller.signal.aborted) {
      console.error("Chat request failed:", { provider: selected.provider, status: error?.status, name: error?.name });
      sendEvent(res, "error", { message: "Veyro couldn't get a response right now. Check the provider key and model, then try again." });
    } else if (!responseClosed && controller.signal.aborted) sendEvent(res, "error", { message: "The model took too long to respond. Please try again." });
  } finally { clearTimeout(timeout); if (!res.writableEnded) res.end(); }
});

if (!process.env.VERCEL) app.use(express.static(clientDist));
app.get("*", (req, res, next) => { if (req.path.startsWith("/api/")) return next(); return res.sendFile(path.join(clientDist, "index.html")); });
app.use((err, _req, res, _next) => {
  if (err?.type === "entity.too.large") return res.status(413).json({ error: "Request is too large." });
  if (err instanceof SyntaxError && err.status === 400 && "body" in err) return res.status(400).json({ error: "Please send valid JSON." });
  if (err?.message === "Origin not allowed by CORS") return res.status(403).json({ error: "This origin is not allowed." });
  console.error("Unhandled server error:", err?.name || "UnknownError");
  return res.status(500).json({ error: "An unexpected server error occurred." });
});

if (isProduction && !process.env.SESSION_SECRET) throw new Error("SESSION_SECRET is required in production.");
if (!process.env.VERCEL) databaseReady.then(() => {
  const server = app.listen(PORT, HOST, () => console.log(`Veyro API listening on ${HOST}:${PORT}`));
  const shutdown = () => server.close(() => pool.end().finally(() => process.exit(0)));
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
})
  .catch((error) => { console.error("Veyro could not start:", error.message); process.exitCode = 1; });

export default app;
