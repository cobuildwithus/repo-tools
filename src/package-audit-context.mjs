import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  matchesScanSpec,
  normalizeAuditPath,
  parseBooleanFlag,
  parseScanSpec,
  pathHasDirectorySegment,
  splitEnvLines,
} from './audit-context-shared.mjs';
import { cleanGeneratedSourceArtifacts } from './clean-generated-source-artifacts.mjs';

const execFileAsync = promisify(execFile);

const defaultPruneDirNames = [
  'node_modules',
  '.git',
  'dist',
  '.next',
  '.test-dist',
  '.turbo',
  '.vercel',
  'out',
  'cache',
  'coverage',
  'audit-packages',
];

function globToRegExp(glob) {
  const escaped = glob
    .replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'u');
}

function isBlockedEnvPath(relativePath) {
  return /(^|\/)\.env(?:\.[^/]+)?$/u.test(relativePath) && !/(^|\/)\.env(?:\.[^/]+)?\.example$/u.test(relativePath);
}

function getBlockedArtifactPath(relativePath, blockedDirectoryNames) {
  const normalizedPath = normalizeAuditPath(relativePath);
  if (normalizedPath.length === 0) {
    return null;
  }

  if (isBlockedEnvPath(normalizedPath)) {
    return normalizedPath;
  }

  if (normalizedPath.endsWith('.tsbuildinfo')) {
    return normalizedPath;
  }

  const pathSegments = normalizedPath.split('/');
  let currentPath = '';
  for (let index = 0; index < pathSegments.length - 1; index += 1) {
    currentPath = currentPath ? `${currentPath}/${pathSegments[index]}` : pathSegments[index];
    if (blockedDirectoryNames.has(pathSegments[index])) {
      return `${currentPath}/`;
    }
  }

  return null;
}

function isSensitiveAuditPath(relativePath) {
  const normalizedPath = normalizeAuditPath(relativePath);
  const baseName = path.posix.basename(normalizedPath);

  switch (true) {
    case /(^|\/)\.aws\//u.test(normalizedPath):
    case /(^|\/)\.ssh\//u.test(normalizedPath):
    case /(^|\/)\.gnupg\//u.test(normalizedPath):
    case /(^|\/)audit-packages\//u.test(normalizedPath):
      return true;
    default:
      break;
  }

  switch (baseName) {
    case '.npmrc':
    case '.netrc':
    case '.pypirc':
    case '.dockercfg':
    case 'docker-config.json':
    case 'id_rsa':
    case 'id_dsa':
    case 'id_ecdsa':
    case 'id_ed25519':
    case 'authorized_keys':
    case 'known_hosts':
      return true;
    default:
      break;
  }

  return (
    /\.(pem|key|p8|p12|pfx|crt|cer|der|jks|kdb|pkcs12|ovpn|kubeconfig)$/u.test(baseName) ||
    /\.(zip|tar|tgz|gz|bz2|xz|7z)$/u.test(baseName)
  );
}

function buildAuditManifestPaths({
  visibleFiles,
  alwaysPaths,
  scanSpecs,
  testScanSpecs,
  docScanSpecs,
  ciScanSpecs,
  includeTests,
  includeDocs,
  includeCi,
  excludeGlobs,
  excludeSensitive,
  pruneDirectoryNames,
}) {
  const selectedPaths = new Set();
  const alwaysPathSet = new Set(Array.from(alwaysPaths, normalizeAuditPath));
  const pruneDirectorySet = new Set(pruneDirectoryNames);
  const blockedDirectorySet = new Set(pruneDirectoryNames);
  const excludePatterns = excludeGlobs.map((glob) => globToRegExp(glob));
  const activeScanSpecs = [...scanSpecs];

  if (includeTests) {
    activeScanSpecs.push(...testScanSpecs);
  }
  if (includeDocs) {
    activeScanSpecs.push(...docScanSpecs);
  }
  if (includeCi) {
    activeScanSpecs.push(...ciScanSpecs);
  }

  for (const candidate of visibleFiles) {
    const normalizedPath = normalizeAuditPath(candidate);
    if (normalizedPath.length === 0) {
      continue;
    }

    if (getBlockedArtifactPath(normalizedPath, blockedDirectorySet)) {
      continue;
    }

    if (excludePatterns.some((pattern) => pattern.test(normalizedPath))) {
      console.error(`Warning: excluding path from audit package: ${normalizedPath}`);
      continue;
    }

    if (excludeSensitive && isSensitiveAuditPath(normalizedPath)) {
      console.error(`Warning: excluding path from audit package: ${normalizedPath}`);
      continue;
    }

    if (alwaysPathSet.has(normalizedPath)) {
      selectedPaths.add(normalizedPath);
      continue;
    }

    if (pathHasDirectorySegment(normalizedPath, pruneDirectorySet)) {
      continue;
    }

    if (activeScanSpecs.some((scanSpec) => matchesScanSpec(normalizedPath, scanSpec))) {
      selectedPaths.add(normalizedPath);
    }
  }

  return [...selectedPaths].sort();
}

async function getRepoRoot() {
  const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

async function getGitVisibleFiles(repoRoot) {
  const { stdout } = await execFileAsync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });

  return stdout
    .split('\u0000')
    .map((entry) => normalizeAuditPath(entry))
    .filter((entry) => entry.length > 0);
}

async function createZip(repoRoot, zipPath, manifestPaths) {
  await new Promise((resolve, reject) => {
    const child = spawn('zip', ['-q', zipPath, '-@'], {
      cwd: repoRoot,
      stdio: ['pipe', 'ignore', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(stderr.trim() || `zip exited with code ${code ?? 'unknown'}.`));
    });

    child.stdin.end(`${manifestPaths.join('\n')}\n`);
  });
}

async function writeMergedTextFile(repoRoot, txtPath, manifestPaths, title, repoLabel) {
  const chunks = [
    `# ${title}`,
    `# Generated (UTC): ${new Date().toISOString().replace(/\.\d{3}Z$/u, 'Z')}`,
    `# Repository: ${repoLabel}`,
    `# Files: ${manifestPaths.length}`,
  ];

  for (const relativePath of manifestPaths) {
    const absolutePath = path.join(repoRoot, relativePath);
    const contents = await readFile(absolutePath, 'utf8');
    chunks.push(`\n===== FILE: ${relativePath} =====\n${contents}`);
  }

  await writeFile(txtPath, `${chunks.join('\n')}\n`, 'utf8');
}

function stripComments(contents) {
  return contents.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\n]*$/gmu, '');
}

function resolveImportPath(fromFile, importPath) {
  const basePath = importPath.startsWith('src/') ? importPath : path.posix.join(path.posix.dirname(fromFile), importPath);
  const resolvedPath = path.posix.normalize(basePath);

  if (resolvedPath.startsWith('../') || resolvedPath === '..') {
    return null;
  }

  return normalizeAuditPath(resolvedPath);
}

async function validateSolidityImportClosure(repoRoot, manifestPaths) {
  const manifestSet = new Set(manifestPaths);
  const missingImports = new Set();

  for (const relativePath of manifestPaths) {
    if (!relativePath.endsWith('.sol')) {
      continue;
    }

    const contents = stripComments(await readFile(path.join(repoRoot, relativePath), 'utf8'));
    for (const match of contents.matchAll(/\bimport\s+(?:[^"';]+?\s+from\s+)?["']([^"']+)["']\s*;/gu)) {
      const importPath = match[1];
      if (!importPath.startsWith('./') && !importPath.startsWith('../') && !importPath.startsWith('src/')) {
        continue;
      }

      const resolvedPath = resolveImportPath(relativePath, importPath);
      if (!resolvedPath) {
        missingImports.add(`${relativePath} -> ${importPath} (resolved outside repo)`);
        continue;
      }

      const absolutePath = path.join(repoRoot, resolvedPath);
      const sourceExists = await stat(absolutePath).then(() => true).catch(() => false);
      if (!sourceExists) {
        missingImports.add(`${relativePath} -> ${importPath} (file not found: ${resolvedPath})`);
        continue;
      }

      if (!manifestSet.has(resolvedPath)) {
        missingImports.add(`${relativePath} -> ${importPath} (not packaged: ${resolvedPath})`);
      }
    }
  }

  if (missingImports.size > 0) {
    const ordered = [...missingImports].sort().join('\n');
    throw new Error(`Error: package manifest failed Solidity import closure check.\n${ordered}`);
  }
}

function formatSize(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unitIndex]}`;
}

function formatUtcBundleTimestamp() {
  const iso = new Date().toISOString();
  const [datePart, timeWithMillis] = iso.split('T');
  const timePart = timeWithMillis.replace(/\.\d{3}Z$/u, 'Z');
  return `${datePart.replace(/-/g, '')}-${timePart.replace(/:/g, '')}`;
}

function printUsage(prefixDefault, repoLabel, sensitiveNote) {
  const extraNote = sensitiveNote ? `\n${sensitiveNote}` : '';
  console.error(`Usage: cobuild-package-audit-context [options]

Packages audit-relevant ${repoLabel} files into upload-friendly artifacts.${extraNote}

Options:
  --zip              Create only a .zip archive
  --txt              Create only a merged .txt file
  --both             Create both .zip and .txt (default)
  --out-dir <dir>    Output directory (default: <repo>/audit-packages)
  --name <prefix>    Output filename prefix (default: ${prefixDefault})
  --with-tests       Include configured test scan paths
  --no-tests         Exclude configured test scan paths
  --with-docs        Include configured docs scan paths
  --no-docs          Exclude configured docs scan paths
  --with-ci          Include configured CI scan paths
  --no-ci            Exclude configured CI scan paths
  -h, --help         Show this help message`);
}

function getDefaultOptionsFromEnv(env = process.env) {
  return {
    prefix: env.COBUILD_AUDIT_CONTEXT_PREFIX?.trim() || 'cobuild-audit',
    title: env.COBUILD_AUDIT_CONTEXT_TITLE?.trim() || 'Cobuild Audit Bundle',
    repoLabel: env.COBUILD_AUDIT_CONTEXT_REPO_LABEL?.trim() || 'repo',
    sensitiveNote: env.COBUILD_AUDIT_CONTEXT_SENSITIVE_NOTE?.trim() || '',
    includeTests: parseBooleanFlag(env.COBUILD_AUDIT_CONTEXT_INCLUDE_TESTS_DEFAULT, true),
    includeDocs: parseBooleanFlag(env.COBUILD_AUDIT_CONTEXT_INCLUDE_DOCS_DEFAULT, true),
    includeCi: parseBooleanFlag(env.COBUILD_AUDIT_CONTEXT_INCLUDE_CI_DEFAULT, true),
    alwaysPaths: splitEnvLines(env.COBUILD_AUDIT_CONTEXT_ALWAYS_PATHS),
    scanSpecs: splitEnvLines(env.COBUILD_AUDIT_CONTEXT_SCAN_SPECS || 'src\nscripts').map(parseScanSpec),
    testScanSpecs: splitEnvLines(env.COBUILD_AUDIT_CONTEXT_TEST_SCAN_SPECS || 'tests\ntest').map(parseScanSpec),
    docScanSpecs: splitEnvLines(env.COBUILD_AUDIT_CONTEXT_DOC_SCAN_SPECS || 'agent-docs:*.md').map(parseScanSpec),
    ciScanSpecs: splitEnvLines(env.COBUILD_AUDIT_CONTEXT_CI_SCAN_SPECS || '.github/workflows').map(parseScanSpec),
    pruneDirectoryNames:
      splitEnvLines(env.COBUILD_AUDIT_CONTEXT_PRUNE_DIR_NAMES).length > 0
        ? splitEnvLines(env.COBUILD_AUDIT_CONTEXT_PRUNE_DIR_NAMES)
        : defaultPruneDirNames,
    excludeGlobs: splitEnvLines(env.COBUILD_AUDIT_CONTEXT_EXCLUDE_GLOBS),
    excludeSensitive: parseBooleanFlag(env.COBUILD_AUDIT_CONTEXT_EXCLUDE_SENSITIVE, false),
    validateSolidityClosure: parseBooleanFlag(env.COBUILD_AUDIT_CONTEXT_VALIDATE_SOLIDITY_IMPORT_CLOSURE, false),
  };
}

function parseArgs(argv, defaults) {
  let format = 'both';
  let outDir;
  let includeTests = defaults.includeTests;
  let includeDocs = defaults.includeDocs;
  let includeCi = defaults.includeCi;
  let prefix = defaults.prefix;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case '--zip':
        format = 'zip';
        break;
      case '--txt':
        format = 'txt';
        break;
      case '--both':
        format = 'both';
        break;
      case '--out-dir':
        if (index + 1 >= argv.length) {
          throw new Error('Error: --out-dir requires a value.');
        }
        outDir = argv[index + 1];
        index += 1;
        break;
      case '--name':
        if (index + 1 >= argv.length) {
          throw new Error('Error: --name requires a value.');
        }
        prefix = argv[index + 1];
        index += 1;
        break;
      case '--with-tests':
        includeTests = true;
        break;
      case '--no-tests':
        includeTests = false;
        break;
      case '--with-docs':
        includeDocs = true;
        break;
      case '--no-docs':
        includeDocs = false;
        break;
      case '--with-ci':
        includeCi = true;
        break;
      case '--no-ci':
        includeCi = false;
        break;
      case '-h':
      case '--help':
        printUsage(defaults.prefix, defaults.repoLabel, defaults.sensitiveNote);
        process.exit(0);
      default:
        throw new Error(`Error: unknown option '${argument}'.`);
    }
  }

  return {
    ...defaults,
    format,
    outDir,
    prefix,
    includeTests,
    includeDocs,
    includeCi,
  };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const defaults = getDefaultOptionsFromEnv(env);
  const options = parseArgs(argv, defaults);
  const repoRoot = await getRepoRoot();

  if ((options.format === 'zip' || options.format === 'both') && !process.env.PATH?.includes('zip')) {
    // fall through to an explicit runtime check below; this avoids a false positive when PATH is unset.
  }
  if ((options.format === 'zip' || options.format === 'both')) {
    const zipCheck = await execFileAsync('sh', ['-lc', 'command -v zip'], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    }).catch(() => null);
    if (!zipCheck || !zipCheck.stdout.trim()) {
      throw new Error('Error: zip is required for --zip/--both modes.');
    }
  }

  const removedPaths = await cleanGeneratedSourceArtifacts(repoRoot, env);
  if (removedPaths.length === 0) {
    console.log('No untracked generated source artifacts required cleanup.');
  } else {
    console.log(`Removed ${removedPaths.length} untracked generated source artifact(s).`);
    for (const relativePath of removedPaths) {
      console.log(`- ${relativePath}`);
    }
  }

  const outputDirectory = options.outDir ? path.resolve(repoRoot, options.outDir) : path.join(repoRoot, 'audit-packages');
  await mkdir(outputDirectory, { recursive: true });

  const visibleFiles = await getGitVisibleFiles(repoRoot);
  const manifestPaths = buildAuditManifestPaths({
    visibleFiles,
    alwaysPaths: options.alwaysPaths,
    scanSpecs: options.scanSpecs,
    testScanSpecs: options.testScanSpecs,
    docScanSpecs: options.docScanSpecs,
    ciScanSpecs: options.ciScanSpecs,
    includeTests: options.includeTests,
    includeDocs: options.includeDocs,
    includeCi: options.includeCi,
    excludeGlobs: options.excludeGlobs,
    excludeSensitive: options.excludeSensitive,
    pruneDirectoryNames: options.pruneDirectoryNames,
  });

  if (manifestPaths.length === 0) {
    throw new Error('Error: no files matched packaging filters.');
  }

  if (options.validateSolidityClosure) {
    await validateSolidityImportClosure(repoRoot, manifestPaths);
  }

  const timestamp = formatUtcBundleTimestamp();
  const baseName = `${options.prefix}-${timestamp}`;
  let zipPath;
  let txtPath;

  if (options.format === 'zip' || options.format === 'both') {
    zipPath = path.join(outputDirectory, `${baseName}.zip`);
    await createZip(repoRoot, zipPath, manifestPaths);
  }

  if (options.format === 'txt' || options.format === 'both') {
    txtPath = path.join(outputDirectory, `${baseName}.txt`);
    await writeMergedTextFile(repoRoot, txtPath, manifestPaths, options.title, options.repoLabel);
  }

  console.log('Audit package created.');
  console.log(`Included files: ${manifestPaths.length}`);

  if (zipPath) {
    const zipStats = await stat(zipPath);
    console.log(`ZIP: ${path.resolve(zipPath)} (${formatSize(zipStats.size)})`);
  }
  if (txtPath) {
    const txtStats = await stat(txtPath);
    console.log(`TXT: ${path.resolve(txtPath)} (${formatSize(txtStats.size)})`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
