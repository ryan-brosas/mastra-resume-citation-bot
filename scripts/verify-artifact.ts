import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { access, copyFile, cp, mkdir, mkdtemp, readdir, rm, symlink } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PROJECT_ROOT, pageImageName } from '../src/citations/manifest.ts';
import { trustedManifest } from '../src/citations/trust.ts';

const output = resolve(PROJECT_ROOT, '.mastra/output');
const manifest = await trustedManifest();
const required = [
  'src/mastra/ui/index.html',
  'src/mastra/ui/app.css',
  'src/mastra/ui/app.js',
  'src/mastra/ui/favicon.svg',
  'src/citations/generated/manifest.v1.json',
  ...manifest.source.pages.map((page) => join('src/citations/generated/pages', pageImageName(page.page))),
  manifest.source.sourcePath,
];

for (const file of required) await access(resolve(output, file));

const sandbox = await mkdtemp(join(tmpdir(), 'resume-bot-artifact-'));
const port = 42000 + process.pid % 1000;
let server: ReturnType<typeof spawn> | undefined;
let logs = '';
const routes = ['/healthz', '/readyz', '/ask', '/ask/app.css', '/ask/favicon.svg', '/ask/document', '/ask/page/1'];

try {
  for (const entry of await readdir(output)) {
    if (entry.endsWith('.mjs') || entry === 'package.json') {
      await copyFile(resolve(output, entry), resolve(sandbox, entry));
    }
  }
  await cp(resolve(output, 'src'), resolve(sandbox, 'src'), { recursive: true });
  const sourceTarget = resolve(sandbox, manifest.source.sourcePath);
  await mkdir(dirname(sourceTarget), { recursive: true });
  await copyFile(resolve(output, manifest.source.sourcePath), sourceTarget);
  await symlink(resolve(output, 'node_modules'), resolve(sandbox, 'node_modules'), 'dir');

  const serverEnv: NodeJS.ProcessEnv = { ...process.env, PORT: String(port) };
  delete serverEnv.MASTRA_HOST;
  server = spawn(process.execPath, ['index.mjs'], {
    cwd: sandbox,
    env: serverEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout?.on('data', (chunk: Buffer) => { logs += chunk.toString(); });
  server.stderr?.on('data', (chunk: Buffer) => { logs += chunk.toString(); });

  const responses = new Map<string, Response>();
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      for (const route of routes) {
        responses.set(route, await fetch(`http://127.0.0.1:${port}` + route, {
          signal: AbortSignal.timeout(1000),
        }));
      }
      break;
    } catch {
      if (server.exitCode !== null) break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    }
  }

  for (const route of routes) {
    const response = responses.get(route);
    if (!response?.ok) throw new Error(`standalone artifact ${route} returned ${response?.status ?? 'no response'}`);
    if (response.headers.has('access-control-allow-origin')) {
      throw new Error(`standalone artifact ${route} enabled ambient cross-origin access`);
    }
  }
  const externalAddress = Object.values(networkInterfaces()).flat().find(
    (address) => address?.family === 'IPv4' && !address.internal,
  )?.address;
  if (externalAddress !== undefined) {
    const exposed = await new Promise<boolean>((resolveConnection) => {
      const socket = connect({ host: externalAddress, port });
      socket.once('connect', () => { socket.destroy(); resolveConnection(true); });
      socket.once('error', () => resolveConnection(false));
    });
    if (exposed) throw new Error(`standalone artifact exposed ${externalAddress}:${port} without an explicit host override`);
  }

  console.log('standalone artifact serves verified assets and defaults to a loopback listener');
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  throw new Error(`${detail}
${logs.trim()}`);
} finally {
  server?.kill('SIGTERM');
  await rm(sandbox, { recursive: true, force: true });
}
