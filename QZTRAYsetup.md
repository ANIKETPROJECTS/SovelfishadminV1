# QZ Tray setup and integration guide

This guide explains how to add silent invoice or receipt printing through
[QZ Tray](https://qz.io/) to another web application. It is based on the
working Fresh Stock Xchange implementation, but the application-specific paths and
printer names must be adapted.

## 1. What QZ Tray does

QZ Tray is a desktop application that lets a browser send print jobs to
printers installed on the same computer. A hosted web application cannot
print directly to a user's local thermal printer without a local bridge such
as QZ Tray.

The flow is:

1. The user opens the web application in a browser on the computer connected
   to the printer.
2. The browser loads the QZ Tray JavaScript library.
3. QZ Tray opens a local WebSocket connection.
4. The browser asks the application backend for its public QZ certificate.
5. The browser sends the QZ signing challenge to the backend.
6. The backend signs that challenge with the private key.
7. QZ Tray verifies the signature and prints to the selected local printer.

The backend does not send the print job to the VPS printer. QZ Tray and the
printer must be installed on the operator's computer.

## 2. Prerequisites

For every computer that will print:

- QZ Tray installed and running.
- The target printer installed in the operating system and printing a test
  page.
- A supported modern browser.
- The web application opened over HTTPS in production. `http://localhost`
  is normally acceptable for local development.
- Permission for the browser to connect to QZ Tray.
- A stable printer name, or code that discovers the available printers.

For the application backend:

- A QZ public certificate in PEM format.
- The matching QZ private key in PEM format.
- Environment variables/secrets for both values.
- Two backend endpoints:
  - `GET /api/qz-certificate`
  - `POST /api/sign-message`

For the application frontend:

- QZ Tray JavaScript library, normally loaded from the QZ CDN or bundled
  according to the QZ Tray license and distribution guidance.
- A print function that loads QZ, configures security, connects, resolves a
  printer, and calls `qz.print`.

## 3. Credentials and secrets checklist

There are no QZ username/password credentials required for the basic local
printing flow. The required security material is certificate-based:

| Item | Where it is used | Secret? | Required |
|---|---|---:|---:|
| QZ public certificate | Backend response from `/api/qz-certificate` | No | Yes |
| QZ private key | Backend only, to sign QZ challenges | **Yes** | Yes |
| Private-key passphrase, if one is used | Backend secret/configuration | **Yes** | Optional |
| QZ Tray client installation | Each printing computer | No | Yes |
| Printer name | Frontend or printer configuration | No | Yes |
| Application login/session secret | Application authentication only | **Yes** | Only if the app has authentication |
| Database/API credentials | Application backend only | **Yes** | Only if the app needs them |

Do not put the private key, passphrase, database URI, or application secrets
in frontend code, a Git repository, an HTML file, a QR code, or this
document. Do not paste them into chat or screenshots.

Recommended environment variable names:

```text
QZ_CERTIFICATE=<public certificate PEM>
QZ_PRIVATE_KEY=<matching private key PEM>
QZ_PRIVATE_KEY_PASSPHRASE=<only if the key is encrypted>
```

The current Fresh Stock Xchange backend uses `QZ_CERTIFICATE` and `QZ_PRIVATE_KEY`.
Use the same names when reusing its backend route, or change the route and
deployment configuration together.

## 4. Obtain the QZ certificate and private key

Use the current QZ Tray documentation and official signing/certificate
process for production certificates. The certificate and private key must be
generated as a pair. A certificate from one pair cannot be combined with a
private key from another pair.

For a production deployment:

1. Create or obtain the QZ signing certificate using QZ's official process.
2. Keep the private key in a password manager or secret manager.
3. Keep the public certificate available to the backend.
4. Confirm that the certificate has not expired.
5. Confirm that the certificate's public key matches the private key.
6. Configure the two values as backend secrets.

For development, a development/self-signed certificate can be used if QZ
Tray is configured to trust it on the local computer. Do not silently move a
development certificate into production.

To check the public certificate without printing private material:

```bash
openssl x509 -in qz-certificate.pem -noout -subject -issuer -dates -fingerprint -sha256
```

To check that a private key corresponds to a certificate, compare public-key
moduli or public-key output using local secure tooling. Do not paste either
key into a terminal transcript or log. For an encrypted private key, configure
the passphrase through the backend's secret manager rather than hard-coding it.

## 5. Configure secrets in Replit

In the Replit workspace:

1. Open the Secrets/environment variables panel.
2. Add `QZ_CERTIFICATE` with the complete public certificate PEM.
3. Add `QZ_PRIVATE_KEY` with the complete matching private key PEM.
4. Add `QZ_PRIVATE_KEY_PASSPHRASE` only if the backend implementation
   supports and requires it.
5. Restart the backend workflow.
6. Never commit a `.env` file containing these values.

When storing multiline PEM values, preserve the PEM header and footer. If the
deployment UI does not preserve newlines, store escaped `\n` characters and
normalize them in the backend before passing the value to Node's crypto API.

## 6. Configure secrets on a VPS with PM2

Use the VPS secret manager or a root-readable environment file. Do not put
secrets in the frontend build directory.

Example PM2 ecosystem configuration with placeholders:

```js
module.exports = {
  apps: [{
    name: "your-api",
    script: "./dist/index.mjs",
    env: {
      NODE_ENV: "production",
      PORT: "8080",
      QZ_CERTIFICATE: "<public certificate PEM or normalized value>",
      QZ_PRIVATE_KEY: "<private key PEM or normalized value>"
    }
  }]
};
```

Prefer loading these values from a protected environment file rather than
committing them to the ecosystem file. Restrict its permissions:

```bash
chmod 600 /path/to/your/secret.env
```

After changing environment variables, restart PM2 with the updated
environment:

```bash
pm2 restart your-api --update-env
pm2 save
```

Do not use `pm2 restart` without `--update-env` when the values were changed
outside the current PM2 process environment.

## 7. Backend endpoints

The frontend security setup needs these endpoints on the same origin as the
application:

### `GET /api/qz-certificate`

Returns the public certificate as `text/plain`:

```text
-----BEGIN CERTIFICATE-----
...
-----END CERTIFICATE-----
```

The certificate may be public. The private key must never be returned by
this endpoint.

### `POST /api/sign-message`

Receives the exact string supplied by QZ Tray and returns a Base64 signature
as `text/plain`. The backend must sign the exact bytes without trimming,
parsing, or changing line endings.

Example Express implementation:

```ts
import { Router } from "express";
import { createSign } from "node:crypto";

const router = Router();

function normalizePem(raw: string): string {
  const value = raw.replace(/\\n/g, "\n").trim();
  const match = value.match(/-----BEGIN (.+?)-----/);
  if (!match) throw new Error("Invalid PEM");
  const type = match[1];
  const body = value
    .replace(/-----BEGIN .+?-----/g, "")
    .replace(/-----END .+?-----/g, "")
    .replace(/\s+/g, "");
  return `-----BEGIN ${type}-----\n${(body.match(/.{1,64}/g) || []).join("\n")}\n-----END ${type}-----`;
}

router.get("/qz-certificate", (_req, res) => {
  const certificate = process.env.QZ_CERTIFICATE;
  if (!certificate) return res.status(503).send("QZ certificate is not configured");
  res.type("text/plain").send(normalizePem(certificate));
});

router.post("/sign-message", (req, res) => {
  const privateKey = process.env.QZ_PRIVATE_KEY;
  if (!privateKey) return res.status(503).send("QZ private key is not configured");

  // This endpoint must receive text/plain and preserve the body exactly.
  const message = typeof req.body === "string" ? req.body : String(req.body ?? "");
  try {
    const signer = createSign("SHA512");
    signer.update(message);
    const signature = signer.sign(
      { key: normalizePem(privateKey), dsaEncoding: "der" },
      "base64",
    );
    res.type("text/plain").send(signature);
  } catch {
    res.status(500).send("QZ signing failed");
  }
});
```

Important backend details:

- Register a `text/plain` body parser before this route, or the request body
  may be empty/object-shaped.
- Mount the route under the same origin/path the frontend uses.
- Do not log the private key, signing input, or returned signature.
- Protect the endpoint with application authentication/rate limiting if the
  application is not intended to expose signing to the public internet.
- If authentication is required, the frontend signing request must include
  the user's auth header/cookie.
- Keep the certificate and private key from different environments separate
  unless the same certificate is intentionally trusted in both.

## 8. Frontend integration

The Fresh Stock Xchange implementation uses QZ Tray `2.2.4` from the CDN:

```ts
const QZ_CDN_URL =
  "https://cdn.jsdelivr.net/npm/qz-tray@2.2.4/qz-tray.min.js";
```

Load it once and configure QZ security before connecting:

```ts
qz.security.setCertificatePromise((resolve, reject) => {
  fetch("/api/qz-certificate")
    .then((response) => {
      if (!response.ok) throw new Error("Certificate request failed");
      return response.text();
    })
    .then(resolve)
    .catch(reject);
});

qz.security.setSignatureAlgorithm("SHA512");
qz.security.setSignaturePromise((toSign) => (resolve, reject) => {
  fetch("/api/sign-message", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: toSign,
  })
    .then((response) => {
      if (!response.ok) throw new Error("Signing request failed");
      return response.text();
    })
    .then(resolve)
    .catch(reject);
});

await qz.websocket.connect();
const printer = await qz.printers.find();
const config = qz.configs.create(printer, {
  size: { width: 80, height: null },
  units: "mm",
  margins: { top: 0, right: 0, bottom: 0, left: 0 },
  orientation: "portrait",
  scaleContent: true,
  colorType: "blackwhite",
});

await qz.print(config, [{
  type: "pixel",
  format: "html",
  flavor: "plain",
  data: htmlDocument,
}]);
```

For a second application, copy the reusable QZ utility concept—not the
invoice-specific HTML. Adapt:

- The API base path if the frontend and backend are on different origins.
- The certificate/signing endpoints.
- Printer selection and fallback behavior.
- Paper width and print margins.
- Invoice/receipt HTML.
- Authentication headers if the signing route is protected.

The existing Fresh Stock Xchange helper is:

```text
artifacts/fishtokri-admin/src/lib/qz-print.ts
```

It also:

- Reuses the loaded script and WebSocket connection.
- Tries preferred printer names, then discovers the first available printer.
- Returns a failure result so callers can fall back to `window.print()`.
- Uses 80 mm thermal-paper settings.

## 9. Printer configuration

Printer names are local to each operating system and computer. Never assume
that a printer name from one computer exists on another.

Recommended approach:

1. Install the printer driver.
2. Print an operating-system test page.
3. Open the QZ Tray test page or application printer list.
4. Record the exact printer name.
5. Configure an application preference or discover printers dynamically.
6. Test with a short receipt before printing a full invoice.

If the application uses preferred printer names, keep discovery as a fallback
so a renamed or newly installed printer does not make printing appear broken.

## 10. QZ Tray trust and browser setup

On each printing computer:

1. Install the current QZ Tray release.
2. Start QZ Tray and confirm its tray icon is visible.
3. Open the application over HTTPS.
4. When QZ Tray asks whether the site may connect, allow it.
5. If using a signed certificate, add/trust the certificate as required by
   QZ Tray's security dialog.
6. Keep QZ Tray running while the application is printing.
7. Confirm the browser is not blocking the local WebSocket connection.

QZ Tray is local software; installing it on the VPS does not make a printer
connected to an operator's laptop or phone available to the browser.

## 11. Test checklist

Run these tests in order:

1. QZ Tray is running.
2. The operating system can print a test page.
3. `GET /api/qz-certificate` returns `200` and a valid certificate.
4. `POST /api/sign-message` returns `200` when sent a test text body.
5. The certificate is trusted by QZ Tray.
6. The browser console has no certificate, WebSocket, CORS, or mixed-content
   errors.
7. The application discovers the expected printer.
8. A short test receipt prints.
9. The complete invoice prints.
10. The fallback browser print dialog still works when QZ Tray is stopped.

Safe endpoint checks (do not include secrets in command history):

```bash
curl -i https://your-domain.example/api/qz-certificate
curl -i -X POST https://your-domain.example/api/sign-message \
  -H 'Content-Type: text/plain' \
  --data 'qz-test-message'
```

The signature output is sensitive operational data; do not post it publicly.

## 12. Troubleshooting

### “QZ Tray connection timed out”

- QZ Tray is not installed or not running.
- Restart QZ Tray.
- Check that the browser is using HTTPS.
- Allow the site's QZ Tray connection.
- Check browser extensions, firewall, and local WebSocket blocking.

### “Certificate fetch failed”

- Confirm the backend route is deployed.
- Confirm `QZ_CERTIFICATE` exists in the environment used by the running
  process.
- Restart PM2 with `--update-env`.
- Check that the PEM header/footer were preserved.

### “Signing failed” or a QZ security rejection

- Confirm `QZ_PRIVATE_KEY` exists in the running backend.
- Confirm the private key matches `QZ_CERTIFICATE`.
- Confirm the backend signs the exact request body.
- Confirm the configured signature algorithm matches the certificate/key.
- Check that the certificate is trusted and not expired.
- Do not regenerate only one half of the certificate/key pair.

### “No printers found”

- Install the printer driver.
- Confirm the printer is online.
- Check the exact local printer name.
- Use `qz.printers.find()` to list available printers.
- Remember that the printer must be connected to the computer running QZ Tray,
  not merely to the VPS.

### It works on Replit but not on the VPS

- Confirm both deployments have the QZ certificate and matching private key.
- Confirm the VPS process loaded the updated environment with
  `pm2 restart ... --update-env`.
- Confirm the VPS frontend calls relative `/api/...` paths or the correct API
  origin.
- Confirm HTTPS and CORS configuration.
- Trust the deployed domain/certificate in QZ Tray on the local computer.
- Clear old browser cache/service-worker assets if the frontend still points to
  an old API.

### Print works only after opening the browser dialog

The app is probably falling back to `window.print()`. Inspect the returned
QZ error and verify QZ Tray, certificate, signing, and printer discovery in
that order.

## 13. Deployment security rules

- Keep `QZ_PRIVATE_KEY` backend-only.
- Do not expose private-key environment variables through a frontend build.
- Do not log environment variables or signing requests.
- Use HTTPS in production.
- Restrict `/api/sign-message` if the application has authenticated operators.
- Add rate limiting and monitoring to the signing endpoint for internet-facing
  deployments.
- Rotate the certificate/key pair according to your operational policy and
  whenever the private key may have been exposed.
- Rotate any application or database secrets separately; they are not QZ
  credentials.

## 14. Minimal implementation inventory

For a new application, the implementation is complete when it has:

- QZ Tray installed on each printing computer.
- A valid, trusted certificate/private-key pair.
- `QZ_CERTIFICATE` and `QZ_PRIVATE_KEY` configured in the backend secret store.
- A text-preserving signing endpoint.
- A certificate endpoint.
- The QZ Tray JavaScript client loaded once.
- QZ security configured before printing.
- Printer discovery or a configurable printer name.
- HTML sized for the target paper.
- A browser-print fallback.
- A tested production HTTPS deployment.
