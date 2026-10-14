import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { z } from "zod";

const app = express();
const PORT = Number(process.env.PORT) || 5000;
const HOST = process.env.HOST || "0.0.0.0";
const allowedOrigins = (process.env.CLIENT_ORIGINS || "http://localhost:5173,http://127.0.0.1:5173")
  .split(",").map((origin) => origin.trim()).filter(Boolean);
const timeoutMs = Math.max(10_000, Number(process.env.AI_TIMEOUT_MS) || 90_000);

const providerSettings = [
  { id: "gemini", name: "Google Gemini", key: process.env.GEMINI_API_KEY, models: process.env.GEMINI_MODELS || process.env.GEMINI_MODEL || "gemini-3.8-flash" },
  { id: "openai", name: "OpenAI", key: process.env.OPENAI_API_KEY, models: process.env.OPENAI_MODELS || "gpt-5-mini" },
  { id: "anthropic", name: "Anthropic", key: process.env.ANTHROPIC_API_KEY, models: process.env.ANTHROPIC_MODELS || "claude-sonnet-4-5" }
];

const models = providerSettings.flatMap((provider) => provider.key
  ? provider.models.split(",").map((id) => id.trim()).filter(Boolean).map((id) => ({
    id: `${provider.id}:${id}`,
    provider: provider.id,
    providerName: provider.name,
    model: id,
    label: id
  }))
  : []);

app.disable("x-powered-by");
app.set("trust proxy", process.env.TRUST_PROXY === "true" ? 1 : false);
app.use(helmet());
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("Origin not allowed by CORS"));
  },
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"]
}));
app.use(express.json({ limit: "100kb" }));

const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many requests. Please wait a moment and try again." }
});
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many chat requests. Please wait a moment and try again." }
});
app.use(generalLimiter);

app.get("/", (_req, res) => res.json({ name: "Veyro AI API", status: "ok" }));
app.get("/api/health", (_req, res) => res.json({ status: "ok", service: "veyro-api", configuredProviders: [...new Set(models.map((item) => item.provider))] }));
app.get("/api/models", (_req, res) => res.json({ models, defaultModel: models[0]?.id || null }));

const messageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1).max(12_000)
});
const chatSchema = z.object({
  messages: z.array(messageSchema).min(1).max(30),
  model: z.string().min(1).max(160)
}).strict();

function sendEvent(res, event, payload) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

async function* readSse(response, signal) {
  if (!response.body) throw new Error("Provider returned an empty stream.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal.aborted) return;
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() || "";
      for (const block of blocks) {
        const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
        if (data && data !== "[DONE]") yield JSON.parse(data);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function streamGemini(model, messages, signal, onToken) {
  const contents = messages.map(({ role, content }) => ({
    role: role === "assistant" ? "model" : "user",
    parts: [{ text: content }]
  }));
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
  body: JSON.stringify({ contents, systemInstruction: { parts: [{ text: process.env.AI_SYSTEM_PROMPT || "You are Veyro, a helpful and clear AI assistant." }] }, generationConfig: { maxOutputTokens: 2048 } }),
    signal
  });
  if (!response.ok) throw new Error(`Gemini provider returned ${response.status}.`);
  for await (const chunk of readSse(response, signal)) {
    const text = chunk.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("");
    if (text) onToken(text);
  }
}

async function streamOpenAI(model, messages, signal, onToken) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model, messages: [{ role: "system", content: process.env.AI_SYSTEM_PROMPT || "You are Veyro, a helpful and clear AI assistant." }, ...messages], stream: true, max_completion_tokens: 2048 }),
    signal
  });
  if (!response.ok) throw new Error(`OpenAI provider returned ${response.status}.`);
  for await (const chunk of readSse(response, signal)) {
    const text = chunk.choices?.[0]?.delta?.content;
    if (text) onToken(text);
  }
}

async function streamAnthropic(model, messages, signal, onToken) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      system: process.env.AI_SYSTEM_PROMPT || "You are Veyro, a helpful and clear AI assistant.",
      messages: messages.map(({ role, content }) => ({ role: role === "assistant" ? "assistant" : "user", content })),
      stream: true
    }),
    signal
  });
  if (!response.ok) throw new Error(`Anthropic provider returned ${response.status}.`);
  for await (const chunk of readSse(response, signal)) {
    if (chunk.type === "content_block_delta" && chunk.delta?.type === "text_delta") onToken(chunk.delta.text);
  }
}

const streamers = { gemini: streamGemini, openai: streamOpenAI, anthropic: streamAnthropic };

app.post("/api/chat", chatLimiter, async (req, res) => {
  const parsed = chatSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Please send a valid message and model." });
  const { messages: conversation, model: requestedModel } = parsed.data;
  if (conversation[conversation.length - 1].role !== "user") {
    return res.status(400).json({ error: "The last message must be from the user." });
  }
  if (conversation.some((message, index) => message.role !== (index % 2 === 0 ? "user" : "assistant"))) {
    return res.status(400).json({ error: "Messages must alternate between user and assistant." });
  }
  const selected = models.find((item) => item.id === requestedModel);
  if (!selected) return res.status(400).json({ error: "That model is not configured on this server." });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Provider request timed out.")), timeoutMs);
  let responseClosed = false;
  res.on("close", () => {
    if (!res.writableEnded) {
      responseClosed = true;
      controller.abort();
    }
  });

  res.status(200);
  res.set({ "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.flushHeaders();
  sendEvent(res, "start", { model: selected.id });

  try {
    const stream = streamers[selected.provider];
    await stream(selected.model, conversation, controller.signal, (text) => {
      if (!responseClosed) sendEvent(res, "token", { text });
    });
    if (!responseClosed) sendEvent(res, "done", {});
  } catch (error) {
    if (!responseClosed && !controller.signal.aborted) {
      console.error("Chat request failed:", { provider: selected.provider, status: error?.status, name: error?.name });
      sendEvent(res, "error", { message: "Veyro couldn't get a response right now. Check the provider key and model, then try again." });
    } else if (!responseClosed && controller.signal.aborted) {
      sendEvent(res, "error", { message: "The model took too long to respond. Please try again." });
    }
  } finally {
    clearTimeout(timeout);
    if (!res.writableEnded) res.end();
  }
});

app.use((err, _req, res, _next) => {
  if (err?.type === "entity.too.large") return res.status(413).json({ error: "Request is too large." });
  if (err instanceof SyntaxError && err.status === 400 && "body" in err) return res.status(400).json({ error: "Please send valid JSON." });
  if (err?.message === "Origin not allowed by CORS") return res.status(403).json({ error: "This origin is not allowed." });
  console.error("Unhandled server error:", err?.name || "UnknownError");
  return res.status(500).json({ error: "An unexpected server error occurred." });
});

app.listen(PORT, HOST, () => console.log(`Veyro API listening on ${HOST}:${PORT}`));
