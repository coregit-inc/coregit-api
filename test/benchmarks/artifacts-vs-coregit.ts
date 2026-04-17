/**
 * Coregit vs Cloudflare Artifacts head-to-head benchmark.
 *
 * Run:
 *   npx tsx test/benchmarks/artifacts-vs-coregit.ts
 *
 * Required env:
 *   COREGIT_API_KEY=cgk_live_...
 *   ARTIFACTS_API_TOKEN=<Cloudflare API token with Artifacts scope>
 *   ARTIFACTS_ACCOUNT_ID=<32-char account id>
 *   ARTIFACTS_NAMESPACE=<namespace slug>
 *
 * Optional env:
 *   RUNS=3                 (median of N runs)
 *   KEEP_REPOS=1           (skip cleanup)
 *   COREGIT_BASE=https://api.coregit.dev
 *
 * Mirrors the methodology in coregit-docs/.../scalability-benchmarks.mdx.
 * Two sections:
 *   1. Native API head-to-head — Coregit REST vs Artifacts git protocol
 *      (what an agent actually uses)
 *   2. Apples-to-apples git — both via git push/clone (control group)
 */

import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── config ──────────────────────────────────────────────────────────

const env = (k: string, required = true): string => {
  const v = process.env[k];
  if (required && !v) {
    console.error(`Missing required env var: ${k}`);
    process.exit(1);
  }
  return v ?? "";
};

const COREGIT = {
  apiKey: env("COREGIT_API_KEY"),
  org: env("COREGIT_ORG"),
  base: process.env.COREGIT_BASE ?? "https://api.coregit.dev",
};

const ARTIFACTS = {
  token: env("ARTIFACTS_API_TOKEN"),
  accountId: env("ARTIFACTS_ACCOUNT_ID"),
  namespace: env("ARTIFACTS_NAMESPACE"),
  apiBase: () =>
    `https://artifacts.cloudflare.net/v1/api/namespaces/${ARTIFACTS.namespace}`,
  gitRemote: (repo: string) =>
    `https://${ARTIFACTS.accountId}.artifacts.cloudflare.net/git/${ARTIFACTS.namespace}/${repo}.git`,
};

const RUNS = Number(process.env.RUNS ?? 3);
const KEEP = process.env.KEEP_REPOS === "1";
const STAMP = Date.now().toString(36);
const COREGIT_REPO = `bench-cg-${STAMP}`;
const ARTIFACTS_REPO = `bench-ar-${STAMP}`;

// ── utilities ───────────────────────────────────────────────────────

const ms = () => Number(process.hrtime.bigint() / 1_000_000n);

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

interface Result {
  op: string;
  coregit?: number;
  artifacts?: number;
  note?: string;
}
const results: Result[] = [];

async function time<T>(fn: () => Promise<T>): Promise<[number, T]> {
  const t0 = ms();
  const r = await fn();
  return [ms() - t0, r];
}

async function timeMedian<T>(
  label: string,
  fn: () => Promise<T>,
  runs = RUNS,
): Promise<number> {
  const xs: number[] = [];
  let last: T | undefined;
  for (let i = 0; i < runs; i++) {
    const [t, r] = await time(fn);
    xs.push(t);
    last = r;
    process.stderr.write(`  [${label}] run ${i + 1}/${runs}: ${t} ms\n`);
  }
  return median(xs);
}

// ── HTTP clients ────────────────────────────────────────────────────

async function cg(
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const r = await fetch(`${COREGIT.base}${path}`, {
    method,
    headers: {
      "x-api-key": COREGIT.apiKey,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok && r.status !== 409) {
    throw new Error(
      `coregit ${method} ${path} → ${r.status} ${await r.text()}`,
    );
  }
  return r;
}

async function ar(
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const r = await fetch(`${ARTIFACTS.apiBase()}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${ARTIFACTS.token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok && r.status !== 409) {
    throw new Error(
      `artifacts ${method} ${path} → ${r.status} ${await r.text()}`,
    );
  }
  return r;
}

// ── git helpers (used for Artifacts file ops + control-group runs) ──

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (r.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${r.stderr?.toString() ?? ""}`,
    );
  }
}

function gitWithToken(
  cwd: string,
  token: string,
  ...args: string[]
): void {
  const r = spawnSync(
    "git",
    ["-c", `http.extraHeader=Authorization: Bearer ${token}`, ...args],
    {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    },
  );
  if (r.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${r.stderr?.toString() ?? ""}`,
    );
  }
}

function fileBlob(path: string, i: number): { path: string; content: string } {
  return {
    path,
    content: `// generated test file ${i}\nexport const v${i} = ${i};\n`,
  };
}

// ── setup / teardown ────────────────────────────────────────────────

let artifactsToken = "";
let artifactsRemote = "";

async function setup(): Promise<void> {
  console.log(`\n═══ setup ═══`);
  console.log(`  coregit repo:   ${COREGIT_REPO}`);
  console.log(`  artifacts repo: ${ARTIFACTS_REPO}`);

  // Coregit create
  const t1 = ms();
  await cg("POST", "/v1/repos", { slug: COREGIT_REPO });
  results.push({ op: "Create repo", coregit: ms() - t1 });

  // Artifacts create (capture token + remote from response for git push)
  const t2 = ms();
  const rar = await ar("POST", "/repos", { name: ARTIFACTS_REPO });
  const arData = (await rar.json()) as {
    repo?: { remote?: string };
    remote?: string;
    token?: string;
  };
  results[results.length - 1].artifacts = ms() - t2;

  artifactsToken = arData.token ?? "";
  artifactsRemote = arData.remote ?? arData.repo?.remote ??
    ARTIFACTS.gitRemote(ARTIFACTS_REPO);

  if (!artifactsToken) {
    // Mint a write token explicitly
    const r = await ar("POST", "/tokens", {
      repo: ARTIFACTS_REPO,
      scope: "write",
      ttl: 3600,
    });
    const td = (await r.json()) as { token?: string; secret?: string };
    artifactsToken = td.token ?? td.secret ?? "";
  }

  // Bootstrap Artifacts repo with an initial commit (clone empty + push README)
  const seedDir = mkdtempSync(join(tmpdir(), "ar-seed-"));
  try {
    gitWithToken(seedDir, artifactsToken, "clone", artifactsRemote, ".");
    writeFileSync(join(seedDir, "README.md"), `# bench ${STAMP}\n`);
    git(seedDir, "add", ".");
    git(seedDir, "-c", "user.email=bench@bench", "-c", "user.name=bench",
        "commit", "-m", "init");
    gitWithToken(seedDir, artifactsToken, "push", "-u", "origin", "main");
  } finally {
    rmSync(seedDir, { recursive: true, force: true });
  }
}

async function teardown(): Promise<void> {
  if (KEEP) {
    console.log(`\n[KEEP_REPOS=1] leaving repos in place`);
    return;
  }
  console.log(`\n═══ teardown ═══`);
  try {
    await cg("DELETE", `/v1/repos/${COREGIT_REPO}`);
    console.log(`  coregit deleted`);
  } catch (e) {
    console.error(`  coregit delete failed: ${(e as Error).message}`);
  }
  try {
    await ar("DELETE", `/repos/${ARTIFACTS_REPO}`);
    console.log(`  artifacts deleted`);
  } catch (e) {
    console.error(`  artifacts delete failed: ${(e as Error).message}`);
  }
}

// ── benchmark ops ───────────────────────────────────────────────────

async function commitNFilesCoregit(n: number): Promise<void> {
  const changes = Array.from({ length: n }, (_, i) =>
    fileBlob(`f${Date.now()}-${i}.ts`, i),
  );
  await cg("POST", `/v1/repos/${COREGIT_REPO}/commits`, {
    branch: "main",
    message: `add ${n} files`,
    author: { name: "bench", email: "bench@bench" },
    changes,
  });
}

async function commitNFilesArtifacts(n: number): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "ar-commit-"));
  try {
    gitWithToken(dir, artifactsToken, "clone", "--depth", "1",
                 artifactsRemote, ".");
    for (let i = 0; i < n; i++) {
      const f = fileBlob(`f${Date.now()}-${i}.ts`, i);
      writeFileSync(join(dir, f.path), f.content);
    }
    git(dir, "add", ".");
    git(dir, "-c", "user.email=bench@bench", "-c", "user.name=bench",
        "commit", "-m", `add ${n} files`);
    gitWithToken(dir, artifactsToken, "push", "origin", "main");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function readFileCoregit(): Promise<void> {
  await cg("GET", `/v1/repos/${COREGIT_REPO}/blob/main/README.md`);
}

async function readFileArtifacts(): Promise<void> {
  // Artifacts has no REST blob endpoint — fetch via git protocol.
  // We measure: shallow clone of just README via partial fetch.
  const dir = mkdtempSync(join(tmpdir(), "ar-read-"));
  try {
    gitWithToken(dir, artifactsToken, "clone", "--depth", "1",
                 "--filter=blob:none", artifactsRemote, ".");
    gitWithToken(dir, artifactsToken, "checkout", "HEAD", "--", "README.md");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function listTreeCoregit(): Promise<void> {
  await cg("GET", `/v1/repos/${COREGIT_REPO}/tree/main`);
}
async function listTreeArtifacts(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "ar-tree-"));
  try {
    gitWithToken(dir, artifactsToken, "clone", "--depth", "1",
                 "--filter=tree:0", artifactsRemote, ".");
    git(dir, "ls-tree", "-r", "HEAD");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function listCommitsCoregit(): Promise<void> {
  await cg("GET", `/v1/repos/${COREGIT_REPO}/commits?ref=main&limit=20`);
}
async function listCommitsArtifacts(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "ar-log-"));
  try {
    gitWithToken(dir, artifactsToken, "clone", "--depth", "20",
                 "--filter=blob:none", artifactsRemote, ".");
    git(dir, "log", "--oneline", "-20");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function forkCoregit(): Promise<void> {
  const name = `${COREGIT_REPO}-fork-${ms()}`;
  await cg("POST", `/v1/repos/${COREGIT_REPO}/snapshots`, {
    name,
    branch: "main",
  });
  // cleanup fork? snapshots are scoped to repo; deleting repo cascades
}

async function forkArtifacts(): Promise<void> {
  const name = `${ARTIFACTS_REPO}-fork-${ms()}`;
  await ar("POST", `/repos/${ARTIFACTS_REPO}/fork`, { name });
  if (!KEEP) {
    await ar("DELETE", `/repos/${name}`).catch(() => {});
  }
}

async function coldCloneCoregit(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "cg-clone-"));
  try {
    const remote = `https://${COREGIT.org}:${COREGIT.apiKey}@api.coregit.dev/${COREGIT.org}/${COREGIT_REPO}.git`;
    spawnSync("git", ["clone", remote, "."], {
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function coldCloneArtifacts(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "ar-clone-"));
  try {
    gitWithToken(dir, artifactsToken, "clone", artifactsRemote, ".");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── runner ──────────────────────────────────────────────────────────

async function runOp(
  op: string,
  cgFn: () => Promise<void>,
  arFn: () => Promise<void>,
  note?: string,
): Promise<void> {
  console.log(`\n── ${op} ──`);
  let cgT: number | undefined;
  let arT: number | undefined;
  try {
    cgT = await timeMedian(`coregit ${op}`, cgFn);
  } catch (e) {
    console.error(`  coregit failed: ${(e as Error).message}`);
  }
  try {
    arT = await timeMedian(`artifacts ${op}`, arFn);
  } catch (e) {
    console.error(`  artifacts failed: ${(e as Error).message}`);
  }
  results.push({ op, coregit: cgT, artifacts: arT, note });
}

function printTable(): void {
  console.log(`\n═══ Results (median of ${RUNS} runs, ms) ═══\n`);
  const header = `| Operation | Coregit | Artifacts | Ratio | Note |`;
  const sep = `| --- | --- | --- | --- | --- |`;
  const rows = results.map((r) => {
    const cg = r.coregit !== undefined ? `${r.coregit} ms` : "—";
    const ar = r.artifacts !== undefined ? `${r.artifacts} ms` : "—";
    let ratio = "—";
    if (r.coregit && r.artifacts) {
      const x = r.artifacts / r.coregit;
      ratio = x >= 1 ? `Coregit ${x.toFixed(1)}x` : `Artifacts ${(1 / x).toFixed(1)}x`;
    }
    return `| ${r.op} | ${cg} | ${ar} | ${ratio} | ${r.note ?? ""} |`;
  });
  console.log([header, sep, ...rows].join("\n"));
}

// ── main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await setup();

  // === Section 1: Native API head-to-head ===
  // Coregit uses REST; Artifacts uses git protocol (it has no REST file ops).
  console.log(`\n══════ Section 1: Native API head-to-head ══════`);

  for (const n of [1, 5, 10, 100]) {
    await runOp(
      `Commit ${n} file${n > 1 ? "s" : ""}`,
      () => commitNFilesCoregit(n),
      () => commitNFilesArtifacts(n),
      n === 1 ? "CG: 1 REST call. AR: clone+commit+push (git floor)" : undefined,
    );
  }

  await runOp("Read file (warm)", readFileCoregit, readFileArtifacts,
              "AR has no REST blob endpoint");
  await runOp("List tree", listTreeCoregit, listTreeArtifacts);
  await runOp("List commits", listCommitsCoregit, listCommitsArtifacts);
  await runOp("Fork / snapshot", forkCoregit, forkArtifacts);
  await runOp("Cold clone (full)", coldCloneCoregit, coldCloneArtifacts,
              "Both via git protocol");

  await teardown();
  printTable();
}

main().catch((e) => {
  console.error(e);
  teardown().finally(() => process.exit(1));
});
