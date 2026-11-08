#!/usr/bin/env node
// Turns every built package in client/packages into its @liminis build, ready
// for `pnpm pack`. Run it after `pnpm run build-packages`; it rewrites each
// package's package.json and README in place.
//
//   node scripts/liminis/prepare-release.mjs 1.0.67-lm.2
//
// Naming: @instantdb/<x> -> @liminis/instant-<x>, instant-cli ->
// @liminis/instant-cli, create-instant-app -> @liminis/create-instant-app.
//
// Every dependency on another package in this workspace becomes an npm alias
// to our build at the same version, under the upstream name:
//
//   "@instantdb/core": "npm:@liminis/instant-core@1.0.67-lm.2"
//
// so the source keeps importing `@instantdb/*`, and installing any one of our
// packages brings in only our builds of the others. An app switches by
// aliasing the @instantdb packages it uses in the same way.
//
// The version the client reports to the server stays upstream's (`v1.0.67`
// in packages/version). The server enables protocol features by parsing it,
// and it only accepts plain semver, so a `-lm.N` there would turn them off.
//
// Writes scripts/liminis/release-manifest.json: the packages in the order to
// publish them, dependencies first.

import {
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const client = join(here, '..', '..');
const repoRoot = join(client, '..');
const repo = 'https://github.com/liminisapp/instantdb';
const branch = 'self-hosted-patches';

const version = process.argv[2];
const base = readFileSync(
  join(client, 'packages/version/src/version.ts'),
  'utf8',
).match(/const version = 'v(\d+\.\d+\.\d+)'/)?.[1];
if (!base) {
  throw new Error('no upstream version in packages/version/src/version.ts');
}
if (
  !new RegExp(`^${base.replaceAll('.', '\\.')}-lm\\.\\d+$`).test(version ?? '')
) {
  throw new Error(
    `version must be ${base}-lm.N, the upstream version this branch is on; got ${version}`,
  );
}

export function forkName(upstream) {
  if (upstream.startsWith('@instantdb/')) {
    return `@liminis/instant-${upstream.slice('@instantdb/'.length)}`;
  }
  if (upstream === 'instant-cli') return '@liminis/instant-cli';
  if (upstream === 'create-instant-app') return '@liminis/create-instant-app';
  throw new Error(`no @liminis name for ${upstream}; add one to forkName`);
}

const aliasTo = (upstream) => `npm:${forkName(upstream)}@${version}`;

// --- read the workspace ------------------------------------------------------

const packagesDir = join(client, 'packages');
const packages = readdirSync(packagesDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => join(packagesDir, d.name))
  .filter((dir) => existsSync(join(dir, 'package.json')))
  .map((dir) => ({
    dir,
    file: join(dir, 'package.json'),
    pkg: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')),
  }))
  .filter(({ pkg }) => pkg.private !== true);

const workspaceNames = new Set(packages.map(({ pkg }) => pkg.name));
for (const { pkg } of packages) {
  if (pkg.name.startsWith('@liminis/')) {
    throw new Error(`${pkg.name} is already prepared; run on a fresh build`);
  }
  forkName(pkg.name); // every package must have a fork name
}

const depFields = [
  'dependencies',
  'peerDependencies',
  'optionalDependencies',
  'devDependencies',
];

function rewriteDeps(pkg, where) {
  for (const field of depFields) {
    const deps = pkg[field];
    if (!deps) continue;
    for (const [dep, spec] of Object.entries(deps)) {
      if (spec.startsWith('workspace:')) {
        if (!workspaceNames.has(dep)) {
          throw new Error(
            `${where}: ${dep} is ${spec} but not in the workspace`,
          );
        }
        if (field === 'devDependencies') {
          // Consumers never install these, and our build isn't the upstream
          // version that `workspace:` would become.
          delete deps[dep];
        } else {
          deps[dep] = aliasTo(dep);
        }
      }
    }
    if (Object.keys(deps).length === 0) delete pkg[field];
  }
}

// Rewrites an app template's dependencies on our packages to our build.
function rewriteTemplateDeps(pkg) {
  for (const field of depFields) {
    for (const dep of Object.keys(pkg[field] ?? {})) {
      if (workspaceNames.has(dep)) pkg[field][dep] = aliasTo(dep);
    }
  }
}

// --- the version the client reports -----------------------------------------

const builtVersion = readdirSync(join(client, 'packages/version/dist'), {
  recursive: true,
})
  .filter((f) => /\.(c|m)?js$/.test(f))
  .map((f) => readFileSync(join(client, 'packages/version/dist', f), 'utf8'))
  .join('\n');
if (!builtVersion.includes(`v${base}`) || builtVersion.includes('-lm.')) {
  throw new Error(
    `packages/version/dist must report v${base} to the server; build it from an unmodified version.ts`,
  );
}

// --- rewrite -----------------------------------------------------------------

const readme = (upstream, name) => `# ${name}

The [liminisapp/instantdb](${repo}) build of
[\`${upstream}\`](https://www.npmjs.com/package/${upstream}). It is maintained by
Liminis and **is not published or supported by the Instant team**.

liminisapp/instantdb is a maintained fork of
[Instant](https://github.com/instantdb/instant): its server and its client
packages are released together, from the same commit, at the same version.
Version ${version} is upstream ${base} plus the fork's fixes; see the
[release notes](${repo}/releases/tag/lm-v${version}).

## Using it

Install it under its upstream name, so your imports don't change. Do the same for
every \`@instantdb/*\` package your app uses, at the same version, and pin it
exactly: a range such as \`^${version}\` would also accept upstream's next release.

\`\`\`sh
npm install --save-exact ${upstream}@npm:${name}@${version}
\`\`\`

which adds this to \`package.json\`:

\`\`\`json
"${upstream}": "npm:${name}@${version}"
\`\`\`

Its own dependencies on other Instant packages already point at this fork's
builds, so there is only ever one copy of each.

## Licence

Apache-2.0, like Instant. See \`LICENSE.md\`. This is a modified version of
upstream's package; the changes are in the fork's commits since upstream ${base}.
`;

const manifest = [];
for (const { dir, file, pkg } of packages) {
  const upstream = pkg.name;
  const name = forkName(upstream);
  const rel = dir.slice(repoRoot.length + 1);
  rewriteDeps(pkg, upstream);
  Object.assign(pkg, {
    name,
    version,
    description: `The liminisapp/instantdb build of ${upstream}. Not published by Instant.`,
    homepage: `${repo}/tree/${branch}/${rel}`,
    repository: { type: 'git', url: `git+${repo}.git`, directory: rel },
    bugs: { url: `${repo}/issues` },
    publishConfig: { access: 'public', provenance: true },
  });
  writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
  copyFileSync(join(repoRoot, 'LICENSE.md'), join(dir, 'LICENSE.md'));
  writeFileSync(join(dir, 'README.md'), readme(upstream, name));

  // create-instant-app's bundled app templates
  const templates = join(dir, 'template', 'base');
  if (existsSync(templates)) {
    for (const t of readdirSync(templates)) {
      const tf = join(templates, t, 'package.json');
      if (!existsSync(tf)) continue;
      const tp = JSON.parse(readFileSync(tf, 'utf8'));
      rewriteTemplateDeps(tp);
      writeFileSync(tf, JSON.stringify(tp, null, 2) + '\n');
    }
  }

  const deps = Object.keys({
    ...pkg.dependencies,
    ...pkg.peerDependencies,
    ...pkg.optionalDependencies,
  }).filter((d) => workspaceNames.has(d));
  manifest.push({ upstream, name, dir: rel, deps });
  console.log(`${upstream} -> ${name}@${version}`);
}

// dependencies first
const ordered = [];
const done = new Set();
const visiting = new Set();
const byUpstream = new Map(manifest.map((m) => [m.upstream, m]));
function visit(m) {
  if (done.has(m.upstream)) return;
  if (visiting.has(m.upstream)) {
    throw new Error(`dependency cycle at ${m.upstream}`);
  }
  visiting.add(m.upstream);
  for (const d of m.deps) visit(byUpstream.get(d));
  visiting.delete(m.upstream);
  done.add(m.upstream);
  ordered.push(m);
}
manifest.forEach(visit);

writeFileSync(
  join(here, 'release-manifest.json'),
  JSON.stringify({ version, base, packages: ordered }, null, 2) + '\n',
);
console.log(
  `${ordered.length} packages; publish order in release-manifest.json`,
);
