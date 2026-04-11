# Coregit API — Status Report

> Internal document. Last updated: April 11, 2026.

---

## 1. Current State

API is live at `api.coregit.dev`. 21/21 end-to-end tests passing in production.

### What works

- **API commit creation** — commit N files in 1 HTTP call (add, modify, delete). CAS conflict detection.
- **Full Git protocol** — `git clone`, `git push`, `git pull` via Smart HTTP. Any standard git client.
- **Branch operations** — create from any ref/SHA, list, delete, fast-forward merge.
- **File browsing** — read files, list directories, list refs.
- **Diff** — compare two refs, get changed files with addition/deletion counts.
- **Compare** — merge-base, ahead/behind counts, mergeable check.
- **Cherry-pick** — cherry-pick commits onto a new base.
- **Snapshots** — named restore points with metadata. Create, list, restore.
- **Public repos** — unauthenticated clone and browse for public repositories.
- **Usage tracking** — API calls, repo creates, git transfer bytes, storage.
- **API key scopes** — read-only, write, and fine-grained per-repo scoped tokens.
- **Rate limiting** — per-key (600/min), per-org (2000/min), per-IP for public routes (1000/min).
- **Git LFS** — batch upload/download with presigned R2 URLs, tier-based limits.
- **Sync** — import/export with GitHub and GitLab, auto-sync on push via webhooks.
- **Webhooks** — configurable outgoing webhooks on push events.
- **Code search** — cross-repo semantic search and code graph indexing.
- **Custom domains** — git clone/push via custom domains with cached org resolution.
- **Wiki** — per-repo wiki with git-backed storage.
- **Forks** — fork repos within an org.

### Coregit vs GitHub API

| Operation | Coregit | GitHub API |
|-----------|---------|-----------|
| Commit 3 files | **1 call** | 7 calls |
| Commit 10 files | **1 call** | 14 calls |
| Rate limits | 600/min per key | 5,000/hour |
| Snapshots / restore points | **Yes** | No |
| Pay-per-use (no seat pricing) | **Yes** | No |

---

## 2. Security Issues

### Critical

All previously-identified critical issues have been resolved.

| Issue | Status |
|-------|--------|
| ~~File paths not validated in API commits~~ | **Fixed** — path traversal and null bytes rejected |
| ~~No rate limiting~~ | **Fixed** — per-key, per-org, and per-IP rate limiting on all routes |
| ~~Blob read has no size cap~~ | **Fixed** — rejects >50MB |
| ~~Packfile generation unbounded~~ | **Fixed** — 25s timeout, returns 504 with shallow clone hint |
| ~~Invalid base64 content crashes with 500~~ | **Fixed** — returns 400 |

### High

| Issue | Status |
|-------|--------|
| ~~No API key scopes~~ | **Fixed** — scoped tokens with read/write/per-repo permissions |
| ~~No commit message size limit~~ | **Fixed** |
| ~~Branch names not validated~~ | **Fixed** — git refname rules enforced |
| ~~Ref names in git push not validated~~ | **Fixed** — `isValidRefPath()` check |
| CORS origin check uses substring match | Open — `localhost-evil.com` could pass in dev mode |
| No API key expiration | Open — compromised keys live forever |
| Partial R2 delete — DB deleted but orphaned objects remain | Open — storage leak |

### Medium

| Issue | Status |
|-------|--------|
| ~~No request IDs in responses~~ | **Fixed** — X-Request-Id on all responses |
| No pagination on branch/ref lists | Open |
| Diff flattens entire tree into memory | Open — slow/OOM on large repos |
| Usage events silently dropped on DB error | Open |

---

## 3. Performance

### Current latency (estimated, not formally benchmarked)

| Operation | Estimate | Bottleneck |
|-----------|----------|-----------|
| Create repo | ~200ms | 4 R2 writes + 1 DB insert |
| API commit (3 files) | ~300ms | Blob hashing + tree build + CAS ref update |
| Read file | ~100ms | 1 R2 read + decompress |
| List repos | ~50ms | 1 DB query |
| Clone (small repo) | ~500ms | In-memory packfile generation |
| Diff (100 files changed) | ~800ms | Two full tree walks + blob reads for stats |

### Optimization opportunities

| Area | Current problem | Expected improvement |
|------|----------------|---------------------|
| **Tree operations** | Sequential R2 reads for deep paths | Batch parallel reads |
| **Diff computation** | Reads all blobs twice (diff + stats) | Single pass, lazy stats |
| **Large file reads** | Entire blob loaded into memory | Stream response |
| **Pagination** | Offset-based (slow on large sets) | Keyset cursor pagination |
| **Object cache** | 32MB per-request cache, no cross-request | Consider KV cache for hot objects |

### Targets (before paid tier)

| Metric | Target |
|--------|--------|
| API read latency (p95) | <500ms |
| API commit latency (p95) | <1s |
| Git clone (repo <100MB, p95) | <2s |
| Error rate | <0.1% |
| Uptime | 99.9% |

---

## 4. Tasks

### P0 — Security (before any external users)

- [x] Validate file paths in API commits
- [x] Validate branch/ref names
- [x] Validate commit message length
- [x] Validate base64 content (catch errors, return 400)
- [x] Cap blob read size (reject >50MB)
- [x] Implement rate limiting per API key
- [x] Implement rate limiting per organization
- [x] Implement per-IP rate limiting for public routes
- [x] Rate limit Git Smart HTTP (clone/push/pull)
- [x] Rate limit Git LFS endpoints
- [x] Rate limit sync webhooks
- [x] Add API key scopes (read-only, write, per-repo)
- [x] Validate ref names in git push
- [x] Expose rate limit headers in CORS
- [ ] Fix CORS origin matching (dev mode substring match)
- [ ] Add API key expiration

### P1 — Performance (before paid tier)

- [x] Add packfile generation timeout (25s)
- [ ] Benchmark all endpoints (p50/p95/p99)
- [ ] Stream large file responses
- [ ] Parallelize tree reads
- [ ] Keyset pagination for repos, commits, usage
- [ ] Paginate branch/ref lists

### P2 — Reliability

- [x] Request IDs in all responses
- [x] Health check with DB ping
- [x] Structured error codes
- [ ] Transactional repo delete (R2 first, then DB)
- [ ] Retry failed usage events

### P3 — Features (shipped)

- [x] Webhooks (push events, repo lifecycle)
- [x] Code search (semantic + code graph)
- [x] Sync from external providers (GitHub, GitLab)
- [x] Git LFS support
- [x] Custom domains
- [x] Wiki
- [x] Forks

### P3 — Features (remaining)

- [ ] Line-level diff (unified patch format)
- [ ] 3-way merge strategy
- [ ] TypeScript SDK (`@coregit/sdk`)

---

## 5. Metrics to Track

**Engineering:** p50/p95/p99 latency per endpoint, error rate (4xx/5xx), R2 ops per request, DB query time, Worker CPU time, packfile generation time.

**Alerting:** Error rate >1% for 5min, p95 >2s for 5min, Worker CPU >25s (limit 30s), DB connection failures.

---

## 6. Competitive Position

### Our advantages
1. **Single-call batch commits** — nobody else does this
2. **Serverless economics** — no idle infra, pay per operation
3. **Snapshots** — named restore points for agent rollback
4. **Zero ops** — one API key replaces GitHub org + tokens + webhooks
5. **Built-in sync** — bidirectional GitHub/GitLab sync
6. **Code search** — semantic and code graph search across repos

### Our gaps
1. No line-level diff
2. No 3-way merge
3. No TypeScript SDK yet
