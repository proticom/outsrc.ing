import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
for (const [args, extra] of [
  [['run', 'build'], {}],
  [['run', 'typecheck'], {}],
  [['test'], {}],
  [['exec', '--', 'vitest', 'run', 'tests/workflow.test.ts', 'tests/usage-workflow.test.ts'], { OUTSRC_TEST_SERVER: 'dist/server.js' }],
]) {
  const result = spawnSync('npm', args, { cwd: root, env: { ...process.env, ...extra }, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
