# FishTokri Admin

Operations console for the FishTokri seafood distribution network.

## Stack
- **Frontend:** React 19, Vite 7, TailwindCSS 4, TanStack Query v5, Wouter routing, shadcn/ui (Radix UI)
- **Backend:** Express 5, MongoDB (Mongoose), Zod validation, Pino logging
- **Monorepo:** pnpm workspaces (`pnpm-workspace.yaml`)
- **Shared packages:** `lib/api-client-react`, `lib/api-zod`, `lib/db`

## How to run on Replit

Click **Run** to start the **Project** workflow, which runs both services:

| Workflow | Command | Port |
|---|---|---|
| **Start API** | `pnpm install && cd artifacts/api-server && pnpm run build && cd ../.. && PORT=8080 node --enable-source-maps scripts/run-api.mjs` | 8080 |
| **Start Frontend** | `pnpm install && cd artifacts/fishtokri-admin && PORT=5000 BASE_PATH=/ pnpm run dev` | 5000 |

The frontend proxies `/api` requests to the API at port 8080 (configured in `vite.config.ts`).

## Secrets
`MONGODB_URI` and `SESSION_SECRET` are configured for this import. Feature-specific credentials below are not required to display the login screen. Keep all credentials in Secrets, never in tracked process configuration.

| Secret | Purpose |
|---|---|
| `MONGODB_URI` | MongoDB Atlas connection string |
| `SESSION_SECRET` | Express session signing |
| `CLOUDINARY_CLOUD_NAME` | Optional: Cloudinary image uploads |
| `CLOUDINARY_API_KEY` | Optional: Cloudinary image uploads |
| `CLOUDINARY_API_SECRET` | Optional: Cloudinary image uploads |
| `QZ_CERTIFICATE` | Optional: QZ Tray print certificate |
| `QZ_PRIVATE_KEY` | Optional: QZ Tray print signing key |

## Project structure
```
artifacts/
  api-server/       # Express API (build → dist/index.mjs)
  fishtokri-admin/  # React + Vite admin dashboard
  mockup-sandbox/   # Component prototyping (design only)
lib/
  api-client-react/ # Shared React Query hooks
  api-zod/          # Shared Zod schemas
  db/               # DB utilities
scripts/
  dev.sh            # Waits for API health before starting frontend
```

## Notes
- The API has **no watch mode** — after editing `api-server/src/`, restart the `Start API` workflow to rebuild and reload.
- Login requires user accounts seeded in MongoDB (`hub_users` collection).

## Startup verified on Replit (2026-10-21)

Both workflows must be running simultaneously:

1. **Start API** — installs deps, builds `artifacts/api-server` with esbuild, starts Express on port 8080.
   Expected log lines confirming healthy boot:
   ```
   INFO: Connected to MongoDB (fishtokri_admin)
   INFO: Server listening  port: 8080
   INFO: Connected to sub hub DB  dbName: "orders"
   ```

2. **Start Frontend** — installs deps, starts Vite dev server on port 5000.
   Expected output: `VITE v7.x  ready in ...ms`

Verified: MongoDB connection, API health through the frontend proxy (`/api/healthz` returns `{"status":"ok"}`), and the rendered account-selection screen without browser errors. Authenticated dashboard screens have not been verified.

The imported lockfile contained firewall-blocked versions of Express's proxy dependency and Orval. Express was updated within version 5 and Orval within version 8; a full frozen-lockfile install now succeeds.

The login screen is served at `/` — account type selection (Master Admin / Super Hub / Sub Hub / Delivery Partner). Users must exist in the `hub_users` MongoDB collection.

Existing credentials previously embedded in the imported PM2 configuration were replaced with environment references. Rotate previously committed credentials; removing them from the current file does not remove them from Git history.
