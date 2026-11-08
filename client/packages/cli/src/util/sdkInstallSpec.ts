import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageDirectorySync } from 'package-directory';

type OwnPackage = { name?: string; version?: string };

// The fork's packages are published as `@liminis/instant-<dir>`, from the same
// source as `@instantdb/<dir>`.
const FORK_SCOPE = '@liminis/';
const FORK_PREFIX = '@liminis/instant-';

function readOwnPackage(): OwnPackage {
  try {
    const dir = packageDirectorySync({
      cwd: dirname(fileURLToPath(import.meta.url)),
    });
    return dir
      ? JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      : {};
  } catch {
    return {};
  }
}

/**
 * The spec to install an Instant SDK package with. Upstream's CLI installs it
 * by name. A fork's build of the CLI installs the fork's build of the package,
 * at the CLI's own version, under the `@instantdb/` name, so that the app's
 * imports are unchanged and its client packages all come from one release.
 */
export function sdkInstallSpec(
  moduleName: string,
  self: OwnPackage = readOwnPackage(),
): string {
  if (
    !moduleName.startsWith('@instantdb/') ||
    !self.name?.startsWith(FORK_SCOPE) ||
    !self.version
  ) {
    return moduleName;
  }
  const dir = moduleName.slice('@instantdb/'.length);
  return `${moduleName}@npm:${FORK_PREFIX}${dir}@${self.version}`;
}
