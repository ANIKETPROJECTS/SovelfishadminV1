# Fresh Stock Xchange Admin — Run Guide

Follow these steps exactly when importing this project into a fresh Replit environment.

---

## 1. Set the Required Secrets

Before anything else, add the MongoDB connection string as a secret:

| Secret Name   | Value                                      |
|---------------|--------------------------------------------|
| `MONGODB_URI` | Your MongoDB Atlas connection URI          |
| `SESSION_SECRET` | A strong, randomly generated signing secret |

The URI must point to a cluster where Replit's IP is allowed. The app will use database `fishtokri_admin` automatically (the API server overrides the DB name in the URI). Both secrets are required for startup. Keep their values only in Replit Secrets, not in `.replit` or `ecosystem.config.cjs`.

To add the secret in Replit: open the **Secrets** panel (lock icon in the sidebar) → click **+ New Secret** → enter `MONGODB_URI` and the value.

---

## 2. Install Dependencies

Open the **Shell** tab and run:

```bash
pnpm install
```

This installs all 500+ packages across the monorepo. It only needs to run once after import. Subsequent runs are fast.

---

## 3. Start the App

Click **Run** to start the **Project** workflow. It runs two services in parallel:

1. **Start API** installs dependencies, builds the API, and runs `scripts/run-api.mjs` on **port 8080** (Express 5 + MongoDB).
2. **artifacts/fishtokri-admin: web** starts Vite on **port 5000** (React 19 + TailwindCSS 4), using the dependencies installed in step 2.

Allow time for dependency installation and the initial database connection. The API logs should show `Connected to MongoDB (fishtokri_admin)` and `Server listening`; frontend logs should show `VITE v7.x ready`.

Do not start another copy of either service on the same port. The old **Start Frontend** workflow has been replaced by the artifact-managed frontend workflow. `scripts/dev.sh` is an unused legacy frontend helper, not the artifact entry point.

---

## 4. Open the App

Once both servers are running, open the preview pane. You should see the **Fresh Stock Xchange** sign-in screen with a seafood market background and one **Master Admin** sign-in option.

If the preview pane shows blank on first load, wait a few more seconds and refresh — Vite is still compiling.

---

## 5. Log In

Select **Master Admin** on the role screen, then enter your admin email and password.

> ⚠️ Admin credentials are not stored in this file. Retrieve them from your password manager or internal documentation. Do not commit credentials to the repository.

---

## Architecture Reference

```
pnpm monorepo
├── artifacts/
│   ├── api-server/          Express 5 API  →  port 8080
│   └── fishtokri-admin/     React + Vite   →  port 5000 (preview)
├── lib/
│   ├── api-client-react/    React Query hooks used by frontend
│   ├── api-zod/             Zod schemas used by API server
│   └── db/                  (unused template package — safe to ignore)
└── scripts/
    ├── run-api.mjs          API runner using environment-injected secrets
    └── dev.sh               Optional frontend helper; waits for a separate API
```

**Vite** proxies all `/api/*` requests to `localhost:8080`, so the browser only talks to port 5000.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Blank preview after 30+ seconds | API server failed to start | Check workflow logs for `MONGODB_URI` errors |
| `MongoServerError: bad auth` | Wrong `MONGODB_URI` value | Re-check Secrets panel |
| `EADDRINUSE :8080` | Another API process is running | Stop the duplicate API process, then restart **Start API** |
| Login fails with 401 | Database not seeded | Confirm Atlas cluster has `fishtokri_admin` DB with `hub_users` collection |
| Vite shows `Module not found` | Dependencies not installed | Run `pnpm install` in shell |
