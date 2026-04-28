import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..');
const distDir = path.join(rootDir, 'dist');
const outDir = path.join(rootDir, 'dist-publish');

const CANONICAL_NAME = '@0xdoublesharp/lru-cache-clustered';
const LEGACY_NAME = 'lru-cache-for-clusters-as-promised';

const CANONICAL_VERSION_BADGE =
  '[![npm](https://img.shields.io/npm/v/%400xdoublesharp%2Flru-cache-clustered.svg)](https://www.npmjs.com/package/@0xdoublesharp/lru-cache-clustered)';
const LEGACY_VERSION_BADGE =
  '[![npm](https://img.shields.io/npm/v/lru-cache-for-clusters-as-promised.svg)](https://www.npmjs.com/package/lru-cache-for-clusters-as-promised)';
const CANONICAL_DOWNLOADS_BADGE =
  '[![Downloads](https://img.shields.io/npm/dt/%400xdoublesharp%2Flru-cache-clustered.svg)](https://www.npmjs.com/package/@0xdoublesharp/lru-cache-clustered)';
const LEGACY_DOWNLOADS_BADGE =
  '[![Downloads](https://img.shields.io/npm/dt/lru-cache-for-clusters-as-promised.svg)](https://www.npmjs.com/package/lru-cache-for-clusters-as-promised)';
const CANONICAL_NOTE =
  '> `@0xdoublesharp/lru-cache-clustered` is the canonical package name. `lru-cache-for-clusters-as-promised` is published as a mirrored legacy alias from the same source.';
const LEGACY_NOTE = [
  '> This package has moved. New installs should use `@0xdoublesharp/lru-cache-clustered`.',
  '> `lru-cache-for-clusters-as-promised` is published from the same source as a mirrored compatibility alias.',
].join('\n');

await assertBuilt();

const [packageJsonText, canonicalReadme, changelog, license] = await Promise.all([
  readFile(path.join(rootDir, 'package.json'), 'utf8'),
  readFile(path.join(rootDir, 'README.md'), 'utf8'),
  readFile(path.join(rootDir, 'CHANGELOG.md'), 'utf8'),
  readFile(path.join(rootDir, 'LICENSE'), 'utf8'),
]);

const packageJson = JSON.parse(packageJsonText);

await rm(outDir, { recursive: true, force: true });

const variants = [
  {
    dir: 'scoped',
    name: CANONICAL_NAME,
    readme: canonicalReadme,
  },
  {
    dir: 'legacy',
    name: LEGACY_NAME,
    readme: buildLegacyReadme(canonicalReadme),
  },
];

for (const variant of variants) {
  const variantDir = path.join(outDir, variant.dir);
  await mkdir(variantDir, { recursive: true });
  await cp(distDir, path.join(variantDir, 'dist'), { recursive: true });

  const manifest = buildPublishManifest(packageJson, variant.name);
  await Promise.all([
    writeFile(path.join(variantDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`),
    writeFile(path.join(variantDir, 'README.md'), variant.readme),
    writeFile(path.join(variantDir, 'CHANGELOG.md'), changelog),
    writeFile(path.join(variantDir, 'LICENSE'), license),
  ]);
}

async function assertBuilt() {
  const requiredFiles = ['index.js', 'index.cjs', 'index.d.ts', 'index.d.cts'];
  const missing = [];

  for (const file of requiredFiles) {
    try {
      await stat(path.join(distDir, file));
    } catch {
      missing.push(file);
    }
  }

  if (missing.length > 0) {
    throw new Error(`Missing dist artifacts: ${missing.join(', ')}. Run \`pnpm build\` before publishing.`);
  }
}

function buildPublishManifest(baseManifest, name) {
  const {
    name: _unusedName,
    scripts: _unusedScripts,
    devDependencies: _unusedDevDependencies,
    packageManager: _unusedPackageManager,
    pnpm: _unusedPnpm,
    ['lint-staged']: _unusedLintStaged,
    ['size-limit']: _unusedSizeLimit,
    ...publishManifest
  } = baseManifest;

  return {
    ...publishManifest,
    name,
  };
}

function buildLegacyReadme(readme) {
  return readme
    .replace(/^# .+$/m, `# ${LEGACY_NAME}`)
    .replace(CANONICAL_VERSION_BADGE, LEGACY_VERSION_BADGE)
    .replace(CANONICAL_DOWNLOADS_BADGE, LEGACY_DOWNLOADS_BADGE)
    .replace(CANONICAL_NOTE, LEGACY_NOTE);
}
