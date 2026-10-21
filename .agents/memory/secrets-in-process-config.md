---
name: Secrets in process configuration
description: Avoid plaintext secret copies in tracked process configuration.
---

After adding or updating a Replit secret, check both tracked process configuration and `.replit` shared environment overrides for plaintext copies. Keep application and process configuration wired to the environment variable rather than embedding the secret.

**Why:** a secure secret update was reflected as a literal in tracked process configuration despite application code using the environment variable. An imported `.replit` can independently retain credentials, so cleaning a PM2 configuration alone is not sufficient.

**How to apply:** inspect key names or parsed presence without printing values (including multiline keys), replace literal process assignments with `process.env` references, and remove shared environment overrides through environment-management tooling. Check that Secrets entries remain present, then restart the services and confirm startup. Never copy multiline secret blocks into diagnostic output.
