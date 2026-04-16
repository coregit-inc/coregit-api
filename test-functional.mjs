/**
 * Functional correctness test — verify commits actually work end-to-end.
 */

const API_KEY = process.env.API_KEY;
const BASE_URL = process.env.BASE_URL || 'https://api.coregit.dev';

if (!API_KEY) {
  console.error('Missing API_KEY');
  process.exit(1);
}

let passed = 0;
let failed = 0;

function assert(condition, msg, debug) {
  if (condition) {
    console.log(`  ✓ ${msg}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${msg}`);
    if (debug) console.error(`    DEBUG: ${typeof debug === 'string' ? debug : JSON.stringify(debug).slice(0, 300)}`);
    failed++;
  }
}

async function api(method, path, body) {
  const opts = {
    method,
    headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE_URL}${path}`, opts);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, body: json, text };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function run() {
  const slug = `test-func-${Date.now()}`;
  console.log(`\n=== Functional Test: ${slug} ===\n`);

  // 1. Create repo
  console.log('1. Create repo');
  const createRes = await api('POST', '/v1/repos', { slug, visibility: 'private' });
  assert(createRes.status === 201, `Create repo: ${createRes.status}`, createRes.body);
  if (createRes.status !== 201) { console.log('Cannot continue.'); return; }

  // 2. First commit (cold path)
  console.log('\n2. First commit (cold path)');
  const commit1 = await api('POST', `/v1/repos/${slug}/commits`, {
    branch: 'main',
    message: 'initial commit',
    author: { name: 'Test', email: 'test@test.com' },
    changes: [
      { path: 'README.md', content: '# Hello World\n\nThis is a test.' },
      { path: 'src/index.ts', content: 'export const version = 1;\n' },
      { path: 'src/utils.ts', content: 'export function add(a: number, b: number) { return a + b; }\n' },
    ],
  });
  assert(commit1.status === 201, `First commit status: ${commit1.status}`, commit1.body);
  assert(commit1.body?.sha?.length === 40, `Commit SHA valid: ${commit1.body?.sha}`);
  const sha1 = commit1.body?.sha;

  // Small delay to let fire-and-forget R2 writes settle
  await sleep(500);

  // 3. Read files back
  console.log('\n3. Read files back');
  const readMe = await api('GET', `/v1/repos/${slug}/blob/main/README.md`);
  assert(readMe.status === 200, `Read README.md: ${readMe.status}`, readMe.body);
  assert(readMe.body?.content === '# Hello World\n\nThis is a test.', `README content matches`, readMe.body?.content?.slice(0, 80));

  const readIndex = await api('GET', `/v1/repos/${slug}/blob/main/src/index.ts`);
  assert(readIndex.status === 200, `Read src/index.ts: ${readIndex.status}`);
  assert(readIndex.body?.content === 'export const version = 1;\n', `index.ts content matches`, readIndex.body?.content);

  const readUtils = await api('GET', `/v1/repos/${slug}/blob/main/src/utils.ts`);
  assert(readUtils.status === 200, `Read src/utils.ts: ${readUtils.status}`);

  // 4. Second commit (warm path)
  console.log('\n4. Second commit (warm DO+edge cache path)');
  const commit2 = await api('POST', `/v1/repos/${slug}/commits`, {
    branch: 'main',
    message: 'update version',
    author: { name: 'Test', email: 'test@test.com' },
    changes: [
      { path: 'src/index.ts', content: 'export const version = 2;\n' },
    ],
  });
  assert(commit2.status === 201, `Second commit: ${commit2.status}`, commit2.body);
  assert(commit2.body?.parent === sha1, `Parent is commit 1`);
  const sha2 = commit2.body?.sha;

  await sleep(500);

  // 5. Read updated file
  console.log('\n5. Read updated file');
  const readUpdated = await api('GET', `/v1/repos/${slug}/blob/main/src/index.ts`);
  assert(readUpdated.status === 200, `Read updated index.ts: ${readUpdated.status}`);
  assert(readUpdated.body?.content === 'export const version = 2;\n', `Updated content matches`, readUpdated.body?.content);

  // 6. Verify untouched files
  console.log('\n6. Verify untouched files still exist');
  const readUtils2 = await api('GET', `/v1/repos/${slug}/blob/main/src/utils.ts`);
  assert(readUtils2.status === 200 && readUtils2.body?.content?.includes('function add'), `utils.ts unchanged`);

  // 7. Third commit — delete a file
  console.log('\n7. Third commit — delete file');
  const commit3 = await api('POST', `/v1/repos/${slug}/commits`, {
    branch: 'main',
    message: 'remove utils',
    author: { name: 'Test', email: 'test@test.com' },
    changes: [
      { path: 'src/utils.ts', action: 'delete' },
    ],
  });
  assert(commit3.status === 201, `Delete commit: ${commit3.status}`);
  assert(commit3.body?.parent === sha2, `Delete parent is commit 2`);

  await sleep(500);

  const readDeleted = await api('GET', `/v1/repos/${slug}/blob/main/src/utils.ts`);
  assert(readDeleted.status === 404, `Deleted file returns 404: ${readDeleted.status}`, readDeleted.body);

  // 8. Commit history
  console.log('\n8. Commit history');
  const log = await api('GET', `/v1/repos/${slug}/commits?limit=10`);
  assert(log.status === 200, `Commit log: ${log.status}`);
  // Repo creation auto-adds "Initial commit", so we expect 4 (1 auto + 3 manual)
  assert(log.body?.commits?.length === 4, `4 commits in history: ${log.body?.commits?.length}`, log.body?.commits?.map(c => c.message));

  // 9. Diff
  console.log('\n9. Diff between commit 1 and 2');
  const diff = await api('GET', `/v1/repos/${slug}/diff?base=${sha1}&head=${sha2}`);
  assert(diff.status === 200, `Diff: ${diff.status}`);
  assert(diff.body?.files?.length >= 1, `Diff has changed files`);

  // 10. Rapid sequential commits
  console.log('\n10. Rapid sequential commits (5x)');
  let lastSha = commit3.body?.sha;
  let allOk = true;
  for (let i = 0; i < 5; i++) {
    const r = await api('POST', `/v1/repos/${slug}/commits`, {
      branch: 'main',
      message: `rapid commit ${i}`,
      author: { name: 'Test', email: 'test@test.com' },
      changes: [{ path: 'src/index.ts', content: `export const version = ${10 + i};\n` }],
    });
    if (r.status !== 201) {
      allOk = false;
      console.error(`    Rapid commit ${i} failed: ${r.status} ${r.text.slice(0, 100)}`);
    } else {
      assert(r.body.parent === lastSha, `Rapid ${i}: parent chain correct`);
      lastSha = r.body.sha;
    }
  }
  assert(allOk, `All 5 rapid commits succeeded`);

  await sleep(500);

  // Final state
  const finalRead = await api('GET', `/v1/repos/${slug}/blob/main/src/index.ts`);
  assert(finalRead.body?.content === 'export const version = 14;\n', `Final content correct`, finalRead.body?.content);

  const finalLog = await api('GET', `/v1/repos/${slug}/commits?limit=20`);
  // 1 auto + 3 manual + 5 rapid = 9
  assert(finalLog.body?.commits?.length === 9, `9 total commits: ${finalLog.body?.commits?.length}`);

  // 11. Branch create + commit on branch
  console.log('\n11. Branch operations');
  const branchRes = await api('POST', `/v1/repos/${slug}/branches`, { name: 'feature', from: 'main' });
  assert(branchRes.status === 201, `Create branch: ${branchRes.status}`, branchRes.body);

  const branchCommit = await api('POST', `/v1/repos/${slug}/commits`, {
    branch: 'feature',
    message: 'feature commit',
    author: { name: 'Test', email: 'test@test.com' },
    changes: [{ path: 'feature.txt', content: 'feature content\n' }],
  });
  assert(branchCommit.status === 201, `Commit on branch: ${branchCommit.status}`);

  await sleep(300);

  const mainRead = await api('GET', `/v1/repos/${slug}/blob/main/feature.txt`);
  assert(mainRead.status === 404, `Feature file NOT on main: ${mainRead.status}`);

  const featureRead = await api('GET', `/v1/repos/${slug}/blob/feature/feature.txt`);
  assert(featureRead.status === 200, `Feature file on feature branch: ${featureRead.status}`);

  // Cleanup
  console.log('\n--- Cleanup ---');
  await api('DELETE', `/v1/repos/${slug}`);

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

run().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
