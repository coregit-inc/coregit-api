# CoreGit API — Roadmap: догнать GitHub

> Статус: в работе | Обновлено: 2026-04-03

## P0 — Security (блокирует запуск)

- [x] **Rate limiting per API key** — sliding window 600 req/min, 15K/hr (в памяти)
- [x] **API key expiration** — `expires_at` проверяется в middleware (column уже был)
- [x] ~~CORS fix~~ — уже strict equality
- [x] ~~Scoped tokens~~ — уже есть (cgt_*)
- [x] ~~Validation~~ — paths, refs, base64, blob size

## P1 — Reliability (перед paid tier)

- [x] **Request ID на все ответы** — top-level middleware, X-Request-Id в каждом response
- [x] **Structured error codes** — `errorResponse()` helper + `code` field
- [x] **Health check с DB ping** — `/health` проверяет Neon

## P2 — Performance

- [x] **Packfile timeout** — abort через 25s, 504 с подсказкой `--depth 1`
- [x] **Keyset pagination** — repos, commits, usage (cursor вместо offset, backward compat offset)
- [x] **Paginate branch/ref lists** — limit+cursor (branches, refs endpoints)

## P3 — Features (конкурентный паритет)

- [x] **Webhooks** — CRUD routes + HMAC-SHA256 delivery service (push, repo.*, branch.*)
- [x] **Line-level diff** — unified patch format (`?patch=true&context=3`), Myers algorithm
- [x] **API key expiration UI** — в coregit-app (Select expiry при создании, Status badge, Last used)

## P4 — AI-Native Features (конкурентное преимущество)

- [x] **Cross-repo code search** — `POST /v1/search` (regex, path globs, context lines, 20s deadline)
- [x] **Multi-repo workspace** — `POST /v1/workspace/exec` (mount N repos at /{slug}/, exec + commit per-repo)

## Не в скоупе (GitHub-only)

- PR/MR flow, Issues, CI/CD, SSH, GraphQL — отложено
