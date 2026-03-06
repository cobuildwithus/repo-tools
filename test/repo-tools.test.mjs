import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

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
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.0' }, null, 2) + '\n');
  return root;
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

test('committer supports an initial commit on an unborn branch', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'repo-tools-init-commit-'));
  writeFileSync(path.join(root, 'README.md'), '# Init\n');
  run('git', ['init', '-b', 'main'], root);

  run(path.join(repoRoot, 'bin/cobuild-committer'), ['feat(repo): seed package', 'README.md'], root);

  const log = run('git', ['log', '--oneline', '-1'], root);
  assert.match(log.stdout, /feat\(repo\): seed package/);
  rmSync(root, { recursive: true, force: true });
});

test('update changelog groups release entries by commit type', () => {
  const root = makeRepo();
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

  run(path.join(repoRoot, 'bin/cobuild-update-changelog'), ['0.0.1'], root);

  const changelog = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  assert.match(changelog, /## \[0.0.1\] - \d{4}-\d{2}-\d{2}/);
  assert.match(changelog, /### Added\n- add feature/);
  assert.match(changelog, /### Fixed\n- patch issue/);
  rmSync(root, { recursive: true, force: true });
});

test('release package dry run restores files after generating notes', () => {
  const root = makeRepo();
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

  const result = runAllowFail(path.join(repoRoot, 'bin/cobuild-release-package'), ['patch', '--dry-run'], root, {
    COBUILD_RELEASE_PACKAGE_NAME: 'fixture',
    COBUILD_RELEASE_REPOSITORY_URL: 'https://github.com/example/fixture',
    COBUILD_RELEASE_COMMIT_CMD: './scripts-committer.sh',
    COBUILD_RELEASE_NOTES_ENABLED: '1',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Would prepare release: fixture@0.0.1/);
  assert.equal(JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version, '0.0.0');
  assert.equal(readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), '# Changelog\n\nAll notable changes to this project will be documented in this file.\n');
  assert.equal(existsSync(path.join(root, 'release-notes', 'v0.0.1.md')), false);
  rmSync(root, { recursive: true, force: true });
});
