---
name: bfa-requirements
description: Project-wide non-negotiable requirements for bfa-platform — portability (no Vercel-proprietary lock-in), security/compliance (crypto, structured logging, RLS), Docker readiness, and documentation maintenance in apps/fumadocs. Load before adding dependencies, scheduled/background jobs, PDF generation, auth or sensitive DB-write code, new Supabase tables/migrations, or any feature change.
user-invocable: false
---

# bfa-platform Project Requirements

## Portability

- No Vercel-proprietary features without explicit sign-off: Vercel Cron, Vercel KV, Vercel Blob, Vercel Postgres, Edge Middleware/Edge Runtime.
- Scheduled/background jobs: application-level, Node-native scheduler only (not Vercel Cron, not OS cron). Persist schedule state in Supabase. On startup, detect and reprocess missed jobs.
- PDF generation: no headless-Chrome libraries (Puppeteer, Playwright) for simple form-style reports. Use a lightweight, dependency-light PDF library.
- All config (API keys, endpoints, secrets) from environment variables — never hardcoded, never committed.

## Security / compliance

- New crypto/token/auth dependencies must use FIPS-compatible algorithms (AES-256, SHA-256). Flag MD5, SHA-1, DES for review before adding.
- Every auth event and sensitive DB row modification emits a structured JSON log via `console.log(JSON.stringify({ event, actor_id, target_..., wp_id, timestamp }))` — never a plain string.
- Update operations that do not change persisted values are no-ops: they must not issue an effective update, change `updated_at`, or create audit/event records. Mutations with audit behavior require regression tests for both no-op saves and real changes.
- Multi-tenant isolation is enforced via Supabase RLS. Every new table has RLS enabled from its first migration. Every feature touching WP-scoped data has an explicit RLS policy — application-level filtering alone is not sufficient.

## Docker readiness

- App must build and run cleanly via a standard Dockerfile at any time, even though MVP deploys to Vercel. Avoid code that only works in a Vercel-hosted context.

## Documentation maintenance

- Living documentation is `apps/fumadocs` (Fumadocs), content as MDX under `apps/fumadocs/content/docs` — source of truth for how the app works.
- Any feature added, changed, or removed: update the corresponding page(s) under `apps/fumadocs/content/docs` in the same PR as the code change, not later.
- Maintain a running development-plan page under `apps/fumadocs/content/docs` (mirrors the phase table in Section 7 of the kickoff runbook); keep it current as PRD subsections move planned → in-progress → done.
- When in doubt, document it — `apps/fumadocs` alone should explain the app's current state without reading every commit.
