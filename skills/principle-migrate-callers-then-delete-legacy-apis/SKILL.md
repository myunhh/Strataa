---
name: principle-migrate-callers-then-delete-legacy-apis
description: "Apply when introducing a new internal API while old callers still exist. Migrate callers and delete the old API in the same wave instead of preserving compatibility layers."
---

# OMP native entrypoint

Before applying this skill, resolve this entrypoint’s actual filesystem path, following symlinks. The bundle root is two directories above its containing directory. Resolve `<bundle-root>/pstack-omp.md` to an absolute path and read it first. Then resolve and read `<bundle-root>/vendor/pstack/skills/principle-migrate-callers-then-delete-legacy-apis/SKILL.md` in full by absolute path. Do not resolve from the working directory or search Cursor installations. Missing paths or unreadable instructions are a dependency failure to report, not permission to skip loading.

The adapter and host instructions override conflicting upstream behavior, including models, delegation, permissions, verification, and platform-only commands. Follow the original task goals and resolve original relative references within the unchanged vendor tree. Do not copy or reinterpret the original body as a substitute for reading it.
