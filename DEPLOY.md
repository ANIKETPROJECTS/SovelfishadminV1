# Fresh Stock Xchange — VPS Deployment Guide (Ubuntu)

Deploys the API (Express) + Admin Frontend (React static) on a single Ubuntu server.  
External access: **port 3015**. Nginx proxies to the API on internal port 8080 and serves the frontend static files.

---

## Before You Start — Fill In Secrets

Open `ecosystem.config.cjs` and replace the three placeholders with your real values:

| Placeholder | Where to find the real value |
|---|---|
| `REPLACE_WITH_YOUR_MONGODB_URI` | MongoDB Atlas → Connect → Drivers → copy the connection string |
| `REPLACE_WITH_YOUR_SESSION_SECRET` | Any long random string (32+ chars) — e.g. run `openssl rand -hex 32` on your laptop |
| `REPLACE_WITH_YOUR_CLOUDINARY_API_SECRET` | Cloudinary dashboard → API Keys section |

The file already has `CLOUDINARY_CLOUD_NAME` and `CLOUDINARY_API_KEY` filled in.

---

## Step 1 — Install Required Software

SSH into your Ubuntu VPS, then run these commands one by one.

### 1a. Update system packages
```bash
sudo apt update && sudo apt upgrade -y
```

### 1b. Install Node.js 20 (LTS)
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v    # should print v20.x.x
npm -v     # should print 10.x.x
```

### 1c. Install pnpm (via npm — this is the one npm command needed to unlock pnpm workspaces)
```bash
npm install -g pnpm
pnpm -v    # confirm it installed
```

> **Why pnpm?** The project uses pnpm workspaces with `catalog:` version aliases that only pnpm understands. Installing pnpm via npm is the workaround — all subsequent build commands use standard `npm run build`.

### 1d. Install PM2
```bash
npm install -g pm2
pm2 -v     # confirm
```

### 1e. Install Nginx
```bash
sudo apt install -y nginx
sudo systemctl enable nginx
sudo systemctl start nginx
```

### 1f. Install Certbot (for HTTPS — optional, skip if port 80/443 not available)
```bash
sudo apt install -y certbot python3-certbot-nginx
```

---

## Step 2 — Clone the Project

```bash
sudo mkdir -p /var/www/fishtokri
sudo chown $USER:$USER /var/www/fishtokri
cd /var/www/fishtokri

# Clone your repo (replace with your actual git URL)
git clone https://github.com/YOUR_USERNAME/YOUR_REPO.git .
```

---

## Step 3 — Fill In Your Secrets

```bash
nano ecosystem.config.cjs
```

Replace the three `REPLACE_WITH_YOUR_*` placeholders with your real values. Save with `Ctrl+O`, exit with `Ctrl+X`.

---

## Step 4 — Install & Build

```bash
cd /var/www/fishtokri
npm install
npm run build
```

`npm install` installs root tooling.  
`npm run build` automatically runs `pnpm install` (resolves all workspace and `catalog:` deps) then builds both the API and the frontend.

After this you will have:
- `artifacts/api-server/dist/index.mjs` — the bundled API server
- `artifacts/fishtokri-admin/dist/public/` — the built React static files

---

## Step 6 — Start the API with PM2

```bash
cd /var/www/fishtokri
pm2 start ecosystem.config.cjs
pm2 save           # save so it auto-starts on reboot
pm2 startup        # follow the printed command to enable startup on boot
```

Check it started:
```bash
pm2 list
pm2 logs fishtokri-api --lines 30
```

The API is now running on **localhost:8080** (internal only).

---

## Step 7 — Configure Nginx

Create a new site config:
```bash
sudo nano /etc/nginx/sites-available/fishtokri
```

Paste this (replace `YOUR_SERVER_IP_OR_DOMAIN` with your actual IP or domain):

```nginx
server {
    listen 3015;
    server_name YOUR_SERVER_IP_OR_DOMAIN;

    # Serve the React frontend (built static files)
    root /var/www/fishtokri/artifacts/fishtokri-admin/dist;
    index index.html;

    # All API requests proxy to the Express server
    location /api/ {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
        client_max_body_size 50M;
    }

    # React Router — send all non-file requests to index.html
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Enable gzip compression for static assets
    gzip on;
    gzip_types text/plain text/css application/javascript application/json image/svg+xml;
}
```

Enable the site and reload Nginx:
```bash
sudo ln -s /etc/nginx/sites-available/fishtokri /etc/nginx/sites-enabled/
sudo nginx -t          # test config — must say "ok"
sudo systemctl reload nginx
```

---

## Step 8 — Open the Firewall Port

```bash
sudo ufw allow 3015/tcp
sudo ufw status        # confirm it shows 3015 ALLOW
```

---

## Step 9 — Test It

Open a browser and go to:
```
http://YOUR_SERVER_IP:3015
```

You should see the Fresh Stock Xchange Admin sign-in page.

Check the API directly:
```
http://YOUR_SERVER_IP:3015/api/
```

---

## Optional — Add HTTPS with Certbot

> Only works if you have a domain name pointed at your server AND port 80 is free.

```bash
sudo certbot --nginx -d yourdomain.com
```

Certbot will automatically update your Nginx config for HTTPS. After this, access the app at `https://yourdomain.com:3015` (or move to port 443 if it's free).

---

## Day-to-Day Commands

### Pull latest code and redeploy
```bash
cd /var/www/fishtokri
git pull
npm install
npm run build
pm2 restart fishtokri-api --update-env
```

### View live API logs
```bash
pm2 logs fishtokri-api
```

### Restart / stop the API
```bash
pm2 restart fishtokri-api
pm2 stop fishtokri-api
```

### Reload Nginx after config changes
```bash
sudo nginx -t && sudo systemctl reload nginx
```

---

## Troubleshooting

| Problem | Check |
|---|---|
| Browser shows "Connection refused" | `sudo ufw allow 3015/tcp` and `pm2 list` (is the API running?) |
| API returns 500 errors | `pm2 logs fishtokri-api` — look for MongoDB connection errors |
| White screen / React not loading | `pm2 logs fishtokri-api` — check for JS errors; also confirm dist folder exists |
| Nginx "permission denied" | `sudo chown -R www-data:www-data /var/www/fishtokri/artifacts/fishtokri-admin/dist` |
| MongoDB connection fails | Check your MONGODB_URI in `ecosystem.config.cjs` and that your Atlas IP whitelist includes the VPS IP |

---

## Security Note

`ecosystem.config.cjs` contains your credentials in plain text. Make sure to:
- Add it to `.gitignore` so it is never pushed to GitHub
- Set permissions: `chmod 600 ecosystem.config.cjs`
