# Coregit API — Status Report

> Internal document. Last updated: March 31, 2026.

---

## 1. Current State

API is live at `api.coregit.dev`. 21/21 end-to-end tests passing in production.

### What works

- **API commit creation** — commit N files in 1 HTTP call (add, modify, delete). CAS conflict detection.
- **Full Git protocol** — `git clone`, `git push`, `git pull` via Smart HTTP. Any standard git client.
- **Branch operations** — create from any ref/SHA, list, delete, fast-forward merge.
- **File browsing** — read files, list directories, list refs.
- **Diff** — compare two refs, get changed files with addition/deletion counts.
- **Snapshots** — named restore points with metadata. Create, list, restore.
- **Public repos** — unauthenticated clone for public repositories.
- **Usage tracking** — API calls, repo creates, git transfer bytes.

### Coregit vs GitHub API

| Operation | Coregit | GitHub API |
|-----------|---------|-----------|
| Commit 3 files | **1 call** | 7 calls |
| Commit 10 files | **1 call** | 14 calls |
| Rate limits | None yet | 5,000/hour |
| Snapshots / restore points | **Yes** | No |
| Pay-per-use (no seat pricing) | **Yes** | No |

---

## 2. Security Issues

### Critical

| Issue | Impact |
|-------|--------|
| **File paths not validated in API commits** — accepts `..`, null bytes, empty segments | Malformed git objects, potential path traversal |
| **No rate limiting** — valid API key = unlimited requests | DoS, billing abuse, brute-force |
| **Blob read has no size cap** — loads entire file into Worker memory | OOM crash on large files |
| **Packfile generation unbounded** — clone of large repo has no timeout or size limit | Worker timeout, memory exhaustion |
| **Invalid base64 content crashes with 500** — should return 400 | Poor error handling, potential info leak |

### High

| Issue | Impact |
|-------|--------|
| No API key scopes — every key is full read+write | Can't issue read-only keys for CI |
| No commit message size limit | OOM on huge messages |
| Branch names not validated against git refname rules | Malformed refs |
| Partial R2 delete — DB deleted but orphaned objects remain | Storage leak |
| CORS origin check uses substring match | `localhost-evil.com` passes |
| Ref names in git push not validated | Malformed refs via push |
| No API key expiration | Compromised keys live forever |

### Medium

| Issue | Impact |
|-------|--------|
| No pagination on branch/ref lists | Huge responses on repos with many branches |
| Diff flattens entire tree into memory | Slow/OOM on large repos |
| Usage period parsing fragile (month overflow) | Wrong billing data |
| Usage events silently dropped on DB error | Incomplete billing |
| No request IDs in responses | Hard to debug issues |

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
| **Packfile generation** | Entire packfile built in memory, no timeout | Add timeout (25s), stream response |
| **Tree operations** | Sequential R2 reads for deep paths | Batch parallel reads |
| **Diff computation** | Reads all blobs twice (diff + stats) | Single pass, lazy stats |
| **Large file reads** | Entire blob loaded into memory | Stream response, reject >50MB |
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
- [ ] Fix CORS origin matching
- [ ] Implement rate limiting per API key
- [ ] Add API key scopes
- [ ] Add API key expiration

### P1 — Performance (before paid tier)

- [ ] Benchmark all endpoints (p50/p95/p99)
- [ ] Add packfile generation timeout
- [ ] Stream large file responses
- [ ] Parallelize tree reads
- [ ] Keyset pagination for repos, commits, usage
- [ ] Paginate branch/ref lists

### P2 — Reliability

- [ ] Transactional repo delete (R2 first, then DB)
- [ ] Retry failed usage events
- [ ] Request IDs in all responses
- [ ] Structured error codes
- [ ] Health check with DB ping

### P3 — Features

- [ ] Webhooks (push events, repo lifecycle)
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

### Our gaps
1. No rate limiting (must fix)
2. No webhooks (Phase 2)
3. No merge beyond fast-forward
4. No line-level diff
5. No code search
