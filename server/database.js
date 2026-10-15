import pg from "pg";

const { Pool } = pg;
// Vercel's Neon integration exposes its pooled connection string as
// DATABASE_POSTGRES_URL when using the DATABASE prefix. Keep DATABASE_URL as
// the standard override for local development and other database providers.
const databaseUrl = process.env.DATABASE_URL || process.env.DATABASE_POSTGRES_URL || process.env.POSTGRES_URL;
const ssl = process.env.DATABASE_SSL === "true"
  ? { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== "false" }
  : undefined;

export const pool = new Pool({
  connectionString: databaseUrl,
  ssl,
  max: Number(process.env.DATABASE_POOL_SIZE) || 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000
});

export async function initializeDatabase() {
  if (!databaseUrl) throw new Error("DATABASE_URL or DATABASE_POSTGRES_URL is required.");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY,
      email TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (LOWER(email));

    CREATE TABLE IF NOT EXISTS conversations (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title VARCHAR(120) NOT NULL,
      model_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS conversations_user_updated_idx ON conversations(user_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS chat_messages (
      id BIGSERIAL PRIMARY KEY,
      conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS chat_messages_conversation_idx ON chat_messages(conversation_id, id);

    CREATE TABLE IF NOT EXISTS user_daily_usage (
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      usage_date DATE NOT NULL DEFAULT CURRENT_DATE,
      request_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(user_id, usage_date)
    );

    CREATE TABLE IF NOT EXISTS api_rate_limits (
      rate_key TEXT PRIMARY KEY,
      hit_count INTEGER NOT NULL DEFAULT 0,
      reset_at TIMESTAMPTZ NOT NULL
    );
  `);
}

export function databaseRateLimit(prefix, limit, windowMs) {
  return async (req, res, next) => {
    try {
      const key = `${prefix}:${req.ip || req.socket.remoteAddress || "unknown"}`;
      const { rows } = await pool.query(`
        INSERT INTO api_rate_limits (rate_key, hit_count, reset_at)
        VALUES ($1, 1, NOW() + ($2::double precision * INTERVAL '1 millisecond'))
        ON CONFLICT (rate_key) DO UPDATE SET
          hit_count = CASE WHEN api_rate_limits.reset_at <= NOW() THEN 1 ELSE api_rate_limits.hit_count + 1 END,
          reset_at = CASE WHEN api_rate_limits.reset_at <= NOW()
            THEN NOW() + ($2::double precision * INTERVAL '1 millisecond')
            ELSE api_rate_limits.reset_at END
        RETURNING hit_count, reset_at
      `, [key, windowMs]);
      const { hit_count: hits, reset_at: resetAt } = rows[0];
      if (hits % 100 === 1) await pool.query("DELETE FROM api_rate_limits WHERE reset_at < NOW() - INTERVAL '1 day'");
      res.set("RateLimit-Limit", String(limit));
      res.set("RateLimit-Remaining", String(Math.max(0, limit - hits)));
      res.set("RateLimit-Reset", String(Math.ceil(new Date(resetAt).getTime() / 1000)));
      if (hits > limit) {
        return res.status(429).json({ error: "Too many requests. Please wait a moment and try again." });
      }
      return next();
    } catch (error) {
      return next(error);
    }
  };
}
