import { copyFile, cp, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { PROJECT_ROOT } from '../src/citations/manifest.ts';
import { trustedManifest } from '../src/citations/trust.ts';

const output = resolve(PROJECT_ROOT, '.mastra/output');
const manifest = await trustedManifest();
const sourcePath = manifest.source.sourcePath;

const directories = [
  ['src/mastra/ui', 'src/mastra/ui'],
  ['src/citations/generated', 'src/citations/generated'],
] as const;

for (const [source, destination] of directories) {
  const target = resolve(output, destination);
  await rm(target, { recursive: true, force: true });
  await mkdir(dirname(target), { recursive: true });
  await cp(resolve(PROJECT_ROOT, source), target, { recursive: true });
}

const sourceTarget = resolve(output, sourcePath);
await mkdir(dirname(sourceTarget), { recursive: true });
await copyFile(resolve(PROJECT_ROOT, sourcePath), sourceTarget);

console.log(`packaged runtime assets for ${manifest.source.title} at ${output}`);
