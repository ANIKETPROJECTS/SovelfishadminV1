---
name: Artifact workflow configuration
description: Protected manifest editing and avoiding misleading success from duplicate frontend workflows.
---

Update artifact-managed startup commands through the artifact manifest, not ordinary workflow configuration. Use portable workspace-relative commands rather than imported absolute workspace paths.

**Why:** A separately running frontend can serve the app while its registered artifact remains failed. Ordinary workflow configuration cannot override artifact-managed workflows, and direct manifest edits are protected.

**How to apply:** Check the exact artifact-managed workflow, not just whether its port responds. For manifest updates, write sibling temporary TOML and use `verifyAndReplaceArtifactToml({ tempFilePath, artifactTomlPath })` with absolute paths. Root `.replit` changes similarly require `verifyAndReplaceDotReplit({ tempFilePath })`. Keep one frontend owner, and ensure Run targets that owner.
