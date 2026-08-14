import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const nodeBinDir = path.dirname(process.execPath);

function run(cmd, args, cwd, env = {}) {
  const result = spawnSync(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result;
}

function runAllowFail(cmd, args, cwd, env = {}) {
  return spawnSync(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

function makeRepo() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'repo-tools-'));
  run('git', ['init', '-b', 'main'], root);
  writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify(
      {
        name: 'fixture',
        version: '0.0.0',
        packageManager: 'pnpm@9.15.9+sha512.68046141893c66fad01c079231128e9afb89ef87e2691d69e4d40eee228988295fd4682181bae55b58418c3a253bde65a505ec7c5f9403ece5cc3cd37dcf2531',
      },
      null,
      2
    ) + '\n'
  );
  return root;
}

function configureGitUser(root) {
  run('git', ['config', 'user.email', 'test@example.invalid'], root);
  run('git', ['config', 'user.name', 'Test User'], root);
}

function gitPath(root, name) {
  const output = run('git', ['rev-parse', '--git-path', name], root).stdout.trim();
  return path.isAbsolute(output) ? output : path.join(root, output);
}

function makeCommittedFileRepo(files) {
  const root = makeRepo();
  configureGitUser(root);
  for (const [name, contents] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), contents);
  }
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'chore: seed'], root);
  return root;
}

function makeGeneratedArtifactCommitRepo() {
  const root = makeRepo();
  configureGitUser(root);
  writeFileSync(path.join(root, 'source.txt'), 'source v1\n');
  writeFileSync(path.join(root, 'generated.txt'), 'generated v1\n');
  writeFileSync(path.join(root, 'unrelated.txt'), 'unrelated v1\n');
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'chore: seed'], root);

  const hookPath = path.join(root, '.git/hooks/pre-commit');
  writeFileSync(
    hookPath,
    '#!/usr/bin/env bash\nset -euo pipefail\nprintf "generated v2\\n" > generated.txt\ngit add generated.txt\n'
  );
  run('chmod', ['+x', hookPath], root);
  writeFileSync(path.join(root, 'source.txt'), 'source v2\n');
  writeFileSync(path.join(root, 'unrelated.txt'), 'unrelated staged\n');
  run('git', ['add', 'unrelated.txt'], root);
  return root;
}

function linkInstalledBin(root, binName) {
  const binDir = path.join(root, 'node_modules', '.bin');
  mkdirSync(binDir, { recursive: true });
  const target = path.join(repoRoot, 'bin', binName);
  const linkPath = path.join(binDir, binName);
  symlinkSync(target, linkPath);
  return linkPath;
}

function createFakePnpm(root) {
  const binDir = path.join(root, 'fake-bin');
  mkdirSync(binDir, { recursive: true });
  const fakePnpm = path.join(binDir, 'pnpm');
  writeFileSync(
    fakePnpm,
    `#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -gt 0 ] && [ "$1" = "version" ]; then
  shift
  action="$1"
  shift

  node - "$action" "$@" <<'EOF'
const fs = require('node:fs');

const [action, ...args] = process.argv.slice(2);
const pkgPath = 'package.json';
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const [major, minor, patchAndRest] = String(pkg.version).split('.');
const patch = Number((patchAndRest || '0').split('-')[0]);
let nextVersion = pkg.version;

if (action === 'patch') {
  nextVersion = [major, minor, String(patch + 1)].join('.');
}

for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--preid') {
    nextVersion = nextVersion + '-' + args[i + 1] + '.0';
    i += 1;
  }
}

pkg.version = nextVersion;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\\n');
fs.writeFileSync('pnpm-lock.yaml', "lockfileVersion: '9.0'\\n\\nimporters:\\n\\n  .:\\n    version: " + nextVersion + "\\n");
process.stdout.write('v' + nextVersion + '\\n');
EOF
  exit 0
fi

if [ "$#" -gt 0 ]; then
  script_name="$1"
  script_cmd="$(node -p "const pkg = require('./package.json'); (pkg.scripts || {})['$script_name'] || ''")"
  if [ -n "$script_cmd" ]; then
    shift
    exec bash -lc "$script_cmd"
  fi
fi

echo "fake pnpm does not implement: $*" >&2
exit 1
`
  );
  run('chmod', ['+x', fakePnpm], root);
  return binDir;
}

test('open and close exec plan manage lifecycle', () => {
  const root = makeRepo();
  mkdirSync(path.join(root, 'agent-docs/exec-plans/active'), { recursive: true });
  mkdirSync(path.join(root, 'agent-docs/exec-plans/completed'), { recursive: true });

  run(path.join(repoRoot, 'bin/cobuild-open-exec-plan'), ['sample-task', 'Sample Task'], root);
  const activeDir = path.join(root, 'agent-docs/exec-plans/active');
  const [planFile] = readdirSync(activeDir);
  assert.ok(planFile.endsWith('-sample-task.md'));

  run(path.join(repoRoot, 'bin/cobuild-close-exec-plan'), [path.join('agent-docs/exec-plans/active', planFile)], root);
  const completed = readFileSync(path.join(root, 'agent-docs/exec-plans/completed', planFile), 'utf8');
  assert.match(completed, /Status: completed/);
  rmSync(root, { recursive: true, force: true });
});

test('doc gardening tracks agent docs, llm refs, and configured extras', () => {
  const root = makeRepo();
  mkdirSync(path.join(root, 'agent-docs/references'), { recursive: true });
  mkdirSync(path.join(root, 'agent-docs/generated'), { recursive: true });
  writeFileSync(path.join(root, 'ARCHITECTURE.md'), '# Arch\n');
  writeFileSync(path.join(root, 'agent-docs/index.md'), [
    '| Path | Summary |',
    '| --- | --- |',
    '| `agent-docs/references/` | refs |',
    '| `ARCHITECTURE.md` | arch |',
  ].join('\n') + '\n');
  writeFileSync(path.join(root, 'agent-docs/references/test-llms.txt'), 'llm notes\n');

  run(path.join(repoRoot, 'bin/cobuild-doc-gardening'), [], root, {
    COBUILD_DOC_GARDENING_EXTRA_TRACKED_PATHS: 'ARCHITECTURE.md\n',
  });

  const inventory = readFileSync(path.join(root, 'agent-docs/generated/doc-inventory.md'), 'utf8');
  assert.match(inventory, /ARCHITECTURE\.md/);
  assert.match(inventory, /test-llms\.txt/);
  rmSync(root, { recursive: true, force: true });
});

test('docs drift passes for metadata-only dependency changes', () => {
  const root = makeRepo();
  mkdirSync(path.join(root, 'agent-docs/prompts'), { recursive: true });
  mkdirSync(path.join(root, 'agent-docs/references'), { recursive: true });
  mkdirSync(path.join(root, 'agent-docs/generated'), { recursive: true });
  mkdirSync(path.join(root, 'agent-docs/exec-plans/active'), { recursive: true });
  mkdirSync(path.join(root, 'agent-docs/exec-plans/completed'), { recursive: true });
  writeFileSync(path.join(root, 'AGENTS.md'), '# agents\n');
  writeFileSync(path.join(root, 'ARCHITECTURE.md'), '# arch\n');
  writeFileSync(path.join(root, 'agent-docs/index.md'), '| Path | Summary |\n| --- | --- |\n| `agent-docs/` | docs |\n');
  for (const file of ['PLANS.md', 'RELIABILITY.md', 'SECURITY.md', 'QUALITY_SCORE.md']) writeFileSync(path.join(root, 'agent-docs', file), '# doc\n');
  for (const file of ['simplify.md', 'test-coverage-audit.md', 'task-finish-review.md']) writeFileSync(path.join(root, 'agent-docs/prompts', file), '# prompt\n');
  for (const file of ['README.md', 'testing-ci-map.md']) writeFileSync(path.join(root, 'agent-docs/references', file), '# ref\n');
  writeFileSync(path.join(root, 'agent-docs/generated/README.md'), '# generated\n');
  writeFileSync(path.join(root, 'agent-docs/generated/doc-inventory.md'), '# inv\n');
  writeFileSync(path.join(root, 'agent-docs/generated/doc-gardening-report.md'), '# report\n');
  writeFileSync(path.join(root, 'agent-docs/exec-plans/active/README.md'), '# active\n');
  writeFileSync(path.join(root, 'agent-docs/exec-plans/completed/README.md'), '# completed\n');
  writeFileSync(path.join(root, 'agent-docs/exec-plans/tech-debt-tracker.md'), '# debt\n');
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'chore: seed'], root, { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' });

  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  pkg.dependencies = { foo: '^1.0.0' };
  writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  run('git', ['add', 'package.json'], root);

  run(path.join(repoRoot, 'bin/cobuild-check-agent-docs-drift'), [], root, {
    COBUILD_DRIFT_REQUIRED_FILES: ['agent-docs/index.md','ARCHITECTURE.md','AGENTS.md','agent-docs/PLANS.md','agent-docs/RELIABILITY.md','agent-docs/SECURITY.md','agent-docs/QUALITY_SCORE.md','agent-docs/prompts/simplify.md','agent-docs/prompts/test-coverage-audit.md','agent-docs/prompts/task-finish-review.md','agent-docs/references/README.md','agent-docs/references/testing-ci-map.md','agent-docs/generated/README.md','agent-docs/generated/doc-inventory.md','agent-docs/generated/doc-gardening-report.md','agent-docs/exec-plans/active/README.md','agent-docs/exec-plans/completed/README.md','agent-docs/exec-plans/tech-debt-tracker.md'].join('\n') + '\n',
    COBUILD_DRIFT_CODE_CHANGE_PATTERN: '^(src/|scripts/|package\\.json$|README\\.md$|ARCHITECTURE\\.md$|AGENTS\\.md$)',
  });
  rmSync(root, { recursive: true, force: true });
});

test('docs drift detects an early match in a long installed changed-file list under pipefail', () => {
  const root = makeRepo();
  const installedDriftCheck = linkInstalledBin(root, 'cobuild-check-agent-docs-drift');
  const fakeBin = path.join(root, 'fake-git-bin');
  mkdirSync(fakeBin, { recursive: true });
  const realGit = run('sh', ['-c', 'command -v git'], root).stdout.trim();
  const fakeGit = path.join(fakeBin, 'git');
  writeFileSync(
    fakeGit,
    `#!/usr/bin/env bash
set -euo pipefail
if [ "$#" -eq 3 ] && [ "$1" = diff ] && [ "$2" = --name-only ] && [ "$3" = --cached ]; then
  printf 'src/trigger.ts\\n'
  for ((i = 0; i < 8192; i++)); do
    printf 'fixtures/long-changed-file-%04d-%0200d.txt\\n' "$i" 0
  done
  exit 0
fi
exec "${realGit}" "$@"
`
  );
  run('chmod', ['+x', fakeGit], root);
  const bashEnv = path.join(root, 'force-long-echo-sigpipe.sh');
  writeFileSync(
    bashEnv,
    'echo() {\n  if [ "$#" -eq 1 ] && [ "${#1}" -gt 100000 ]; then\n    return 141\n  fi\n  builtin echo "$@"\n}\n'
  );

  const result = runAllowFail(installedDriftCheck, [], root, {
    BASH_ENV: bashEnv,
    COBUILD_DRIFT_REQUIRED_FILES: 'package.json\n',
    COBUILD_DRIFT_LARGE_CHANGE_THRESHOLD: '999999',
    PATH: `${fakeBin}:${process.env.PATH}`,
  });

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stdout, /Architecture-sensitive code\/process changed without matching non-generated docs updates/);
  assert.doesNotMatch(result.stdout, /Large change set/);
  rmSync(root, { recursive: true, force: true });
});

test('committer blocks disallowed globs', () => {
  const root = makeRepo();
  mkdirSync(path.join(root, 'lib'), { recursive: true });
  writeFileSync(path.join(root, 'lib/test.txt'), 'x\n');
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'chore: seed'], root, { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' });
  writeFileSync(path.join(root, 'lib/test.txt'), 'y\n');
  const result = runAllowFail(path.join(repoRoot, 'bin/cobuild-committer'), ['fix(test): block lib', 'lib/test.txt'], root, {
    COBUILD_COMMITTER_DISALLOW_GLOBS: 'lib/*\n./lib/*\n',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /disallowed/);
  rmSync(root, { recursive: true, force: true });
});

test('committer keeps the positional message and exact-path interface', () => {
  const root = makeRepo();
  writeFileSync(path.join(root, 'README.md'), '# Interface\n');

  const result = runAllowFail(
    path.join(repoRoot, 'bin/cobuild-committer'),
    ['-m', 'fix(repo): unsupported message option', 'README.md'],
    root
  );

  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown option: -m/);
  assert.match(result.stderr, /"commit message" "file" \["file" \.\.\.\]/);
  rmSync(root, { recursive: true, force: true });
});

test('committer rejects an active non-fast-forward merge without changing merge state', () => {
  const root = makeRepo();
  configureGitUser(root);
  writeFileSync(path.join(root, 'baseline.txt'), 'baseline\n');
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'chore: seed'], root);

  run('git', ['checkout', '-b', 'feature'], root);
  writeFileSync(path.join(root, 'feature.txt'), 'feature\n');
  run('git', ['add', 'feature.txt'], root);
  run('git', ['commit', '-m', 'feat: add feature'], root);

  run('git', ['checkout', 'main'], root);
  writeFileSync(path.join(root, 'main.txt'), 'main\n');
  run('git', ['add', 'main.txt'], root);
  run('git', ['commit', '-m', 'feat: advance main'], root);
  run('git', ['merge', '--no-ff', '--no-commit', 'feature'], root);

  const headBefore = run('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const indexBefore = run('git', ['write-tree'], root).stdout.trim();
  const mergeHeadPath = gitPath(root, 'MERGE_HEAD');
  const mergeHeadBefore = readFileSync(mergeHeadPath, 'utf8');
  const lockDir = gitPath(root, 'agent-commit-locks');
  assert.equal(existsSync(lockDir), false);

  const result = runAllowFail(
    path.join(repoRoot, 'bin/cobuild-committer'),
    ['--skip-hooks', 'chore(repo): finish merge', 'feature.txt'],
    root
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /active Git operation is not supported \(MERGE_HEAD\)/);
  assert.equal(run('git', ['rev-parse', 'HEAD'], root).stdout.trim(), headBefore);
  assert.equal(run('git', ['write-tree'], root).stdout.trim(), indexBefore);
  assert.equal(readFileSync(mergeHeadPath, 'utf8'), mergeHeadBefore);
  assert.equal(existsSync(lockDir), false);
  rmSync(root, { recursive: true, force: true });
});

test('committer rejects hook-added paths outside the exact locked path list', () => {
  const root = makeGeneratedArtifactCommitRepo();

  const headBefore = run('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const indexBefore = run('git', ['write-tree'], root).stdout.trim();
  const result = runAllowFail(
    path.join(repoRoot, 'bin/cobuild-committer'),
    ['fix(repo): regenerate output', 'source.txt'],
    root
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /hook staged a path outside the selected exact file list: generated\.txt/);
  assert.match(result.stderr, /List every hook-generated path explicitly and retry/);
  assert.equal(run('git', ['rev-parse', 'HEAD'], root).stdout.trim(), headBefore);
  assert.equal(run('git', ['write-tree'], root).stdout.trim(), indexBefore);
  assert.equal(run('git', ['diff', '--cached', '--name-only'], root).stdout, 'unrelated.txt\n');
  rmSync(root, { recursive: true, force: true });
});

test('committer includes an explicitly named generated artifact without wiping unrelated staged work', () => {
  const root = makeGeneratedArtifactCommitRepo();

  run(
    path.join(repoRoot, 'bin/cobuild-committer'),
    ['fix(repo): regenerate output', 'source.txt', 'generated.txt'],
    root
  );

  assert.equal(run('git', ['show', 'HEAD:source.txt'], root).stdout, 'source v2\n');
  assert.equal(run('git', ['show', 'HEAD:generated.txt'], root).stdout, 'generated v2\n');
  assert.equal(run('git', ['diff', '--cached', '--name-only'], root).stdout, 'unrelated.txt\n');
  assert.equal(run('git', ['diff', '--name-only', '--', 'source.txt', 'generated.txt'], root).stdout, '');
  rmSync(root, { recursive: true, force: true });
});

test('committer rejects every supported in-progress operation marker before creating locks', async (t) => {
  for (const marker of ['CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer']) {
    await t.test(marker, () => {
      const root = makeCommittedFileRepo({ 'tracked.txt': 'v1\n' });
      writeFileSync(path.join(root, 'tracked.txt'), 'v2\n');
      const markerPath = gitPath(root, marker);
      if (marker.includes('_HEAD')) {
        writeFileSync(markerPath, `${run('git', ['rev-parse', 'HEAD'], root).stdout.trim()}\n`);
      } else {
        mkdirSync(markerPath, { recursive: true });
      }

      const headBefore = run('git', ['rev-parse', 'HEAD'], root).stdout.trim();
      const indexBefore = run('git', ['write-tree'], root).stdout.trim();
      const lockDir = gitPath(root, 'agent-commit-locks');
      const result = runAllowFail(
        path.join(repoRoot, 'bin/cobuild-committer'),
        ['--skip-hooks', 'fix(repo): reject operation', 'tracked.txt'],
        root
      );

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, new RegExp(`active Git operation is not supported \\(${marker}\\)`));
      assert.equal(run('git', ['rev-parse', 'HEAD'], root).stdout.trim(), headBefore);
      assert.equal(run('git', ['write-tree'], root).stdout.trim(), indexBefore);
      assert.equal(existsSync(markerPath), true);
      assert.equal(existsSync(lockDir), false);
      rmSync(root, { recursive: true, force: true });
    });
  }
});

test('committer rejects a real conflicted git am operation before creating locks', () => {
  const root = makeCommittedFileRepo({ 'conflict.txt': 'base\n' });
  run('git', ['checkout', '-b', 'patch-source'], root);
  writeFileSync(path.join(root, 'conflict.txt'), 'patch change\n');
  run('git', ['add', 'conflict.txt'], root);
  run('git', ['commit', '-m', 'fix: patch change'], root);
  const patchContents = run('git', ['format-patch', '-1', '--stdout'], root).stdout;

  run('git', ['checkout', 'main'], root);
  writeFileSync(path.join(root, 'conflict.txt'), 'main change\n');
  run('git', ['add', 'conflict.txt'], root);
  run('git', ['commit', '-m', 'fix: main change'], root);
  const patchPath = path.join(root, 'change.patch');
  writeFileSync(patchPath, patchContents);
  const amResult = runAllowFail('git', ['am', 'change.patch'], root);
  assert.notEqual(amResult.status, 0);
  assert.equal(existsSync(gitPath(root, 'rebase-apply')), true);

  const headBefore = run('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const lockDir = gitPath(root, 'agent-commit-locks');
  const result = runAllowFail(
    path.join(repoRoot, 'bin/cobuild-committer'),
    ['--skip-hooks', 'fix(repo): reject am', 'conflict.txt'],
    root
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /active Git operation is not supported \(rebase-apply\)/);
  assert.equal(run('git', ['rev-parse', 'HEAD'], root).stdout.trim(), headBefore);
  assert.equal(existsSync(gitPath(root, 'rebase-apply')), true);
  assert.equal(existsSync(lockDir), false);
  rmSync(root, { recursive: true, force: true });
});

test('committer rejects hooks that remove every initially selected change', () => {
  const root = makeCommittedFileRepo({ 'source.txt': 'v1\n' });
  writeFileSync(
    path.join(root, '.git/hooks/pre-commit'),
    '#!/usr/bin/env bash\nset -euo pipefail\ngit reset -q -- source.txt\n'
  );
  run('chmod', ['+x', path.join(root, '.git/hooks/pre-commit')], root);
  writeFileSync(path.join(root, 'source.txt'), 'v2\n');

  const headBefore = run('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const indexBefore = run('git', ['write-tree'], root).stdout.trim();
  const result = runAllowFail(
    path.join(repoRoot, 'bin/cobuild-committer'),
    ['fix(repo): keep selected change', 'source.txt'],
    root
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /hooks removed every selected change/);
  assert.equal(run('git', ['rev-parse', 'HEAD'], root).stdout.trim(), headBefore);
  assert.equal(run('git', ['write-tree'], root).stdout.trim(), indexBefore);
  rmSync(root, { recursive: true, force: true });
});

test('committer rejects hooks that remove one initially selected change', () => {
  const root = makeCommittedFileRepo({ 'first.txt': 'first v1\n', 'second.txt': 'second v1\n' });
  writeFileSync(
    path.join(root, '.git/hooks/pre-commit'),
    '#!/usr/bin/env bash\nset -euo pipefail\ngit reset -q -- first.txt\n'
  );
  run('chmod', ['+x', path.join(root, '.git/hooks/pre-commit')], root);
  writeFileSync(path.join(root, 'first.txt'), 'first v2\n');
  writeFileSync(path.join(root, 'second.txt'), 'second v2\n');

  const headBefore = run('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const indexBefore = run('git', ['write-tree'], root).stdout.trim();
  const result = runAllowFail(
    path.join(repoRoot, 'bin/cobuild-committer'),
    ['fix(repo): keep both changes', 'first.txt', 'second.txt'],
    root
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /hook removed an initially selected change: first\.txt/);
  assert.equal(run('git', ['rev-parse', 'HEAD'], root).stdout.trim(), headBefore);
  assert.equal(run('git', ['write-tree'], root).stdout.trim(), indexBefore);
  rmSync(root, { recursive: true, force: true });
});

test('committer reconciles only committed paths and preserves existing staged snapshots', () => {
  const root = makeCommittedFileRepo({
    'source.txt': 'source v1\n',
    'clean.txt': 'clean v1\n',
    'listed.txt': 'listed v1\n',
    'unrelated.txt': 'unrelated v1\n',
  });

  writeFileSync(path.join(root, 'source.txt'), 'source staged\n');
  run('git', ['add', 'source.txt'], root);
  const sourceIndexBefore = run('git', ['rev-parse', ':source.txt'], root).stdout.trim();
  writeFileSync(path.join(root, 'source.txt'), 'source committed\n');

  writeFileSync(path.join(root, 'listed.txt'), 'listed staged\n');
  run('git', ['add', 'listed.txt'], root);
  const listedIndexBefore = run('git', ['rev-parse', ':listed.txt'], root).stdout.trim();
  writeFileSync(path.join(root, 'listed.txt'), 'listed v1\n');

  writeFileSync(path.join(root, 'unrelated.txt'), 'unrelated staged\n');
  run('git', ['add', 'unrelated.txt'], root);
  const unrelatedIndexBefore = run('git', ['rev-parse', ':unrelated.txt'], root).stdout.trim();
  writeFileSync(path.join(root, 'clean.txt'), 'clean committed\n');

  run(
    path.join(repoRoot, 'bin/cobuild-committer'),
    ['--skip-hooks', 'fix(repo): preserve staged snapshots', 'source.txt', 'clean.txt', 'listed.txt'],
    root
  );

  assert.equal(run('git', ['show', 'HEAD:source.txt'], root).stdout, 'source committed\n');
  assert.equal(run('git', ['show', 'HEAD:clean.txt'], root).stdout, 'clean committed\n');
  assert.equal(run('git', ['show', 'HEAD:listed.txt'], root).stdout, 'listed v1\n');
  assert.equal(run('git', ['rev-parse', ':source.txt'], root).stdout.trim(), sourceIndexBefore);
  assert.equal(run('git', ['rev-parse', ':listed.txt'], root).stdout.trim(), listedIndexBefore);
  assert.equal(run('git', ['rev-parse', ':unrelated.txt'], root).stdout.trim(), unrelatedIndexBefore);
  assert.equal(run('git', ['diff', '--cached', '--name-only'], root).stdout, 'listed.txt\nsource.txt\nunrelated.txt\n');
  assert.equal(run('git', ['diff', '--name-only', '--', 'clean.txt'], root).stdout, '');
  rmSync(root, { recursive: true, force: true });
});

test('committer reserves index reconciliation before advancing the branch', () => {
  const root = makeCommittedFileRepo({ 'source.txt': 'v1\n' });
  writeFileSync(path.join(root, 'source.txt'), 'v2\n');
  const indexBefore = run('git', ['write-tree'], root).stdout.trim();
  const indexLock = gitPath(root, 'index.lock');
  writeFileSync(indexLock, 'external lock\n');
  const headBefore = run('git', ['rev-parse', 'HEAD'], root).stdout.trim();

  const result = runAllowFail(
    path.join(repoRoot, 'bin/cobuild-committer'),
    ['--skip-hooks', 'fix(repo): reserve index', 'source.txt'],
    root
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /repository index is locked; no commit was created/);
  assert.equal(run('git', ['rev-parse', 'HEAD'], root).stdout.trim(), headBefore);
  assert.equal(readFileSync(indexLock, 'utf8'), 'external lock\n');
  rmSync(indexLock);
  assert.equal(run('git', ['write-tree'], root).stdout.trim(), indexBefore);
  rmSync(root, { recursive: true, force: true });
});

test('committer reports success when EXIT cleanup recovers a transient index install failure', () => {
  const root = makeCommittedFileRepo({ 'source.txt': 'v1\n' });
  writeFileSync(path.join(root, 'source.txt'), 'v2\n');
  const headBefore = run('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const fakeBin = gitPath(root, 'committer-test-bin');
  mkdirSync(fakeBin, { recursive: true });
  const mvState = gitPath(root, 'committer-test-mv-failed-once');
  const realMv = run('sh', ['-c', 'command -v mv'], root).stdout.trim();
  const fakeMv = path.join(fakeBin, 'mv');
  writeFileSync(
    fakeMv,
    `#!/usr/bin/env bash
set -euo pipefail
if [ ! -e "\${COMMITTER_TEST_MV_STATE:?}" ]; then
  printf 'failed once\\n' > "\${COMMITTER_TEST_MV_STATE}"
  kill -TERM "$PPID"
  exit 1
fi
exec "${realMv}" "$@"
`
  );
  run('chmod', ['+x', fakeMv], root);

  const result = runAllowFail(
    path.join(repoRoot, 'bin/cobuild-committer'),
    ['--skip-hooks', 'fix(repo): recover index install', 'source.txt'],
    root,
    {
      COMMITTER_TEST_MV_STATE: mvState,
      PATH: `${fakeBin}:${process.env.PATH}`,
    }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(existsSync(mvState), true);
  assert.equal((result.stdout.match(/Committed /g) || []).length, 1);
  assert.doesNotMatch(result.stderr, /inspect the Git index lock|reconciliation could not be confirmed/);
  assert.doesNotMatch(result.stderr, /Interrupted by TERM/);
  assert.notEqual(run('git', ['rev-parse', 'HEAD'], root).stdout.trim(), headBefore);
  assert.equal(run('git', ['show', 'HEAD:source.txt'], root).stdout, 'v2\n');
  assert.equal(run('git', ['status', '--porcelain'], root).stdout, '');
  assert.equal(existsSync(gitPath(root, 'index.lock')), false);
  rmSync(root, { recursive: true, force: true });
});

test('committer reports committed state and a warning when cleanup cannot remove a temporary artifact', () => {
  const root = makeCommittedFileRepo({ 'source.txt': 'v1\n' });
  writeFileSync(path.join(root, 'source.txt'), 'v2\n');
  const headBefore = run('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const fakeBin = gitPath(root, 'committer-test-bin');
  mkdirSync(fakeBin, { recursive: true });
  const rmState = gitPath(root, 'committer-test-rm-failed-once');
  const realRm = run('sh', ['-c', 'command -v rm'], root).stdout.trim();
  const fakeRm = path.join(fakeBin, 'rm');
  writeFileSync(
    fakeRm,
    `#!/usr/bin/env bash
set -euo pipefail
if [ ! -e "\${COMMITTER_TEST_RM_STATE:?}" ]; then
  printf '%s\\n' "$@" > "\${COMMITTER_TEST_RM_STATE}"
  exit 1
fi
exec "${realRm}" "$@"
`
  );
  run('chmod', ['+x', fakeRm], root);

  const result = runAllowFail(
    path.join(repoRoot, 'bin/cobuild-committer'),
    ['--skip-hooks', 'fix(repo): report cleanup failure', 'source.txt'],
    root,
    {
      COMMITTER_TEST_RM_STATE: rmState,
      PATH: `${fakeBin}:${process.env.PATH}`,
    }
  );

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(readFileSync(rmState, 'utf8'), /committer-index\./);
  assert.equal((result.stdout.match(/Committed /g) || []).length, 1);
  assert.match(result.stderr, /Warning: committer cleanup did not complete; one or more temporary artifacts may remain/);
  assert.doesNotMatch(result.stderr, /inspect the Git index lock|reconciliation could not be confirmed/);
  assert.notEqual(run('git', ['rev-parse', 'HEAD'], root).stdout.trim(), headBefore);
  assert.equal(run('git', ['show', 'HEAD:source.txt'], root).stdout, 'v2\n');
  assert.equal(run('git', ['status', '--porcelain'], root).stdout, '');
  assert.equal(existsSync(gitPath(root, 'index.lock')), false);
  assert.equal(readdirSync(gitPath(root, 'agent-commit-locks')).length, 0);

  const failedRmArgs = readFileSync(rmState, 'utf8').trimEnd().split('\n');
  for (const failedRmArg of failedRmArgs) {
    if (failedRmArg !== '-f') {
      rmSync(failedRmArg, { force: true });
    }
  }
  rmSync(root, { recursive: true, force: true });
});

test('committer resolves a renamed source from a subdirectory', () => {
  const root = makeCommittedFileRepo({ 'nested/source.txt': 'source\n' });
  const nested = path.join(root, 'nested');
  run('git', ['mv', 'source.txt', 'renamed.txt'], nested);

  run(
    path.join(repoRoot, 'bin/cobuild-committer'),
    ['--skip-hooks', 'fix(repo): rename nested source', 'source.txt', 'renamed.txt'],
    nested
  );

  assert.equal(run('git', ['show', 'HEAD:nested/renamed.txt'], root).stdout, 'source\n');
  assert.notEqual(runAllowFail('git', ['cat-file', '-e', 'HEAD:nested/source.txt'], root).status, 0);
  assert.equal(run('git', ['status', '--porcelain'], root).stdout, '');
  rmSync(root, { recursive: true, force: true });
});

test('committer applies disallowed-path policy to canonical subdirectory paths', () => {
  const root = makeCommittedFileRepo({ 'nested/blocked.txt': 'v1\n' });
  const nested = path.join(root, 'nested');
  writeFileSync(path.join(nested, 'blocked.txt'), 'v2\n');

  const result = runAllowFail(
    path.join(repoRoot, 'bin/cobuild-committer'),
    ['--skip-hooks', 'fix(repo): reject alias', './blocked.txt'],
    nested,
    { COBUILD_COMMITTER_DISALLOW_GLOBS: 'nested/*\n' }
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /disallowed.*nested\/blocked\.txt/);
  rmSync(root, { recursive: true, force: true });
});

test('committer aliases contend on the same canonical file lock', () => {
  const root = makeCommittedFileRepo({ 'nested/locked.txt': 'v1\n' });
  const nested = path.join(root, 'nested');
  writeFileSync(path.join(nested, 'locked.txt'), 'v2\n');
  const lockDir = gitPath(root, 'agent-commit-locks');
  mkdirSync(lockDir, { recursive: true });
  const lockKey = createHash('sha256').update('nested/locked.txt').digest('hex');
  writeFileSync(path.join(lockDir, `${lockKey}.lock`), 'another commit session\n');

  const result = runAllowFail(
    path.join(repoRoot, 'bin/cobuild-committer'),
    ['--skip-hooks', 'fix(repo): contend on canonical lock', './locked.txt'],
    nested
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /file appears locked by another commit session: nested\/locked\.txt/);
  rmSync(root, { recursive: true, force: true });
});

test('committer loses an unborn-branch race instead of overwriting the concurrent root', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'repo-tools-unborn-race-'));
  run('git', ['init', '-b', 'main'], root);
  configureGitUser(root);
  writeFileSync(path.join(root, 'README.md'), '# Candidate root\n');
  const raceMarker = gitPath(root, 'committer-race-oid');
  const hookPath = path.join(root, '.git/hooks/pre-commit');
  writeFileSync(
    hookPath,
    `#!/usr/bin/env bash
set -euo pipefail
empty_tree="$(git mktree </dev/null)"
concurrent_commit="$(printf 'concurrent root\\n' | git commit-tree "$empty_tree")"
git update-ref refs/heads/main "$concurrent_commit"
printf '%s\\n' "$concurrent_commit" > "${raceMarker}"
`
  );
  run('chmod', ['+x', hookPath], root);

  const result = runAllowFail(
    path.join(repoRoot, 'bin/cobuild-committer'),
    ['feat(repo): candidate root', 'README.md'],
    root
  );

  assert.notEqual(result.status, 0);
  const concurrentCommit = readFileSync(raceMarker, 'utf8').trim();
  assert.equal(run('git', ['rev-parse', 'HEAD'], root).stdout.trim(), concurrentCommit);
  assert.equal(run('git', ['log', '-1', '--format=%s'], root).stdout, 'concurrent root\n');
  assert.notEqual(runAllowFail('git', ['cat-file', '-e', 'HEAD:README.md'], root).status, 0);
  assert.equal(existsSync(gitPath(root, 'index.lock')), false);
  rmSync(root, { recursive: true, force: true });
});

test('committer creates an initial commit in a SHA-256 repository', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'repo-tools-sha256-'));
  const init = runAllowFail('git', ['init', '--object-format=sha256', '-b', 'main'], root);
  if (init.status !== 0) {
    rmSync(root, { recursive: true, force: true });
    t.skip('installed Git does not support SHA-256 repositories');
    return;
  }
  configureGitUser(root);
  writeFileSync(path.join(root, 'README.md'), '# SHA-256\n');

  run(
    path.join(repoRoot, 'bin/cobuild-committer'),
    ['--skip-hooks', 'feat(repo): seed sha256 repository', 'README.md'],
    root
  );

  assert.equal(run('git', ['rev-parse', '--show-object-format'], root).stdout.trim(), 'sha256');
  assert.equal(run('git', ['rev-parse', 'HEAD'], root).stdout.trim().length, 64);
  assert.equal(run('git', ['show', 'HEAD:README.md'], root).stdout, '# SHA-256\n');
  rmSync(root, { recursive: true, force: true });
});

test('committer supports an initial commit on an unborn branch', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'repo-tools-init-commit-'));
  writeFileSync(path.join(root, 'README.md'), '# Init\n');
  run('git', ['init', '-b', 'main'], root);
  configureGitUser(root);

  run(path.join(repoRoot, 'bin/cobuild-committer'), ['--skip-hooks', 'feat(repo): seed package', 'README.md'], root);

  const log = run('git', ['log', '--oneline', '-1'], root);
  assert.match(log.stdout, /feat\(repo\): seed package/);
  rmSync(root, { recursive: true, force: true });
});

test('committer accepts release commits by default', () => {
  const root = makeRepo();
  writeFileSync(path.join(root, 'README.md'), '# Release\n');
  run('git', ['config', 'user.email', 't@example.com'], root);
  run('git', ['config', 'user.name', 'T'], root);

  run(path.join(repoRoot, 'bin/cobuild-committer'), ['--skip-hooks', 'release: v0.0.1', 'README.md'], root);

  const log = run('git', ['log', '--oneline', '-1'], root);
  assert.match(log.stdout, /release: v0\.0\.1/);
  rmSync(root, { recursive: true, force: true });
});

test('committer supports configured allowed commit types', () => {
  const root = makeRepo();
  writeFileSync(path.join(root, 'README.md'), '# Custom\n');
  run('git', ['config', 'user.email', 't@example.com'], root);
  run('git', ['config', 'user.name', 'T'], root);

  run(path.join(repoRoot, 'bin/cobuild-committer'), ['--skip-hooks', 'ship: v0.0.1', 'README.md'], root, {
    COBUILD_COMMITTER_ALLOWED_TYPES: 'ship,fix',
  });

  const log = run('git', ['log', '--oneline', '-1'], root);
  assert.match(log.stdout, /ship: v0\.0\.1/);
  rmSync(root, { recursive: true, force: true });
});

test('switch package source updates dependency fields without install', () => {
  const root = makeRepo();
  const pkgPath = path.join(root, 'package.json');

  run(path.join(repoRoot, 'bin/cobuild-switch-package-source'), [
    '--package', '@cobuild/wire',
    '--field', 'dependencies',
    '--local', '../wire',
    '--no-install',
  ], root);
  let pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  assert.equal(pkg.dependencies['@cobuild/wire'], 'link:../wire');

  run(path.join(repoRoot, 'bin/cobuild-switch-package-source'), [
    '--package', '@cobuild/repo-tools',
    '--field', 'devDependencies',
    '--published', '^0.1.4',
    '--no-install',
  ], root);
  pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  assert.equal(pkg.devDependencies['@cobuild/repo-tools'], '^0.1.4');
  rmSync(root, { recursive: true, force: true });
});

test('switch package source works without pnpm when install is disabled', () => {
  const root = makeRepo();
  const pkgPath = path.join(root, 'package.json');

  run(path.join(repoRoot, 'bin/cobuild-switch-package-source'), [
    '--package', '@cobuild/wire',
    '--field', 'dependencies',
    '--local', '../wire',
    '--no-install',
  ], root, {
    PATH: `${nodeBinDir}:/usr/bin:/bin`,
  });

  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  assert.equal(pkg.dependencies['@cobuild/wire'], 'link:../wire');
  rmSync(root, { recursive: true, force: true });
});

test('sync dependent repos updates discovered dependent repos only', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'repo-tools-sync-test-'));

  const fakeBin = path.join(root, 'bin');
  mkdirSync(fakeBin, { recursive: true });
  const pnpmLog = path.join(root, 'pnpm.log');
  const fakePnpm = path.join(fakeBin, 'pnpm');
  writeFileSync(
    fakePnpm,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$PWD :: $*" >> "${pnpmLog}"
exit 0
`
  );
  run('chmod', ['+x', fakePnpm], root);

  const depRepo = path.join(root, 'cli');
  mkdirSync(depRepo, { recursive: true });
  writeFileSync(
    path.join(depRepo, 'package.json'),
    JSON.stringify(
      {
        name: 'tmp-cli',
        devDependencies: {
          '@cobuild/repo-tools': '^0.1.8',
        },
      },
      null,
      2
    )
  );

  const skippedRepo = path.join(root, 'docs');
  mkdirSync(skippedRepo, { recursive: true });
  writeFileSync(path.join(skippedRepo, 'package.json'), JSON.stringify({ name: 'tmp-docs' }, null, 2));

  const result = runAllowFail(path.join(repoRoot, 'bin/cobuild-sync-dependent-repos'), [
    '--package', '@cobuild/repo-tools',
    '--version', '0.2.0',
    '--root', root,
  ], repoRoot, {
    PATH: `${fakeBin}:${process.env.PATH}`,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Repo set: cli/);
  assert.match(
    readFileSync(pnpmLog, 'utf8'),
    new RegExp(`${depRepo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} :: up @cobuild/repo-tools@0\\.2\\.0`)
  );
  rmSync(root, { recursive: true, force: true });
});

test('sync dependent repos supports explicit nested repo paths in dry-run mode', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'repo-tools-sync-nested-test-'));

  const nestedRepo = path.join(root, 'interface', 'apps', 'web');
  mkdirSync(nestedRepo, { recursive: true });
  writeFileSync(
    path.join(nestedRepo, 'package.json'),
    JSON.stringify(
      {
        name: 'tmp-web',
        dependencies: {
          '@cobuild/wire': '^0.1.5',
        },
      },
      null,
      2
    )
  );

  const result = runAllowFail(path.join(repoRoot, 'bin/cobuild-sync-dependent-repos'), [
    '--package', '@cobuild/wire',
    '--version', '0.2.0',
    '--root', root,
    '--repos', 'interface/apps/web',
    '--dry-run',
  ], repoRoot);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Repo set: interface\/apps\/web/);
  assert.match(
    result.stdout,
    new RegExp(`Would update interface/apps/web: \\(cd ${nestedRepo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} && pnpm up @cobuild/wire@0\\.2\\.0\\)`)
  );
  rmSync(root, { recursive: true, force: true });
});

test('package audit context builds configured text bundles and excludes sensitive paths', () => {
  const root = makeRepo();
  mkdirSync(path.join(root, 'src'), { recursive: true });
  mkdirSync(path.join(root, 'scripts'), { recursive: true });
  mkdirSync(path.join(root, 'agent-docs'), { recursive: true });
  mkdirSync(path.join(root, 'tests'), { recursive: true });
  mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true });
  writeFileSync(path.join(root, 'AGENTS.md'), '# agents\n');
  writeFileSync(path.join(root, 'ARCHITECTURE.md'), '# arch\n');
  writeFileSync(path.join(root, 'src', 'index.ts'), 'export const value = 1;\n');
  writeFileSync(path.join(root, 'scripts', 'helper.sh'), '#!/usr/bin/env bash\n');
  writeFileSync(path.join(root, 'agent-docs', 'index.md'), '# docs\n');
  writeFileSync(path.join(root, 'tests', 'sample.test.ts'), 'test(\"ok\", () => {});\n');
  writeFileSync(path.join(root, '.github', 'workflows', 'test.yml'), 'name: test\n');
  writeFileSync(path.join(root, '.env'), 'SECRET=1\n');

  run(path.join(repoRoot, 'bin/cobuild-package-audit-context'), ['--txt', '--no-ci'], root, {
    COBUILD_AUDIT_CONTEXT_PREFIX: 'fixture-audit',
    COBUILD_AUDIT_CONTEXT_TITLE: 'Fixture Audit Bundle',
    COBUILD_AUDIT_CONTEXT_REPO_LABEL: 'fixture',
    COBUILD_AUDIT_CONTEXT_ALWAYS_PATHS: 'AGENTS.md\nARCHITECTURE.md\npackage.json\n',
    COBUILD_AUDIT_CONTEXT_SCAN_SPECS: 'src\nscripts\n',
    COBUILD_AUDIT_CONTEXT_TEST_SCAN_SPECS: 'tests\n',
    COBUILD_AUDIT_CONTEXT_DOC_SCAN_SPECS: 'agent-docs:*.md\n',
    COBUILD_AUDIT_CONTEXT_EXCLUDE_SENSITIVE: '1',
  });

  const auditDir = path.join(root, 'audit-packages');
  const outputName = readdirSync(auditDir).find((name) => name.startsWith('fixture-audit-') && name.endsWith('.txt'));
  assert.ok(outputName, 'expected audit text bundle');
  const bundle = readFileSync(path.join(auditDir, outputName), 'utf8');
  assert.match(bundle, /Fixture Audit Bundle/);
  assert.match(bundle, /===== FILE: src\/index\.ts =====/);
  assert.match(bundle, /===== FILE: tests\/sample\.test\.ts =====/);
  assert.doesNotMatch(bundle, /===== FILE: \.env =====/);
  assert.doesNotMatch(bundle, /===== FILE: \.github\/workflows\/test\.yml =====/);
  rmSync(root, { recursive: true, force: true });
});

test('package audit context cleans clustered generated TypeScript sidecars but keeps hand-authored JS files', () => {
  const root = makeRepo();
  mkdirSync(path.join(root, 'src'), { recursive: true });
  mkdirSync(path.join(root, 'scripts'), { recursive: true });
  writeFileSync(path.join(root, 'AGENTS.md'), '# agents\n');
  writeFileSync(path.join(root, 'ARCHITECTURE.md'), '# arch\n');
  writeFileSync(path.join(root, 'src', 'index.ts'), 'export const value = 1;\n');
  writeFileSync(path.join(root, 'src', 'index.js'), 'export const value = 1;\n');
  writeFileSync(path.join(root, 'src', 'index.d.ts'), 'export declare const value = 1;\n');
  writeFileSync(path.join(root, 'src', 'manual.ts'), 'export const manualTs = true;\n');
  writeFileSync(path.join(root, 'src', 'manual.js'), 'export const manualJs = true;\n');
  writeFileSync(path.join(root, 'src', 'hand-authored.js'), 'export const handAuthored = true;\n');
  writeFileSync(path.join(root, 'scripts', 'postcss.config.mjs'), 'export default {};\n');

  run(path.join(repoRoot, 'bin/cobuild-package-audit-context'), ['--txt', '--no-tests', '--no-docs', '--no-ci'], root, {
    COBUILD_AUDIT_CONTEXT_PREFIX: 'fixture-audit',
    COBUILD_AUDIT_CONTEXT_ALWAYS_PATHS: 'AGENTS.md\nARCHITECTURE.md\npackage.json\n',
    COBUILD_AUDIT_CONTEXT_SCAN_SPECS: 'src\nscripts\n',
    COBUILD_AUDIT_CONTEXT_INCLUDE_TESTS_DEFAULT: '0',
    COBUILD_AUDIT_CONTEXT_INCLUDE_DOCS_DEFAULT: '0',
    COBUILD_AUDIT_CONTEXT_INCLUDE_CI_DEFAULT: '0',
  });

  assert.equal(existsSync(path.join(root, 'src', 'index.js')), false);
  assert.equal(existsSync(path.join(root, 'src', 'index.d.ts')), false);
  assert.equal(existsSync(path.join(root, 'src', 'manual.js')), true);
  assert.equal(existsSync(path.join(root, 'src', 'hand-authored.js')), true);
  assert.equal(existsSync(path.join(root, 'scripts', 'postcss.config.mjs')), true);

  const auditDir = path.join(root, 'audit-packages');
  const outputName = readdirSync(auditDir).find((name) => name.startsWith('fixture-audit-') && name.endsWith('.txt'));
  assert.ok(outputName, 'expected audit text bundle');
  const bundle = readFileSync(path.join(auditDir, outputName), 'utf8');
  assert.match(bundle, /===== FILE: src\/manual\.js =====/);
  assert.match(bundle, /===== FILE: src\/hand-authored\.js =====/);
  assert.match(bundle, /===== FILE: scripts\/postcss\.config\.mjs =====/);
  assert.doesNotMatch(bundle, /===== FILE: src\/index\.js =====/);
  assert.doesNotMatch(bundle, /===== FILE: src\/index\.d\.ts =====/);
  rmSync(root, { recursive: true, force: true });
});

test('package audit context filters blocked local residue but keeps env examples', () => {
  const root = makeRepo();
  mkdirSync(path.join(root, 'apps', 'web', '.next', 'types'), { recursive: true });
  mkdirSync(path.join(root, 'packages', 'core', 'dist'), { recursive: true });
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'AGENTS.md'), '# agents\n');
  writeFileSync(path.join(root, 'ARCHITECTURE.md'), '# arch\n');
  writeFileSync(path.join(root, 'apps', 'web', '.env'), 'SECRET=1\n');
  writeFileSync(path.join(root, 'apps', 'web', '.env.example'), 'SECRET=\n');
  writeFileSync(path.join(root, 'apps', 'web', '.next', 'types', 'routes.d.ts'), 'export {};\n');
  writeFileSync(path.join(root, 'packages', 'core', 'dist', 'index.js'), 'export {};\n');
  writeFileSync(path.join(root, 'packages', 'core', 'tsconfig.tsbuildinfo'), '{}\n');
  writeFileSync(path.join(root, 'src', 'index.ts'), 'export const value = 1;\n');

  run(path.join(repoRoot, 'bin/cobuild-package-audit-context'), ['--txt', '--no-tests', '--no-docs', '--no-ci'], root, {
    COBUILD_AUDIT_CONTEXT_PREFIX: 'fixture-audit',
    COBUILD_AUDIT_CONTEXT_ALWAYS_PATHS: 'AGENTS.md\nARCHITECTURE.md\npackage.json\n',
    COBUILD_AUDIT_CONTEXT_SCAN_SPECS: 'src\napps\npackages\n',
    COBUILD_AUDIT_CONTEXT_INCLUDE_TESTS_DEFAULT: '0',
    COBUILD_AUDIT_CONTEXT_INCLUDE_DOCS_DEFAULT: '0',
    COBUILD_AUDIT_CONTEXT_INCLUDE_CI_DEFAULT: '0',
  });

  const auditDir = path.join(root, 'audit-packages');
  const outputName = readdirSync(auditDir).find((name) => name.startsWith('fixture-audit-') && name.endsWith('.txt'));
  assert.ok(outputName, 'expected audit text bundle');
  const bundle = readFileSync(path.join(auditDir, outputName), 'utf8');
  assert.match(bundle, /===== FILE: apps\/web\/\.env\.example =====/);
  assert.match(bundle, /===== FILE: src\/index\.ts =====/);
  assert.doesNotMatch(bundle, /===== FILE: apps\/web\/\.env =====/);
  assert.doesNotMatch(bundle, /===== FILE: apps\/web\/\.next\/types\/routes\.d\.ts =====/);
  assert.doesNotMatch(bundle, /===== FILE: packages\/core\/dist\/index\.js =====/);
  assert.doesNotMatch(bundle, /===== FILE: packages\/core\/tsconfig\.tsbuildinfo =====/);
  rmSync(root, { recursive: true, force: true });
});

test('package audit context exits cleanly in zip-only mode', () => {
  const root = makeRepo();
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'AGENTS.md'), '# agents\n');
  writeFileSync(path.join(root, 'ARCHITECTURE.md'), '# arch\n');
  writeFileSync(path.join(root, 'src', 'index.ts'), 'export const value = 1;\n');
  writeFileSync(path.join(root, '.env'), 'SECRET=1\n');

  const result = runAllowFail(path.join(repoRoot, 'bin/cobuild-package-audit-context'), ['--zip', '--no-tests', '--no-docs', '--no-ci'], root, {
    COBUILD_AUDIT_CONTEXT_PREFIX: 'fixture-audit',
    COBUILD_AUDIT_CONTEXT_ALWAYS_PATHS: 'AGENTS.md\nARCHITECTURE.md\npackage.json\n',
    COBUILD_AUDIT_CONTEXT_SCAN_SPECS: 'src\n',
    COBUILD_AUDIT_CONTEXT_INCLUDE_TESTS_DEFAULT: '0',
    COBUILD_AUDIT_CONTEXT_INCLUDE_DOCS_DEFAULT: '0',
    COBUILD_AUDIT_CONTEXT_INCLUDE_CI_DEFAULT: '0',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Included files: 4/);
  const zipLine = result.stdout.split('\n').find((line) => line.startsWith('ZIP: '));
  assert.ok(zipLine, `expected ZIP line in stdout:\n${result.stdout}`);
  const zipPath = zipLine.replace(/^ZIP: /, '').replace(/ \(.+\)$/, '');
  assert.ok(existsSync(zipPath), `expected audit ZIP at ${zipPath}`);
  rmSync(root, { recursive: true, force: true });
});

test('package audit context validates configured Solidity import closure', () => {
  const root = makeRepo();
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'AGENTS.md'), '# agents\n');
  writeFileSync(path.join(root, 'ARCHITECTURE.md'), '# arch\n');
  writeFileSync(path.join(root, 'src', 'Main.sol'), 'pragma solidity ^0.8.0; import \"./Lib.sol\"; contract Main is Lib {}\\n');
  writeFileSync(path.join(root, 'src', 'Lib.sol'), 'pragma solidity ^0.8.0; contract Lib {}\\n');

  run(path.join(repoRoot, 'bin/cobuild-package-audit-context'), ['--txt', '--no-tests', '--no-docs', '--no-ci'], root, {
    COBUILD_AUDIT_CONTEXT_PREFIX: 'sol-audit',
    COBUILD_AUDIT_CONTEXT_TITLE: 'Solidity Audit Bundle',
    COBUILD_AUDIT_CONTEXT_ALWAYS_PATHS: 'AGENTS.md\nARCHITECTURE.md\npackage.json\n',
    COBUILD_AUDIT_CONTEXT_SCAN_SPECS: 'src:*.sol\n',
    COBUILD_AUDIT_CONTEXT_INCLUDE_TESTS_DEFAULT: '0',
    COBUILD_AUDIT_CONTEXT_INCLUDE_DOCS_DEFAULT: '0',
    COBUILD_AUDIT_CONTEXT_INCLUDE_CI_DEFAULT: '0',
    COBUILD_AUDIT_CONTEXT_VALIDATE_SOLIDITY_IMPORT_CLOSURE: '1',
  });

  rmSync(root, { recursive: true, force: true });
});

test('update changelog groups release entries by commit type', () => {
  const root = makeRepo();
  const updateChangelogBin = linkInstalledBin(root, 'cobuild-update-changelog');
  writeFileSync(path.join(root, 'CHANGELOG.md'), '# Changelog\n\nAll notable changes to this project will be documented in this file.\n');
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'chore: seed'], root, { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' });
  run('git', ['remote', 'add', 'origin', 'git@github.com:example/fixture.git'], root);
  run('git', ['tag', '-a', 'v0.0.0', '-m', 'v0.0.0'], root, { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' });

  writeFileSync(path.join(root, 'feature.txt'), 'feature\n');
  run('git', ['add', 'feature.txt'], root);
  run('git', ['commit', '-m', 'feat(repo): add feature'], root, { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' });
  writeFileSync(path.join(root, 'fix.txt'), 'fix\n');
  run('git', ['add', 'fix.txt'], root);
  run('git', ['commit', '-m', 'fix(repo): patch issue'], root, { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' });

  run(updateChangelogBin, ['0.0.1'], root);

  const changelog = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  assert.match(changelog, /## \[0.0.1\] - \d{4}-\d{2}-\d{2}/);
  assert.match(changelog, /### Added\n- add feature/);
  assert.match(changelog, /### Fixed\n- patch issue/);
  rmSync(root, { recursive: true, force: true });
});

test('release package dry run restores files after generating notes', () => {
  const root = makeRepo();
  const releasePackageBin = linkInstalledBin(root, 'cobuild-release-package');
  const fakePnpmBin = createFakePnpm(root);
  writeFileSync(path.join(root, 'CHANGELOG.md'), '# Changelog\n\nAll notable changes to this project will be documented in this file.\n');
  writeFileSync(path.join(root, 'README.md'), '# Fixture\n');
  writeFileSync(path.join(root, 'scripts-committer.sh'), `#!/usr/bin/env bash\nset -euo pipefail\nexec "${path.join(repoRoot, 'bin/cobuild-committer')}" "$@"\n`);
  run('chmod', ['+x', 'scripts-committer.sh'], root);

  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  pkg.repository = { type: 'git', url: 'https://github.com/example/fixture' };
  pkg.scripts = { 'release:check': 'node -e "process.exit(0)"' };
  writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');

  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'chore: seed'], root, { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' });
  run('git', ['remote', 'add', 'origin', 'git@github.com:example/fixture.git'], root);
  run('git', ['tag', '-a', 'v0.0.0', '-m', 'v0.0.0'], root, { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' });

  writeFileSync(path.join(root, 'README.md'), '# Fixture updated\n');
  run('git', ['add', 'README.md'], root);
  run('git', ['commit', '-m', 'feat(repo): add release flow'], root, { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' });

  const result = runAllowFail(releasePackageBin, ['patch', '--dry-run'], root, {
    COBUILD_RELEASE_PACKAGE_NAME: 'fixture',
    COBUILD_RELEASE_REPOSITORY_URL: 'https://github.com/example/fixture',
    COBUILD_RELEASE_COMMIT_CMD: './scripts-committer.sh',
    COBUILD_RELEASE_NOTES_ENABLED: '1',
    PATH: `${fakePnpmBin}:${process.env.PATH}`,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Would prepare release: fixture@0.0.1/);
  assert.equal(JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version, '0.0.0');
  assert.equal(readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), '# Changelog\n\nAll notable changes to this project will be documented in this file.\n');
  assert.equal(existsSync(path.join(root, 'package-lock.json')), false);
  assert.equal(existsSync(path.join(root, 'release-notes', 'v0.0.1.md')), false);
  rmSync(root, { recursive: true, force: true });
});

test('release package clears pnpm-only store-dir env before nested npm commands', () => {
  const root = makeRepo();
  const fakePnpmBin = createFakePnpm(root);
  writeFileSync(path.join(root, 'CHANGELOG.md'), '# Changelog\n\nAll notable changes to this project will be documented in this file.\n');
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  pkg.repository = { type: 'git', url: 'https://github.com/example/fixture' };
  pkg.scripts = {
    'release:check': 'node -e "const bad = process.env.npm_config_store_dir || process.env.NPM_CONFIG_STORE_DIR; if (bad) { console.error(bad); process.exit(1); }"',
  };
  writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'chore: seed'], root, { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' });
  run('git', ['remote', 'add', 'origin', 'git@github.com:example/fixture.git'], root);

  const result = runAllowFail(path.join(repoRoot, 'bin/cobuild-release-package'), ['patch', '--dry-run'], root, {
    COBUILD_RELEASE_PACKAGE_NAME: 'fixture',
    COBUILD_RELEASE_REPOSITORY_URL: 'https://github.com/example/fixture',
    npm_config_store_dir: '/tmp/pnpm-store',
    NPM_CONFIG_STORE_DIR: '/tmp/pnpm-store',
    PATH: `${fakePnpmBin}:${process.env.PATH}`,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Would prepare release: fixture@0\.0\.1/);
  rmSync(root, { recursive: true, force: true });
});

test('release package prefers pnpm release checks for pnpm repos by default', () => {
  const root = makeRepo();
  const fakePnpmBin = createFakePnpm(root);
  writeFileSync(path.join(root, 'CHANGELOG.md'), '# Changelog\n\nAll notable changes to this project will be documented in this file.\n');
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  pkg.repository = { type: 'git', url: 'https://github.com/example/fixture' };
  pkg.scripts = {
    'release:check': 'node -e "console.log(\'pnpm-release-check\')"',
  };
  writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'chore: seed'], root, { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' });
  run('git', ['remote', 'add', 'origin', 'git@github.com:example/fixture.git'], root);

  const result = runAllowFail(path.join(repoRoot, 'bin/cobuild-release-package'), ['check'], root, {
    COBUILD_RELEASE_PACKAGE_NAME: 'fixture',
    COBUILD_RELEASE_REPOSITORY_URL: 'https://github.com/example/fixture',
    PATH: `${fakePnpmBin}:${process.env.PATH}`,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /pnpm-release-check/);
  assert.match(result.stdout, /Release checks passed\./);
  rmSync(root, { recursive: true, force: true });
});
