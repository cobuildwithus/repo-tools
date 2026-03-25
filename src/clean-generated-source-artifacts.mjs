import { execFile } from 'node:child_process';
import { access, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { normalizeAuditPath, parseScanSpec, splitEnvLines } from './audit-context-shared.mjs';

const execFileAsync = promisify(execFile);

const defaultScanSpecs = 'src\nscripts';
const defaultTestScanSpecs = 'tests\ntest';

async function pathExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function getRepoRoot() {
  const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

function getCleanupRoots(env = process.env) {
  const explicitRoots = splitEnvLines(env.COBUILD_AUDIT_CONTEXT_CLEAN_SCAN_ROOTS);
  if (explicitRoots.length > 0) {
    return [...new Set(explicitRoots.map(normalizeAuditPath))];
  }

  const scanSpecs = splitEnvLines(env.COBUILD_AUDIT_CONTEXT_SCAN_SPECS ?? defaultScanSpecs);
  const testScanSpecs = splitEnvLines(env.COBUILD_AUDIT_CONTEXT_TEST_SCAN_SPECS ?? defaultTestScanSpecs);
  const roots = [...scanSpecs, ...testScanSpecs].map((spec) => parseScanSpec(spec).root);
  return [...new Set(roots.filter((root) => root.length > 0))];
}

function getGeneratedArtifactDescriptor(relativePath) {
  const normalizedPath = normalizeAuditPath(relativePath);
  const suffixMap = [
    ['.d.ts.map', ['.ts', '.tsx'], false, []],
    ['.d.mts.map', ['.mts'], false, []],
    ['.d.cts.map', ['.cts'], false, []],
    ['.d.ts', ['.ts', '.tsx'], false, []],
    ['.d.mts', ['.mts'], false, []],
    ['.d.cts', ['.cts'], false, []],
    ['.js.map', ['.ts', '.tsx'], false, []],
    ['.mjs.map', ['.mts'], false, []],
    ['.cjs.map', ['.cts'], false, []],
    ['.js', ['.ts', '.tsx'], true, ['.js.map', '.d.ts', '.d.ts.map']],
    ['.mjs', ['.mts'], true, ['.mjs.map', '.d.mts', '.d.mts.map']],
    ['.cjs', ['.cts'], true, ['.cjs.map', '.d.cts', '.d.cts.map']],
  ];

  for (const [suffix, sourceExtensions, requiresSupportArtifacts, supportSuffixes] of suffixMap) {
    if (!normalizedPath.endsWith(suffix)) {
      continue;
    }

    const prefix = normalizedPath.slice(0, -suffix.length);
    return {
      sourceSiblings: sourceExtensions.map((sourceExtension) => `${prefix}${sourceExtension}`),
      requiresSupportArtifacts,
      supportArtifacts: supportSuffixes.map((supportSuffix) => `${prefix}${supportSuffix}`),
    };
  }

  return null;
}

export async function listGeneratedSourceArtifactsToClean(repoRoot, env = process.env) {
  const cleanupRoots = getCleanupRoots(env);
  if (cleanupRoots.length === 0) {
    return [];
  }

  const { stdout } = await execFileAsync(
    'git',
    ['ls-files', '--others', '--exclude-standard', '-z', '--', ...cleanupRoots],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    }
  );

  const removablePaths = [];
  const untrackedFiles = stdout
    .split('\u0000')
    .map((entry) => normalizeAuditPath(entry))
    .filter((entry) => entry.length > 0);
  const untrackedFileSet = new Set(untrackedFiles);

  for (const relativePath of untrackedFiles) {
    const descriptor = getGeneratedArtifactDescriptor(relativePath);
    if (!descriptor) {
      continue;
    }

    if (descriptor.requiresSupportArtifacts && !descriptor.supportArtifacts.some((artifactPath) => untrackedFileSet.has(artifactPath))) {
      continue;
    }

    for (const sibling of descriptor.sourceSiblings) {
      if (await pathExists(path.join(repoRoot, sibling))) {
        removablePaths.push(relativePath);
        break;
      }
    }
  }

  return removablePaths.sort();
}

export async function cleanGeneratedSourceArtifacts(repoRoot, env = process.env) {
  const removablePaths = await listGeneratedSourceArtifactsToClean(repoRoot, env);

  for (const relativePath of removablePaths) {
    await rm(path.join(repoRoot, relativePath), { force: true });
  }

  return removablePaths;
}

export async function main() {
  const repoRoot = await getRepoRoot();
  const removedPaths = await cleanGeneratedSourceArtifacts(repoRoot);

  if (removedPaths.length === 0) {
    console.log('No untracked generated source artifacts required cleanup.');
    return;
  }

  console.log(`Removed ${removedPaths.length} untracked generated source artifact(s).`);
  for (const relativePath of removedPaths) {
    console.log(`- ${relativePath}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
