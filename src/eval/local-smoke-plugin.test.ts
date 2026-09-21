import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import plugin from '../plugins/local-smoke/index.js';
import { parseTaskDataset } from './tasks.js';

const task = parseTaskDataset(await readFile('examples/local-smoke-task.jsonl', 'utf8'))[0]!;

test('local smoke plugin completes an isolated scripted fix', async () => {
  assert.ok(plugin.tools && plugin.evaluator && plugin.agent && plugin.snapshots && plugin.validator && plugin.taskSource);
  assert.equal((await plugin.taskSource.mine('examples/local-smoke-task.jsonl', { limit: 1 }))[0]!.id, task.id);
  const validation = await plugin.validator.validate(task);
  assert.equal(validation.before.passed, false);
  assert.equal(validation.after.passed, true);
  const workspace = await plugin.workspaces.acquire(task);
  let passingSnapshot = '';
  try {
    const tools = await plugin.tools.create({
      workspace,
      task: { id: task.id, type: task.type, task: task.task },
    });
    assert.equal((await tools.runTests()).ok, false);
    assert.equal((await tools.readFile('../outside')).ok, false);

    const controller = await plugin.agent.create({
      task: { id: task.id, type: task.type, task: task.task },
      runId: 'smoke', configId: 'smoke', config: {
        scriptedDecisions: [{ tool: { name: 'write_file', path: 'math.js', content: 'export function add(a, b) { return a + b; }\n' } }],
      },
      logger: {} as never, ledger: {} as never, runCapUsd: 1, currentStep: () => 0,
    });
    const decision = await controller.reasoner.decide({
      task: task.task, selectedContext: [], additionalContext: [], unselectedManifest: [], observations: [],
      tests: { lastRun: 'never', dirtySinceLastRun: false },
    });
    assert.equal(decision.tool?.name, 'write_file');
    if (decision.tool?.name !== 'write_file') throw new Error('Expected scripted write');
    assert.equal((await tools.writeFile(decision.tool.path, decision.tool.content)).ok, true);
    assert.equal((await tools.runTests()).ok, true);
    assert.equal((await plugin.evaluator.evaluate({ task, workspace })).passed, true);
    passingSnapshot = (await tools.snapshot()).id;
  } finally {
    await workspace.release();
  }

  assert.match(await readFile('examples/local-smoke-workspace/math.js', 'utf8'), /a - b/);
  assert.equal((await plugin.snapshots.evaluate({ task, runId: 'smoke', snapshotId: passingSnapshot })).passed, true);

  const timeoutTask = {
    ...task,
    source: { kind: 'local-smoke', data: {
      ...task.source.data,
      visibleTest: { command: process.execPath, args: ['-e', 'setTimeout(() => {}, 60000)'], timeoutMs: 20 },
    } },
  };
  const timeoutWorkspace = await plugin.workspaces.acquire(timeoutTask);
  try {
    const tools = await plugin.tools.create({ workspace: timeoutWorkspace, task: { id: task.id, type: task.type, task: task.task } });
    const result = await tools.runTests();
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 124);
  } finally {
    await timeoutWorkspace.release();
  }
});
