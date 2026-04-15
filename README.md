<p align="center">
  <img src="coregit-logo.svg" alt="Coregit" width="200" />
</p>

<p align="center">
  <a href="https://github.com/coregit-inc/coregit-api/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue" alt="License" /></a>
  <a href="https://coregit.dev"><img src="https://img.shields.io/badge/Visit-coregit.dev-black" alt="Website" /></a>
  <a href="https://docs.coregit.dev"><img src="https://img.shields.io/badge/Docs-docs.coregit.dev-green" alt="Docs" /></a>
  <a href="https://www.npmjs.com/package/@coregit/sdk"><img src="https://img.shields.io/npm/v/@coregit/sdk" alt="SDK" /></a>
  <a href="https://www.npmjs.com/package/@coregit/cli"><img src="https://img.shields.io/npm/v/@coregit/cli" alt="CLI" /></a>
</p>

# Coregit

**Serverless Git API for AI agents.** The API to commit, read, search, and version-control code at scale. One call commits 100 files. Open source and available as a [hosted service](https://coregit.dev).

## Why Coregit?

- **3.6x faster than GitHub** — 100-file commit: 19.8s vs 72.1s. One API call vs 105. ([see benchmarks](https://docs.coregit.dev/docs/guides/scalability-benchmarks))
- **~40x more write throughput** — 15,000 commits/hour vs GitHub's ~370 (limited by secondary rate limit of 80 writes/min)
- **AI-native** — Semantic code search (Voyage AI + Pinecone), code graph (Tree-sitter, 30+ languages), LLM Wiki (Karpathy pattern)
- **Serverless** — Cloudflare Workers + R2 + KV + Durable Objects. No servers, no ops, scales to zero
- **Standard Git protocol** — `git clone`, `push`, `pull` work. Plus 40+ REST API endpoints, TypeScript SDK, and CLI
- **Zero egress** — R2 storage with $0 bandwidth costs

## Quick Start

```bash
npx coregit-wizard@latest
```

The wizard creates your account, sets up API keys, and configures your agent — no browser needed.

Or install the CLI directly:

```bash
npm install -g @coregit/cli
```

## Usage

### SDK (TypeScript)

```typescript
import { createCoregitClient } from '@coregit/sdk'

const cg = createCoregitClient({ apiKey: 'cgk_live_...' })

// Commit 10 files in one API call
await cg.commits.create('my-repo', {
  branch: 'main',
  message: 'feat: add components',
  changes: [
    { path: 'src/app.ts', content: 'export default function App() {}' },
    { path: 'src/utils.ts', content: 'export const sum = (a, b) => a + b' },
    // ... up to 1000 files per commit
  ]
})
```

### CLI

```bash
# Create a repo
cgt repos create my-project

# Commit files
cgt commit my-project -b main -m "init" \
  -f src/app.ts:=./app.ts \
  -f src/utils.ts:=./utils.ts

# Read files
cgt blob my-project main src/app.ts --raw

# Search code
cgt search "authentication" --repos my-project

# Semantic search (AI-powered)
cgt semantic-search my-project "how does auth work"

# Git clone (standard protocol)
git clone https://ORG:API_KEY@api.coregit.dev/org/my-project.git
```

### cURL

```bash
# Commit files
curl -X POST https://api.coregit.dev/v1/repos/my-project/commits \
  -H "x-api-key: cgk_live_..." \
  -H "Content-Type: application/json" \
  -d '{
    "branch": "main",
    "message": "add files",
    "changes": [
      {"path": "app.ts", "content": "console.log(1)"}
    ]
  }'
```

## Features

| Feature | Description |
|---------|-------------|
| **Atomic commits** | Commit 1–1000 files in a single API call |
| **Git Smart HTTP** | Standard `git clone/push/pull` protocol |
| **Semantic search** | AI-powered code search with Voyage AI embeddings |
| **Code graph** | Tree-sitter AST analysis, 30+ languages, call graphs |
| **LLM Wiki** | Agent-maintained knowledge bases (Karpathy pattern) |
| **Branches & merge** | Create, merge, cherry-pick, compare |
| **Diff & compare** | Unified diff between any two refs |
| **Snapshots** | Named restore points for instant rollback |
| **LFS** | Large file storage with presigned uploads |
| **Sync** | Import/export GitHub and GitLab repos |
| **Webhooks** | Push event notifications with HMAC signatures |
| **Custom domains** | White-label git hosting on your domain |
| **Scoped tokens** | Repo-scoped, time-limited credentials |
| **Workspace exec** | Run shell commands against repo contents |

## Benchmarks

Measured April 2026, private repos with authentication.

| Operation | GitHub | Coregit | Winner |
|-----------|--------|---------|--------|
| Commit 1 file | 2,217 ms (4 calls) | **2,148 ms** (1 call) | **~Parity** |
| Commit 5 files | 4,829 ms (8 calls) | **3,456 ms** (1 call) | **Coregit 1.4x** |
| Commit 10 files | 8,387 ms (13 calls) | **4,183 ms** (1 call) | **Coregit 2.0x** |
| Commit 100 files | 72,064 ms (105 calls) | **19,769 ms** (1 call) | **Coregit 3.6x** |
| Read file (warm) | 735 ms | 800 ms | GitHub 1.1x |
| List tree | 797 ms | **752 ms** | **Coregit 1.1x** |
| List commits (warm) | 829 ms | **474 ms** | **Coregit 1.7x** |
| Diff branches (warm) | 738 ms | 752 ms | **~Parity** |
| Write throughput | ~370 commits/hr | **15,000 commits/hr** | **Coregit ~40x** |

[Full benchmark methodology](https://docs.coregit.dev/docs/guides/scalability-benchmarks)

## Architecture

```mermaid
flowchart TB
    clients(["SDK &nbsp;·&nbsp; CLI &nbsp;·&nbsp; git clone/push &nbsp;·&nbsp; cURL"])

    clients -->|HTTPS| router

    subgraph cf ["Cloudflare Edge"]
        router["<b>Hono v4.7</b><br/>Auth · Rate Limiting"]

        subgraph do ["Durable Objects"]
            direction LR
            rl["RateLimiter<br/><i>600 req/min</i>"]
            session["SessionDO<br/><i>zero-wait protocol</i>"]
            repodo["RepoDO<br/><i>~2 ms hot writes</i>"]
        end

        subgraph routes ["40+ API Routes"]
            direction LR
            git["Git Smart HTTP<br/><i>clone · push · pull</i>"]
            rest["REST API<br/><i>repos · commits · branches<br/>diff · merge · cherry-pick</i>"]
            search["Search<br/><i>semantic · graph · hybrid</i>"]
            wiki["LLM Wiki<br/><i>11 endpoints</i>"]
        end

        kv["<b>KV Cache</b><br/>auth · trees · refs · embeddings · search · graph"]
        edge["<b>Edge Cache</b><br/>immutable SHA objects · 1 yr TTL"]
        queue["<b>Queues</b><br/>async indexing"]
    end

    subgraph storage ["Storage"]
        direction LR
        r2["<b>Cloudflare R2</b><br/>git objects · packfiles · LFS<br/><i>$0 egress</i>"]
        neon["<b>Neon PostgreSQL</b><br/>repos · code graph · usage<br/><i>via Hyperdrive</i>"]
    end

    subgraph ai ["AI &amp; Search Pipeline"]
        direction LR
        voyage["<b>Voyage AI</b><br/>voyage-code-3<br/>rerank-2.5"]
        pinecone["<b>Pinecone</b><br/>vector store"]
        treesitter["<b>Tree-sitter</b><br/>AST → code graph<br/><i>30+ languages</i>"]
    end

    router --> do
    router --> routes
    routes --> kv --> edge
    routes --> r2 & neon
    repodo -->|"write-through"| r2
    routes --> queue
    queue --> voyage --> pinecone
    queue --> treesitter --> neon
```

### Caching hierarchy

| Layer | Latency | What's cached | TTL |
|-------|---------|---------------|-----|
| In-memory (per-request) | 0 ms | Git objects (32 MB cap) | Request lifetime |
| Durable Objects (RepoDO) | ~2 ms | Hot writes, pending flushes | 30s flush interval |
| KV (global edge) | 5–15 ms | Auth, trees, refs, embeddings | 60s – forever |
| Edge Cache API | < 5 ms | Immutable git objects (by SHA) | 1 year |
| Hyperdrive | 0–5 ms | DB query results | 60s |
| R2 | 50–200 ms | All git objects, refs, packfiles | Permanent |

## Self-Hosting

Coregit runs on Cloudflare Workers. To self-host:

1. Clone this repo
2. Create Cloudflare account with Workers Paid plan ($5/mo)
3. Set up Neon PostgreSQL database
4. Configure R2 buckets and KV namespaces
5. `npx wrangler deploy`

See [Self-Hosting Guide](https://docs.coregit.dev/docs/guides/self-hosting) for detailed instructions.

## SDKs & Tools

| Package | Description | Install |
|---------|-------------|---------|
| [@coregit/sdk](https://www.npmjs.com/package/@coregit/sdk) | TypeScript SDK | `npm install @coregit/sdk` |
| [@coregit/cli](https://www.npmjs.com/package/@coregit/cli) | CLI tool | `npm install -g @coregit/cli` |
| [Coregit Skill](https://github.com/coregit-inc/skills) | Claude Code skill | `npx skills add coregit-inc/skills` |

## Documentation

- [API Reference](https://docs.coregit.dev/docs/api-reference)
- [Getting Started](https://docs.coregit.dev/docs/getting-started)
- [TypeScript SDK](https://docs.coregit.dev/docs/getting-started/typescript-sdk)
- [Scalability Benchmarks](https://docs.coregit.dev/docs/guides/scalability-benchmarks)
- [LLM Wiki Guide](https://docs.coregit.dev/docs/guides/llm-wiki)

## Contributing

We welcome contributions! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

This project is licensed under the [GNU Affero General Public License v3.0](LICENSE) — see the LICENSE file for details.

AGPL-3.0 means: you can self-host, modify, and use Coregit freely. If you modify the code and provide it as a network service, you must open-source your modifications.
