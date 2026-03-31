# Coregit API — Status, Benchmarks & Roadmap

> Internal document for co-founders. Last updated: March 31, 2026.

---

## 1. What We Ship Today

Coregit API is live at `api.coregit.dev`. A serverless Git backend on Cloudflare Workers + R2 + Neon PostgreSQL.

### Endpoints (21/21 tests passing)

| Endpoint | Method | What it does |
|----------|--------|-------------|
| `/v1/repos` | POST | Create repository (with optional initial commit) |
| `/v1/repos` | GET | List repos (paginated) |
| `/v1/repos/:slug` | GET | Get repo details + isEmpty check |
| `/v1/repos/:slug` | PATCH | Update description, visibility, default branch |
| `/v1/repos/:slug` | DELETE | Delete repo + all R2 objects |
| `/v1/repos/:slug/branches` | POST | Create branch from any ref or SHA |
| `/v1/repos/:slug/branches` | GET | List all branches |
| `/v1/repos/:slug/branches/:name` | GET | Get branch SHA |
| `/v1/repos/:slug/branches/:name` | DELETE | Delete branch |
| `/v1/repos/:slug/branches/:name/merge` | POST | Fast-forward merge |
| `/v1/repos/:slug/commits` | **POST** | **API commit — create commit from file changes (killer feature)** |
| `/v1/repos/:slug/commits` | GET | List commit history |
| `/v1/repos/:slug/commits/:sha` | GET | Get single commit |
| `/v1/repos/:slug/refs` | GET | List branches + tags |
| `/v1/repos/:slug/tree/:ref/*` | GET | Browse directory |
| `/v1/repos/:slug/blob/:ref/*` | GET | Read file content |
| `/v1/repos/:slug/diff` | GET | Compare two refs |
| `/v1/repos/:slug/snapshots` | POST/GET/DELETE | Named restore points |
| `/v1/repos/:slug/snapshots/:name/restore` | POST | Restore branch to snapshot |
| `/v1/usage` | GET | Usage summary (repos, API calls, transfer) |
| `/:org/:repo.git/*` | Git HTTP | Full git clone/push/pull |

### What's proven

- **API commit creation**: 3 files committed in 1 HTTP call. Modify + add + delete in 1 call. CAS conflict detection works.
- **Git protocol**: Standard `git clone` and `git push` work with any git client.
- **Public repos**: Unauthenticated clone for public repos.
- **Snapshots**: Create, list, restore — full lifecycle.
- **Usage tracking**: API calls, repo creates, git transfer bytes tracked.

---

## 2. Architecture & Performance Characteristics

```
Client → Cloudflare Edge (Workers) → R2 (objects) + Neon (metadata)
```

| Layer | Technology | Latency | Limits |
|-------|-----------|---------|--------|
| Compute | CF Workers | ~5ms cold start | 30s CPU / request |
| Object storage | CF R2 | ~10-50ms per object | No egress fees |
| Database | Neon Serverless PG | ~20-50ms per query | HTTP driver, no connection pool |
| Git objects | zlib-compressed in R2 | Loose objects only | No packfile optimization yet |

### Current bottlenecks

| Operation | Current | Why | Target |
|-----------|---------|-----|--------|
| Create repo | ~200ms | 4 R2 writes (HEAD, tree, commit, ref) + 1 DB insert | <150ms |
| API commit (3 files) | ~300ms | Hash + compress + write blobs + build tree + write commit + CAS ref | <200ms |
| Clone (small repo) | ~500ms | Packfile generation in-memory | <300ms |
| Diff (100 files) | ~800ms | Flatten both trees + read all blobs for stats | <400ms |
| List repos | ~50ms | Single DB query | OK |

### Comparison: Coregit vs GitHub API

| Operation | Coregit | GitHub API | Notes |
|-----------|---------|-----------|-------|
| Create repo | 1 call | 1 call | Same |
| Commit 3 files | **1 call** | **7 calls** (3 blobs + tree + commit + ref + verify) | Our killer advantage |
| Commit 10 files | **1 call** | **14 calls** | Scales linearly for GitHub |
| Read file | 1 call | 1 call | Same |
| List tree | 1 call | 1 call | Same |
| Diff two branches | 1 call | 1 call | GitHub has richer diff (line-level patches) |
| Create branch | 1 call | 1 call | Same |
| Clone via git | Works | Works | Same protocol |
| Rate limits | **None yet** | 5,000/hour (authenticated) | GitHub is strict |
| Batch operations | **Native** | Requires GraphQL for some | We win on simplicity |

---

## 3. Security Audit — Issues Found

### Critical (must fix before public launch)

| # | Issue | Where | Risk |
|---|-------|-------|------|
| 1 | **File path not validated** — commits accept paths with `..`, null bytes | `commits.ts` | Path traversal, malformed git objects |
| 2 | **No rate limiting** — any valid API key can make unlimited requests | `middleware.ts` | DoS, billing abuse |
| 3 | **Large file no size cap on read** — blob endpoint loads entire file into memory | `files.ts` | OOM crash on 100MB+ files |
| 4 | **Packfile generation unbounded** — clone of large repo has no timeout | `git.ts` | Worker timeout, memory exhaustion |
| 5 | **Base64 decode crashes on invalid input** — returns 500 instead of 400 | `commit-builder.ts` | Bad UX, error handling gap |

### High (fix before paid customers)

| # | Issue | Where | Risk |
|---|-------|-------|------|
| 6 | No API key scopes — all keys are read+write | `middleware.ts` | Can't issue read-only keys |
| 7 | No commit message size limit | `commits.ts` | OOM on huge messages |
| 8 | Branch name not validated against git refname rules | `branches.ts` | Malformed refs |
| 9 | Partial R2 delete on error — DB deleted but objects remain | `repos.ts` | Storage leak, billing waste |
| 10 | CORS origin check uses startsWith — allows localhost-evil.com | `index.ts` | Security bypass |

### Medium (fix in next quarter)

| # | Issue | Where |
|---|-------|-------|
| 11 | Offset-based pagination — slow on large datasets | repos, usage |
| 12 | No pagination on branches/refs list | branches.ts, files.ts |
| 13 | Diff flattens entire tree — slow on large repos | diff.ts |
| 14 | Usage period parsing fragile (month overflow) | usage.ts |
| 15 | Fire-and-forget usage events silently dropped on error | usage.ts |

---

## 4. Tasks — Hardening Sprint

### P0: Security & Correctness (this week)

- [ ] **Validate file paths in API commits** — reject `..`, null bytes, empty segments, leading `/`
- [ ] **Validate branch names** — alphanumeric + hyphens + slashes, no `..`, no leading `.`
- [ ] **Validate commit message length** — max 64KB
- [ ] **Validate base64 content** — try/catch atob, return 400 on invalid
- [ ] **Add file size limit to blob read** — return 413 if blob > 50MB, suggest raw download
- [ ] **Fix CORS origin check** — exact match for localhost origins

### P1: Rate Limiting & Auth (this week)

- [ ] **Implement rate limiting** — per API key, 1000 req/min default
  - Use Cloudflare's `cf.cacheKey` or in-memory sliding window
  - Return 429 with `Retry-After` header
- [ ] **Add API key scopes** — `repos:read`, `repos:write`, `git:read`, `git:write`
  - Column `scopes TEXT[]` in api_key table
  - Check in middleware before allowing operation
- [ ] **Add API key expiration** — `expires_at` column, check in middleware

### P2: Performance (next 2 weeks)

- [ ] **Benchmark all endpoints** — measure p50, p95, p99 latency
  - Tool: k6 or custom script with `time curl`
  - Target: p95 < 500ms for all read ops, p95 < 1000ms for commits
- [ ] **Add packfile generation timeout** — 25s max (Workers limit is 30s)
- [ ] **Stream large blob responses** — don't load entire file into memory
- [ ] **Parallelize tree operations** — batch R2 reads for deep paths
- [ ] **Add keyset pagination** — replace offset with `after=<id>` cursor

### P3: Reliability (next month)

- [ ] **Transactional repo delete** — delete R2 first, then DB. Retry on partial failure.
- [ ] **Usage event retry queue** — don't silently drop failed events
- [ ] **Health check with DB ping** — `/health` should verify DB connectivity
- [ ] **Request ID in all responses** — `x-request-id` header for debugging
- [ ] **Error codes** — structured error responses: `{ error: "...", code: "RATE_LIMITED", retry_after: 30 }`

---

## 5. SLA Targets (for paid tier)

| Metric | Target | Current estimate | Notes |
|--------|--------|-----------------|-------|
| **Uptime** | 99.9% | ~99.95% (CF Workers SLA) | Workers + R2 are highly available |
| **API latency (p95)** | <500ms | ~300ms (reads), ~500ms (commits) | Not yet measured under load |
| **Git clone latency** | <2s for repos <100MB | ~500ms for small repos | Packfile generation is the bottleneck |
| **API commit throughput** | >100 commits/min per org | Unknown | Need load test |
| **Data durability** | 99.999999999% (11 nines) | R2 durability guarantee | R2 built on top of S3-class storage |
| **Max file size** | 100MB per blob | 10MB enforced on write, no limit on read | Need to align |
| **Max repo size** | 10GB | No limit enforced | Need to add |
| **Max branches per repo** | 10,000 | No limit enforced | Need to add |
| **Rate limit** | 1,000 req/min per key | No limit | Must implement |

---

## 6. Metrics We Should Track

### Business metrics (dashboard)
- [ ] Total repos created (all time)
- [ ] Active repos (had activity in last 30 days)
- [ ] API calls per day/week/month
- [ ] Git transfer bytes per day
- [ ] Unique orgs with activity
- [ ] API key creation rate

### Engineering metrics (monitoring)
- [ ] p50/p95/p99 latency per endpoint
- [ ] Error rate per endpoint (4xx vs 5xx)
- [ ] R2 operations per request
- [ ] DB query time per request
- [ ] Worker CPU time per request
- [ ] Packfile generation time
- [ ] Cache hit rate (object cache)

### Alerting
- [ ] Error rate > 1% for 5 min → alert
- [ ] p95 latency > 2s for 5 min → alert
- [ ] Worker CPU > 25s (near 30s limit) → alert
- [ ] DB connection failures → alert

---

## 7. Competitive Landscape

| Feature | **Coregit** | GitHub API | GitLab API | Gitea API |
|---------|------------|-----------|-----------|----------|
| Batch commit (N files, 1 call) | **Yes** | No (N+4 calls) | No | No |
| Serverless (no infra to manage) | **Yes** | N/A (SaaS) | No (self-host) | No (self-host) |
| Pay-per-use | **Yes** | Per-seat | Per-seat | Free (self-host) |
| API-first (no UI needed) | **Yes** | UI-first | UI-first | UI-first |
| Custom domains | Phase 2 | No | Yes | Yes |
| Snapshots/restore points | **Yes** | No | No | No |
| Git Smart HTTP | Yes | Yes | Yes | Yes |
| Webhooks | Phase 2 | Yes | Yes | Yes |
| CI/CD | No | Yes | Yes | No |
| Code review / PRs | No | Yes | Yes | Yes |
| Rate limits | Not yet | 5,000/hr | 600/min | Configurable |

### Our moat

1. **Single-call batch commits** — nobody else does this. GitHub needs 7+ calls.
2. **Serverless economics** — no idle servers. Pay only for operations.
3. **Snapshots** — named restore points for agent rollback. Unique feature.
4. **Zero ops** — no GitHub org setup, no token management, no rate limit dance.

### Our gaps

1. No webhooks (Phase 2)
2. No merge strategies beyond fast-forward
3. No line-level diff (only file-level)
4. No code search
5. No rate limiting (must fix)

---

## 8. Next Milestones

### Week 1: Harden
- Fix all P0 security issues
- Implement rate limiting
- Add API key scopes
- Benchmark all endpoints

### Week 2: Polish
- Structured error codes
- Request IDs
- Keyset pagination
- Stream large files

### Week 3: Document
- API reference docs (docs.coregit.dev)
- Quick start guide (create repo → commit → clone in 60 seconds)
- SDK stub (TypeScript `@coregit/sdk`)

### Week 4: Launch prep
- Load testing (k6, 1000 concurrent requests)
- Set SLA targets based on benchmarks
- Pricing page with real numbers
- First 5 beta customers outreach
