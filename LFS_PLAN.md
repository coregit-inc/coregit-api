# Git LFS for CoreGit — Implementation Plan

## Context

Git LFS (Large File Storage) позволяет хранить большие файлы (изображения, модели, датасеты, бинарники) вне git-дерева, заменяя их pointer-файлами. Клиент `git lfs` прозрачно загружает/скачивает большие файлы через отдельный HTTP API.

CoreGit — multi-tenant B2B платформа. LFS должен быть:
- **Изолированным** — org A не может читать LFS-объекты org B
- **Квотируемым** — лимиты на storage per org/tier
- **Быстрым** — прямая загрузка в R2, Worker не проксирует данные
- **Безопасным** — presigned URLs с TTL, verify callback, no guessable paths

---

## Архитектура

```
git lfs push/pull
    │
    ▼
┌──────────────────────────────────────┐
│  CoreGit Worker (Batch API)          │
│  /:org/:repo.git/info/lfs/objects/batch  │
│                                      │
│  1. Auth (Basic auth → API key)      │
│  2. Check permissions (read/write)   │
│  3. Check storage quota              │
│  4. Generate presigned R2 URLs       │
│  5. Return URLs to client            │
└───────────────┬──────────────────────┘
                │ presigned URLs
                ▼
┌──────────────────────────────────────┐
│  Cloudflare R2 (S3 API)             │
│  Direct upload/download              │
│  No Worker in the data path          │
│                                      │
│  Bucket: coregit-lfs                 │
│  Key: {orgId}/{repoId}/lfs/{oid}    │
└──────────────────────────────────────┘
```

Ключевое решение: **Worker генерирует presigned URLs**, клиент загружает/скачивает **напрямую в R2** через S3 API. Worker не проксирует данные — это критично для файлов на сотни MB.

---

## Протокол

### Server Discovery

Git LFS автоматически добавляет `/info/lfs` к remote URL:
```
Remote: https://api.coregit.dev/strayl/my-repo.git
LFS:    https://api.coregit.dev/strayl/my-repo.git/info/lfs
```

Все LFS endpoints под этим базовым путём.

### Endpoints

```
POST /:org/:repo.git/info/lfs/objects/batch     — Batch API (основной)
POST /:org/:repo.git/info/lfs/locks             — Create lock
GET  /:org/:repo.git/info/lfs/locks             — List locks
POST /:org/:repo.git/info/lfs/locks/verify      — Verify locks
POST /:org/:repo.git/info/lfs/locks/:id/unlock  — Delete lock
```

Также для namespaced repos:
```
POST /:org/:namespace/:repo.git/info/lfs/objects/batch
...
```

---

## 1. Batch API

### Request

```
POST /:org/:repo.git/info/lfs/objects/batch
Authorization: Basic {base64(orgSlug:apiKey)}
Accept: application/vnd.git-lfs+json
Content-Type: application/vnd.git-lfs+json
```

```json
{
  "operation": "upload",
  "transfers": ["basic"],
  "objects": [
    { "oid": "sha256:abc123...", "size": 52428800 }
  ],
  "ref": { "name": "refs/heads/main" }
}
```

### Response (upload)

```json
{
  "transfer": "basic",
  "objects": [
    {
      "oid": "sha256:abc123...",
      "size": 52428800,
      "actions": {
        "upload": {
          "href": "https://{account}.r2.cloudflarestorage.com/coregit-lfs/{orgId}/{repoId}/lfs/{oid}",
          "header": {
            "x-amz-content-sha256": "UNSIGNED-PAYLOAD"
          },
          "expires_in": 3600
        },
        "verify": {
          "href": "https://api.coregit.dev/{org}/{repo}.git/info/lfs/verify",
          "header": {
            "Authorization": "Basic ..."
          },
          "expires_in": 3600
        }
      }
    }
  ]
}
```

### Response (download)

```json
{
  "transfer": "basic",
  "objects": [
    {
      "oid": "sha256:abc123...",
      "size": 52428800,
      "actions": {
        "download": {
          "href": "https://{account}.r2.cloudflarestorage.com/coregit-lfs/{orgId}/{repoId}/lfs/{oid}?X-Amz-Signature=...",
          "expires_in": 3600
        }
      }
    }
  ]
}
```

### Логика

**Upload:**
1. Auth → resolve org + repo
2. Для каждого object: проверить существует ли уже в R2 (`HEAD` object)
3. Если существует → не включать `actions` (клиент пропустит)
4. Если нет → сгенерировать presigned PUT URL (1 час TTL)
5. Включить `verify` callback
6. Проверить storage quota перед генерацией URL

**Download:**
1. Auth → resolve org + repo
2. Для каждого object: проверить существует ли в R2
3. Если да → сгенерировать presigned GET URL (1 час TTL)
4. Если нет → вернуть per-object error `{ "code": 404, "message": "Object not found" }`

**Deduplication:**
LFS objects адресуются по SHA-256. Если два repo в одном org загружают одинаковый файл, можно хранить одну копию. Но для простоты и изоляции — хранить per-repo.

---

## 2. Presigned URL Generation

R2 presigned URLs генерируются через AWS Signature V4. В Workers это через библиотеку `aws4fetch`:

```typescript
import { AwsClient } from "aws4fetch";

const r2 = new AwsClient({
  accessKeyId: env.R2_ACCESS_KEY_ID,
  secretAccessKey: env.R2_SECRET_ACCESS_KEY,
});

// Presigned PUT (upload)
const uploadUrl = await r2.sign(
  new Request(`https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/coregit-lfs/${key}`, {
    method: "PUT",
  }),
  { aws: { signQuery: true }, expiresIn: 3600 }
);

// Presigned GET (download)
const downloadUrl = await r2.sign(
  new Request(`https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/coregit-lfs/${key}`, {
    method: "GET",
  }),
  { aws: { signQuery: true }, expiresIn: 3600 }
);
```

### Secrets нужные в wrangler.toml:
```
R2_ACCESS_KEY_ID          — R2 API token (S3-compatible)
R2_SECRET_ACCESS_KEY      — R2 API secret
R2_ACCOUNT_ID             — Cloudflare Account ID
```

---

## 3. Verify Callback

```
POST /:org/:repo.git/info/lfs/verify
Authorization: Basic ...
Content-Type: application/vnd.git-lfs+json
```

```json
{ "oid": "sha256:abc123...", "size": 52428800 }
```

Логика:
1. Auth
2. `HEAD` object в R2 — проверить что файл действительно загружен
3. Сравнить size с заявленным
4. Записать в `lfs_object` таблицу (metadata: oid, size, repo, uploaded_at)
5. Обновить storage usage для org
6. Вернуть 200 OK

---

## 4. Storage Schema

### Таблица `lfs_object`

```sql
CREATE TABLE lfs_object (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  repo_id TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
  oid TEXT NOT NULL,              -- sha256 hash
  size BIGINT NOT NULL,           -- bytes
  content_type TEXT,              -- optional MIME type
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(repo_id, oid)
);

CREATE INDEX lfs_object_repo_idx ON lfs_object(repo_id);
CREATE INDEX lfs_object_org_idx ON lfs_object(org_id);
```

### Таблица `lfs_lock`

```sql
CREATE TABLE lfs_lock (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  repo_id TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  owner_id TEXT NOT NULL,          -- API key ID that created the lock
  owner_name TEXT NOT NULL,        -- display name
  locked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ref TEXT,                        -- branch ref (optional)
  UNIQUE(repo_id, path)
);

CREATE INDEX lfs_lock_repo_idx ON lfs_lock(repo_id);
```

### Billing: LFS = общие лимиты

LFS storage и transfer считаются в существующие метры `coregit.storage` и `coregit.git_transfer`. Никаких отдельных LFS-метров или колонок в org_plan.

- Verify callback: `recordUsage(orgId, 'storage_bytes', size)` + `recordUsage(orgId, 'git_transfer_bytes', size)`
- Download batch: `recordUsage(orgId, 'git_transfer_bytes', totalSize)`
- Free tier: 1 GB storage / 5 GB transfer — общие для git + LFS
- Usage tier: $0.10/GB storage, $0.10/GB transfer — одинаково для git и LFS
- R2 cost: $0.015/GB/month → маржа 85% при $0.10/GB

---

## 5. R2 Storage Layout

```
coregit-lfs/                          -- отдельный R2 bucket
  {orgId}/
    {repoId}/
      lfs/
        {oid[0:2]}/{oid[2:]}         -- 2-level sharding (как git objects)
```

Пример:
```
coregit-lfs/org_abc/repo_xyz/lfs/ab/cdef1234567890...
```

**Отдельный bucket** (`coregit-lfs`) от `coregit-repos` — разделение git objects и LFS objects. Разные retention policies, разные access patterns.

---

## 6. File Locking API

### Create Lock

```
POST /:org/:repo.git/info/lfs/locks
```

```json
{ "path": "assets/logo.psd", "ref": { "name": "refs/heads/main" } }
```

Response 201:
```json
{
  "lock": {
    "id": "lock_abc",
    "path": "assets/logo.psd",
    "locked_at": "2026-04-06T12:00:00Z",
    "owner": { "name": "alice" }
  }
}
```

409 если уже заблокирован другим.

### List Locks

```
GET /:org/:repo.git/info/lfs/locks?path=assets/logo.psd
```

### Verify Locks

```
POST /:org/:repo.git/info/lfs/locks/verify
```

Разделяет locks на `ours` (текущий user) и `theirs` (другие). Git LFS клиент блокирует push если modified files попадают в `theirs`.

### Unlock

```
POST /:org/:repo.git/info/lfs/locks/:id/unlock
```

`force: true` — позволяет удалить чужой lock (для админов/master key).

---

## 7. Multi-Tenant Security

### Isolation
- R2 ключи: `{orgId}/{repoId}/lfs/{oid}` — org не может угадать путь другого org
- Presigned URLs: привязаны к конкретному ключу, 1 час TTL
- Batch API: auth проверяет org ownership перед генерацией URL
- Нет cross-org deduplication — каждый org платит за свой storage

### Quotas

LFS считается в общие org лимиты (storage + transfer). Единственный LFS-специфичный лимит — max file size:

| Tier | Max File Size |
|------|---------------|
| Free | 100 MB |
| Usage | 2 GB |
| Enterprise | Custom |

### Rate Limits
- Batch API: стандартные per-key limits (600/min)
- Uploads/downloads: не через Worker, R2 handle сам
- Verify callback: 100/min per key (prevent abuse)

### Audit
Все LFS операции логируются в `audit_log`:
- `lfs.upload` — файл загружен
- `lfs.download` — файл скачан (batch request)
- `lfs.lock.create` / `lfs.lock.delete`

---

## 8. Garbage Collection

LFS объекты могут стать orphaned когда:
- Repo удалён → cascade delete в `lfs_object`, но R2 objects остаются
- Branch с LFS pointer удалён
- Force push убирает commits с LFS pointers

### GC Strategy
- **On repo delete**: Cloudflare Worker удаляет R2 prefix `{orgId}/{repoId}/lfs/` целиком
- **Periodic GC** (cron): Сравнить `lfs_object` таблицу с actual R2 objects, удалить orphans
- **Lazy**: Не удалять R2 objects агрессивно — storage дешёвый, а restore requests дорогие

---

## 9. Implementation Order

### Phase 1: Core (2-3 дня)
1. Создать R2 bucket `coregit-lfs`
2. Добавить `aws4fetch` dependency
3. Добавить secrets: `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID`
4. Schema: `lfs_object` table + quota columns
5. Batch API endpoint (upload + download)
6. Presigned URL generation
7. Verify callback
8. Register routes in index.ts

### Phase 2: Locking (1 день)
1. Schema: `lfs_lock` table
2. Lock CRUD endpoints
3. Verify locks endpoint

### Phase 3: Quotas & Billing (1 день)
1. Storage quota check в Batch API (перед генерацией upload URL)
2. Usage tracking после verify callback
3. Storage usage endpoint в dashboard API
4. Интеграция с Dodo Payments metering

### Phase 4: Dashboard UI (1 день)
1. LFS storage usage bar в billing page
2. LFS objects browser (list files, sizes)
3. Lock management UI

### Phase 5: Docs & SDK (1 день)
1. Docs page: LFS setup, .gitattributes, tracking patterns
2. SDK: `git.lfs.listObjects()`, `git.lfs.listLocks()`
3. Guides: migrating existing LFS repos to CoreGit

---

## 10. Key Files

| File | Purpose |
|------|---------|
| `src/routes/lfs.ts` | NEW: Batch API, verify callback |
| `src/routes/lfs-locks.ts` | NEW: Locking API |
| `src/services/lfs-presign.ts` | NEW: R2 presigned URL generation via aws4fetch |
| `src/db/schema.ts` | ADD: lfs_object, lfs_lock tables |
| `src/index.ts` | REGISTER: LFS routes |
| `wrangler.toml` | ADD: coregit-lfs R2 binding (optional, for HEAD checks) |

---

## 11. Зависимости

```
npm install aws4fetch    # AWS Sig V4 signing for presigned URLs (0 deps, 8KB)
```

Единственная новая зависимость. `aws4fetch` — минимальная библиотека для подписи S3 requests, идеально для CF Workers.

---

## 12. Что лучше чем у GitHub

| Аспект | GitHub | CoreGit |
|--------|--------|---------|
| Free storage | 1 GB | 1 GB (same) |
| Max file size | 2 GB (5 GB via API) | 2 GB |
| Bandwidth | 1 GB/month free | 5 GB/month free |
| Storage backend | Proprietary | R2 ($0.015/GB/month — 3x дешевле S3) |
| Multi-tenant isolation | Per-account | Per-org with presigned URLs |
| File locking | Yes | Yes |
| Audit trail | Enterprise only | All tiers |
| Custom domains | No | Yes (LFS через custom domain) |
| API access to LFS metadata | Limited | Full REST API |
