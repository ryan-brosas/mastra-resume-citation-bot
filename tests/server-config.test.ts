import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

function loadWith(environment: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [
    '--experimental-strip-types',
    '--input-type=module',
    '--eval',
    "import './src/mastra/index.ts'",
  ], {
    cwd: process.cwd(),
    env: { ...process.env, ...environment },
    encoding: 'utf8',
  });
}

test('a non-loopback listener requires an explicit public-exposure acknowledgement', () => {
  const refused = loadWith({ MASTRA_HOST: '0.0.0.0', RESUME_BOT_ALLOW_PUBLIC: undefined });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /RESUME_BOT_ALLOW_PUBLIC/);

  const acknowledged = loadWith({ MASTRA_HOST: '0.0.0.0', RESUME_BOT_ALLOW_PUBLIC: 'true' });
  assert.equal(acknowledged.status, 0, acknowledged.stderr);
});
