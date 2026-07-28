import { DEFAULT_SOURCE_PATH } from './manifest.ts';
import { ManifestTrustError, publishManifest, trustedManifest, verifiedManifest } from './trust.ts';

const command = process.argv[2];
const sourcePath = process.argv[3] ?? DEFAULT_SOURCE_PATH;

if (command !== 'build' && command !== 'verify') {
  process.stderr.write('usage: cli.ts <build|verify> [source.pdf]\n');
  process.exit(1);
}

try {
  const manifest =
    command === 'build' ? await publishManifest(await verifiedManifest(sourcePath)) : await trustedManifest();
  process.stdout.write(
    `${command === 'build' ? 'built' : 'verified'} ${manifest.citations.length} citations across ` +
      `${manifest.source.pageCount} pages of ${manifest.source.sourcePath} (${manifest.source.version})\n`,
  );
} catch (error) {
  const detail = error instanceof ManifestTrustError ? error.code : String(error);
  process.stderr.write(`citation manifest ${command} failed: ${detail}\n`);
  process.exit(1);
}
