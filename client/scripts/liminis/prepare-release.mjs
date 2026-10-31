#!/usr/bin/env node
// Turns the built @instantdb/core and @instantdb/react-common into the
// @liminis/instant-* packages, ready for `pnpm pack`. Run it on a fresh
// checkout after `pnpm run build-packages`: it rewrites their package.json
// and README in place.
//
//   node scripts/liminis/prepare-release.mjs 1.0.67-lm.1

import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const client = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const repo = 'https://github.com/liminisapp/instantdb';
const branch = 'liminis-patches';

const version = process.argv[2];
const base = readFileSync(
  join(client, 'packages/version/src/version.ts'),
  'utf8',
).match(/const version = 'v(\d+\.\d+\.\d+)'/)?.[1];
if (!base)
  throw new Error('no upstream version in packages/version/src/version.ts');
if (
  !new RegExp(`^${base.replaceAll('.', '\\.')}-lm\\.\\d+$`).test(version ?? '')
) {
  throw new Error(
    `version must be ${base}-lm.N, the upstream version this branch is on; got ${version}`,
  );
}

const pr = (n) =>
  `[instantdb/instant#${n}](https://github.com/instantdb/instant/pull/${n})`;
const packages = [
  {
    dir: 'packages/core',
    name: '@liminis/instant-core',
    upstream: '@instantdb/core',
    fixes: [
      `Memoise \`dataForQuery\` between notifies, ${pr(2940)}`,
      `Scope the notify after a local write to the queries it can affect, ${pr(2943)}`,
      "Resume a query's optimistic replay instead of repeating it (not offered upstream)",
    ],
    deps: { '@instantdb/version': base },
  },
  {
    dir: 'packages/react-common',
    name: '@liminis/instant-react-common',
    upstream: '@instantdb/react-common',
    fixes: [`Initialise \`useQuery\`'s result ref lazily, ${pr(2941)}`],
    deps: {
      '@instantdb/version': base,
      // So that installing this package alone gets our core, not upstream's.
      '@instantdb/core': `npm:@liminis/instant-core@${version}`,
    },
  },
];

for (const p of packages) {
  const dir = join(client, p.dir);
  const file = join(dir, 'package.json');
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  if (pkg.name !== p.upstream)
    throw new Error(`${file} is ${pkg.name}, expected ${p.upstream}`);
  for (const dep of Object.keys(pkg.dependencies ?? {})) {
    if (pkg.dependencies[dep].startsWith('workspace:') && !(dep in p.deps)) {
      throw new Error(
        `${p.upstream} depends on ${dep} from the workspace; give it a published version`,
      );
    }
  }
  Object.assign(pkg, {
    name: p.name,
    version,
    description: `Unofficial build of ${p.upstream} ${base} with fixes. Not published by Instant.`,
    homepage: `${repo}/tree/${branch}/client/${p.dir}`,
    repository: {
      type: 'git',
      url: `git+${repo}.git`,
      directory: `client/${p.dir}`,
    },
    dependencies: { ...pkg.dependencies, ...p.deps },
    publishConfig: { access: 'public', provenance: true },
  });
  writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
  copyFileSync(join(client, '..', 'LICENSE.md'), join(dir, 'LICENSE.md'));
  writeFileSync(
    join(dir, 'README.md'),
    `# ${p.name}

An unofficial build of [\`${p.upstream}\`](https://www.npmjs.com/package/${p.upstream}),
the InstantDB client, with fixes that upstream hasn't released. It is maintained by
Liminis and **is not published or supported by Instant**.

Version ${version} is upstream ${base} plus these changes:

${p.fixes.map((f) => `- ${f}`).join('\n')}

The source is the \`${branch}\` branch of [liminisapp/instantdb](${repo}), a fork of
[instantdb/instant](https://github.com/instantdb/instant). The changes are in its
commits since upstream ${base}.

## Using it

It installs in place of \`${p.upstream}\`, so apps that depend on \`@instantdb/react\`
or \`@instantdb/core\` need no code changes. Replace both packages, at the same version.
With pnpm:

\`\`\`json
{
  "pnpm": {
    "overrides": {
${packages.map((q) => `      "${q.upstream}": "npm:${q.name}@${version}"`).join(',\n')}
    }
  }
}
\`\`\`

## Licence

Apache-2.0, like InstantDB. See \`LICENSE.md\`. This package is a modified version of
upstream's; the modifications are listed above.
`,
  );
  console.log(`${p.upstream} -> ${p.name}@${version}`);
}
