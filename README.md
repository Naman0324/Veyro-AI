# Veyro AI

Veyro is a multi-provider AI chat starter built with React, Vite, and Express. It streams replies as they are generated and keeps provider credentials on the server.

## Features

- Switch between configured Gemini, OpenAI, and Anthropic models.
- Stream answers into the conversation for quicker first feedback.
- Configure more than one model per provider using an environment variable.
- Restrict browser origins, validate chat requests, limit request size, and rate-limit API calls.
- Deploy the client as a static site and the API as a Node service.

## Stack

- Client: React 18, Vite, Lucide
- API: Node.js, Express, Zod
- AI providers: Google Gemini, OpenAI, Anthropic (provider keys are optional; configure at least one)

## Run locally

Requirements: Node.js 20.19+ or 22.12+, npm.

1. Install dependencies in both folders:

   ```powershell
   cd client
   npm install
   cd ..\server
   npm install
   ```

2. Copy `server/.env.example` to `server/.env` and add at least one provider API key. Keep keys out of the client and out of source control.

3. Start the API in one terminal:

   ```powershell
   cd server
   npm run dev
   ```

4. Start the client in another terminal:

   ```powershell
   cd client
   npm run dev
   ```

The Vite development server uses `http://127.0.0.1:5173`; the API listens on port `5000` by default. Visit the URL printed by Vite.

## Configure providers

Set one or more keys in `server/.env`. Model variables accept comma-separated model IDs. The API only exposes models for providers that have a key configured.

```dotenv
GEMINI_API_KEY=
GEMINI_MODELS=gemini-3.8-flash
OPENAI_API_KEY=
OPENAI_MODELS=gpt-5-mini
ANTHROPIC_API_KEY=
ANTHROPIC_MODELS=claude-sonnet-5
```

After changing environment variables, restart the API. Use model IDs enabled for your provider account; IDs and availability can change over time.

## Deployment

### Deploy to Render

The included `render.yaml` deploys the Vite client and Express API together as one Node web service. In Render, create a Blueprint from the GitHub repository and add at least one provider API key when prompted. Render builds the client, serves it from the API service, and checks `/api/health`.

The free Render plan may sleep when idle, which can make the first request take longer. Choose a paid plan for an always-on portfolio demo. Render Blueprints support configuring services and environment variables from the repository's YAML file ([Blueprint reference](https://render.com/docs/blueprint-spec)).

For a separate client and API deployment, configure these values in the hosting provider's environment settings:

| Variable | Where | Purpose |
| --- | --- | --- |
| `VITE_API_URL` | Client build | Public base URL of the API, with no trailing slash |
| `PORT` | API host | Supplied by the hosting platform when available |
| `HOST` | API host | Defaults to `0.0.0.0` for container/service hosts |
| `CLIENT_ORIGINS` | API host | Comma-separated exact production client origins |
| `TRUST_PROXY` | API host | Set to `true` only when the API is behind one trusted proxy |
| `AI_TIMEOUT_MS` | API host | Provider request timeout; defaults to 90 seconds |
| `GEMINI_API_KEY` | API host | Optional Gemini key |
| `OPENAI_API_KEY` | API host | Optional OpenAI key |
| `ANTHROPIC_API_KEY` | API host | Optional Anthropic key |

Set `VITE_API_URL` before building the client. Store API keys as host-managed secrets. Add each production client origin to `CLIENT_ORIGINS`; do not use `*` for a public deployment. Configure the API host's health check to request `/api/health`.

## API

- `GET /api/health` — API health and configured provider names.
- `GET /api/models` — configured models available to the client.
- `POST /api/chat` — accepts `{ "messages": [...], "model": "provider:model-id" }` and streams Server-Sent Events (`start`, `token`, `done`, or `error`).

## Project status

This is an early portfolio project and is not a production-ready hosted AI service. Before opening access to the public, add authentication, per-user quotas and billing controls, persistent chat storage with ownership checks, shared rate-limit storage, production monitoring, and a privacy policy. The current rate limiter is process-local and does not replace user-level abuse or cost controls.
