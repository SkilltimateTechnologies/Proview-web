# Proview — Web App (deployable)

The Proview assessment platform web app (Admin + Teacher portals + student browser exam runner), extracted from the monorepo as a standalone, deployable service. Published by **Skilltimate Technologies**.

Stack: Bun + Hono (API) + React 19 + Vite + Drizzle ORM (Turso/libSQL) + Better Auth + Cloudflare R2 (S3-compatible) storage.

## Deploy on Railway

1. Create a new Railway project → **Deploy from GitHub repo** → select this repo.
2. Railway auto-detects Bun via `nixpacks.toml` / `railway.json`:
   - Build: `bun install && bun run build`
   - Start: `bun run start`
3. Add the environment variables (see `.env.template`):
   - `DATABASE_URL`, `DATABASE_AUTH_TOKEN` (Turso)
   - `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` (Cloudflare R2)
   - `AI_GATEWAY_BASE_URL`, `AI_GATEWAY_API_KEY` (Gemini grading)
   - `BETTER_AUTH_SECRET`, `WEBSITE_URL`
   - `PORT` is provided by Railway automatically.
4. Deploy. The server serves both the API (`/api/*`) and the built SPA.

## Local development

```bash
bun install
cp .env.template .env   # fill in values
bun run dev             # vite dev server
# or production-style:
bun run build && bun run start
```

## Scripts

| Script | Purpose |
|---|---|
| `bun run build` | Typecheck + Vite production build |
| `bun run start` | Serve API + built SPA (`src/server.ts`) |
| `bun run dev` | Vite dev server |
| `bun run db:push` | Push Drizzle schema to Turso |
| `bun run seed` | Seed database |

> Full monorepo (desktop lockdown client, mobile, SEB packaging) lives in `SkilltimateTechnologies/ProView`. This repo is the web service only.
