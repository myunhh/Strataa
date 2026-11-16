---
name: make-bot-ui
description: >-
  Use when building a custom UI (page, dashboard, buttons) that should wake a
  Grok Bot over a webhook, when the user must provide a webhook sender key, or
  when exposing that UI on Tailscale.
---

# OMP native entrypoint

Before applying this skill, resolve this entrypoint’s actual filesystem path, following symlinks. The bundle root is two directories above its containing directory. Resolve `<bundle-root>/pstack-omp.md` to an absolute path and read it first. Then resolve and read `<bundle-root>/vendor/pstack/skills/make-bot-ui/SKILL.md` in full by absolute path. Do not resolve from the working directory or search Cursor installations. Missing paths or unreadable instructions are a dependency failure to report, not permission to skip loading.

The adapter and host instructions override conflicting upstream behavior, including models, delegation, permissions, verification, and platform-only commands. Follow the original task goals and resolve original relative references within the unchanged vendor tree. Do not copy or reinterpret the original body as a substitute for reading it.
