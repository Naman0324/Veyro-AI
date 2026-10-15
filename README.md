# Veyro AI

Veyro is a multi-provider AI chat app built with React, Vite, Express, and PostgreSQL. It streams model replies, supports account sign-up/sign-in, and saves conversations to each user's account.

## Features

- Choose configured Gemini, OpenAI, AgentRouter, Anthropic, and additional OpenAI-compatible provider models; provider credentials remain on the server.
- Stream responses from the selected provider.
- Create an account with a password hash, then use an HTTP-only session cookie with CSRF protection.
- Persist chat history in PostgreSQL and enforce per-account ownership on conversation routes.
- Apply shared database-backed request limits and a configurable daily chat limit.
- Delete an account and its saved chats from the app.
- Deploy the Vite site as static assets on Vercel and serve the Express API from a Vercel Function.

## Run locally

Requirements: Node.js 20.19+ or 22.12+, npm, and Docker Desktop (for the local PostgreSQL service).

1. Start PostgreSQL from the repository root:

   ```powershell
   docker compose up -d
   ```

2. Copy `server/.env.example` to `server/.env`, add at least one provider key, and replace `SESSION_SECRET` with a long random value. The example database URL matches the local Docker service.

3. Install dependencies and start the API:

   ```powershell
   cd server
   npm ci
   npm run dev
   ```

4. In another terminal, install dependencies and start Vite:

   ```powershell
   cd client
   npm ci
   npm run dev
   ```

Open the URL printed by Vite (normally `http://127.0.0.1:5173`). Vite proxies `/api` requests to the API at `http://127.0.0.1:5000`. The API creates the database tables during startup.

## Configure AI providers

Set one or more keys in `server/.env`. Model variables accept comma-separated provider model IDs. The API only returns models for providers with configured keys.

```dotenv
GEMINI_API_KEY=
GEMINI_MODELS=gemini-3.8-flash
OPENAI_API_KEY=
OPENAI_MODELS=gpt-5-mini
AGENTROUTER_API_KEY=
AGENTROUTER_MODELS=gpt-5
AGENTROUTER_BASE_URL=https://agentrouter.org/v1
ANTHROPIC_API_KEY=
ANTHROPIC_MODELS=claude-sonnet-5
OPENAI_COMPATIBLE_PROVIDERS=
```

For AgentRouter, create a token at [agentrouter.org/console/token](https://agentrouter.org/console/token), then set `AGENTROUTER_API_KEY` to that token and `AGENTROUTER_MODELS` to one or more model IDs enabled in your AgentRouter account. The default API base URL is `https://agentrouter.org/v1`.

You can add multiple additional services that expose the OpenAI-compatible chat completions API. Put their key variables (such as `GROQ_API_KEY`) in the server environment, then describe each provider in `OPENAI_COMPATIBLE_PROVIDERS` as JSON:

```json
[
  {
    "id": "groq",
    "name": "Groq",
    "baseUrl": "https://provider-api.example/v1",
    "apiKeyEnv": "GROQ_API_KEY",
    "models": ["provider-model-id"]
  }
]
```

Replace the example base URL and model ID with the provider's documented values. Add multiple objects for multiple services. `tokenLimitField` is optional and accepts `max_tokens` by default or `max_completion_tokens` when the service requires it. Gemini and Anthropic use their native APIs and already have dedicated adapters; a provider with a different API format needs its own adapter. Use model IDs enabled for each provider account. Provider usage is billed by the provider to the key owner.

## Deploy on Vercel

1. Create a hosted PostgreSQL database with a connection pooler (for example through a Vercel Marketplace provider or another PostgreSQL host). Vercel hosts the web app and API as two services in one project; the database is a separate service.
2. Import `Naman0324/Veyro-AI` into Vercel. Keep the project root at the repository root. The included `vercel.json` builds the Vite client and Express API as Vercel services and routes `/api/*` to the API and other paths to the client.
3. Add these environment variables in Vercel Project Settings → Environment Variables:

   | Variable | Value |
   | --- | --- |
   | `DATABASE_URL` | Pooled PostgreSQL connection string from your database host. Vercel's Neon integration can instead provide `DATABASE_POSTGRES_URL`. |
   | `DATABASE_SSL` | `true` when required by the database host |
   | `DATABASE_POOL_SIZE` | `1` for serverless function instances |
   | `SESSION_SECRET` | Long, random secret; use Vercel's Generate option |
   | `DAILY_CHAT_LIMIT` | Optional; defaults to `25` |
   | `AI_TIMEOUT_MS` | Optional; use `50000` with the included 60-second function duration |
   | `GEMINI_API_KEY`, `OPENAI_API_KEY`, `AGENTROUTER_API_KEY`, `ANTHROPIC_API_KEY` | Add the provider key(s) you intend to use |
   | `AGENTROUTER_MODELS` | Optional; comma-separated model IDs enabled in AgentRouter |
   | `AGENTROUTER_BASE_URL` | Optional; defaults to `https://agentrouter.org/v1` |
   | `OPENAI_COMPATIBLE_PROVIDERS` | Optional JSON list to add compatible providers; add each referenced key variable separately |

4. Redeploy after setting the variables. Visit `/api/health` on the deployment; it should report `status: "ok"` and `database: "connected"`. Then create an account and try a conversation.

The same Vercel project serves the client and `/api/*` routes so the session cookie stays on one origin. Do not set `VITE_API_URL` for this deployment. Vercel services have plan-based duration and usage limits; use a provider timeout below the configured Vercel function duration. See [Vercel Services](https://vercel.com/docs/services), [Express on Vercel](https://vercel.com/docs/frameworks/backend/express), and [Vercel environment variables](https://vercel.com/docs/environment-variables).

## Configuration

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string; required to start the API |
| `DATABASE_SSL` | Set `true` when the database requires TLS |
| `DATABASE_POOL_SIZE` | Connection pool size; keep small on serverless hosts |
| `SESSION_SECRET` | Long random secret used to sign session cookies; required in production |
| `DAILY_CHAT_LIMIT` | Requests allowed per account per UTC day; defaults to 25 |
| `PORT`, `HOST` | API bind settings for local development |
| `CLIENT_ORIGINS` | Exact comma-separated browser origins for cross-origin deployments |
| `TRUST_PROXY` | Set only when running behind a trusted proxy; Vercel is detected automatically |
| `AI_TIMEOUT_MS` | Provider request timeout; defaults to 90 seconds locally |
| `GEMINI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` | Optional AI provider secrets |

## Privacy and account behavior

Veyro stores account email, password hashes, conversation titles, selected model IDs, prompts, and responses in PostgreSQL. It uses an essential HTTP-only session cookie. Prompts and conversation context are sent to the AI provider selected for each response and are subject to that provider's terms and data handling. No email verification or password recovery flow is configured yet. Add a verified email delivery provider and publish reviewed privacy terms before opening registration broadly.

## Before public launch

- Choose a durable PostgreSQL plan and configure/test backups and recovery.
- Add verified email, password reset, and email-change flows using a transactional email service.
- Replace the short privacy notice and starter terms with reviewed, jurisdiction-appropriate documents, including your support contact and provider retention details.
- Configure production monitoring, error alerting, and a tested incident/restore process.
- Set billing alerts and provider-side spending caps; the account request quota is a basic limit, not billing, token-based cost control, or bot protection.
- Set Vercel environment variables for Production and Preview as appropriate. Never put provider keys in `client/.env` or browser code.

## API

- `GET /api/health` — API and PostgreSQL readiness plus configured provider names.
- `GET /api/models` — models enabled by server-side provider keys.
- `GET /api/auth/me` — current account and CSRF token.
- `POST /api/auth/signup`, `POST /api/auth/login`, `POST /api/auth/logout` — account session operations.
- `GET /api/conversations`, `POST /api/conversations`, `GET /api/conversations/:id`, `DELETE /api/conversations/:id` — saved chat operations scoped to the signed-in account.
- `POST /api/chat` — accepts `{ "conversationId": "optional UUID", "message": "...", "model": "provider:model-id" }` and streams `start`, `token`, `done`, or `error` events.
- `DELETE /api/auth/account` — permanently deletes the account and owned chat data.

## Stack

- Client: React 18, Vite, Lucide
- API: Node.js, Express, Zod, PostgreSQL
- Sessions: express-session backed by PostgreSQL
- AI providers: Google Gemini, OpenAI, Anthropic
