import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { PROJECT_ROOT } from '../src/citations/manifest.ts';

const ASK = join(PROJECT_ROOT, 'scripts/ask.ts');

// The vector store lives at ./mastra.db, so a scratch cwd guarantees "no index yet" regardless of
// what the developer's working copy has already indexed. PDF_CITATION_ROOT keeps the document and
// manifest pointed at the real project while the database stays disposable.
const scratch = await mkdtemp(join(tmpdir(), 'pdf-citation-ask-'));
after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

type Run = Readonly<{ code: number | null; stdout: string; stderr: string }>;

function runAsk(env: Record<string, string>, input?: string): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', ASK], {
      cwd: scratch,
      env: {
        ...process.env,
        PDF_CITATION_ROOT: PROJECT_ROOT,
        PDF_CITATION_DB: `file:${join(scratch, 'mastra.db')}`,
        ...env,
      },
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });

    if (input !== undefined) child.stdin!.end(input);

    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr!.on('data', (chunk) => (stderr += String(chunk)));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('an unusable document exits non-zero with a controlled message', async () => {
  // A root with no manifest and no PDF: preparation cannot succeed by any path.
  const run = await runAsk({ PDF_CITATION_ROOT: scratch, OMNIROUTE_URL: 'http://127.0.0.1:59999/v1' });

  assert.equal(run.code, 1);
  assert.match(run.stderr, /^ask: could not prepare the document — /m);
  assert.doesNotMatch(run.stderr, /^\s+at /m, 'a stack trace must not reach the user');
  assert.doesNotMatch(run.stderr, /unsettled top-level await/);
  assert.doesNotMatch(run.stdout, /^> /m, 'the prompt must not open when the document is unusable');
});

test('a published document that fits opens the prompt with no index and no gateway', async () => {
  const run = await runAsk({ OMNIROUTE_URL: 'http://127.0.0.1:59999/v1' });

  assert.equal(run.code, 0, 'EOF must not leave an unsettled top-level await');
  assert.doesNotMatch(run.stdout, /Indexing the document/, 'a document that fits needs no index built');
  assert.match(run.stdout, /^> /m);
  assert.doesNotMatch(run.stderr, /unsettled top-level await/);
  assert.equal(run.stderr.trim(), '');
});

// A document that fits whole embeds no query, so a dead gateway now surfaces first at generation.
test('an answer failure is reported concisely and still exits cleanly', async () => {
  const run = await runAsk({ OMNIROUTE_URL: 'http://127.0.0.1:59999/v1' }, 'what does the document say?\n');

  assert.equal(run.code, 0);
  assert.match(run.stdout, /failed: model_failed/);
  assert.doesNotMatch(run.stdout, /^\s+at /m, 'a stack trace must not reach the user');
  assert.equal(run.stderr.trim(), '');
});
