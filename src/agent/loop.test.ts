import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentLoop } from './loop.js';
import { ConsumedReasoningError } from './reasoning-adapter.js';
import type { CodingReasoner } from './types.js';
import { BudgetExceededError } from '../core/ledger.js';
import { RunLogger, type EventSink } from '../core/logger.js';
import { Session } from '../core/session.js';
import type { RunEvent } from '../core/events.js';
import type { Router } from '../core/types.js';

function fixture(
  actions: Array<'reason' | 'retrieve_context' | 'read_file' | 'run_tests' | 'stop'>,
  testPasses = true,
  readOutput = '',
) {
  const events: RunEvent[] = [];
  const sink: EventSink = { async write(event) { events.push(event); } };
  const tools = {
    async readFile() { return { ok: true, output: readOutput, durationMs: 1 }; },
    async writeFile() { return { ok: true, output: '', durationMs: 1 }; },
    async replaceText() { return { ok: true, output: 'replaced', durationMs: 1 }; },
    async search() { return { ok: true, output: '', durationMs: 1 }; },
    async runTests() { return { ok: testPasses, output: testPasses ? 'pass' : 'fail', durationMs: 1, exitCode: testPasses ? 0 : 1 }; },
    async snapshot() { return { id: 'snapshot' }; },
  };
  const logger = new RunLogger(sink, { run_id: 'run', task_id: 'task', config_id: 'config' });
  const session = new Session('run', 'task', tools, logger, { maxSteps: 10, maxReasoningTokens: 100, wallClockMs: 10_000 });
  let index = 0;
  const router: Router = { async route() { return { action: actions[index++] ?? 'stop', source: 'rule' }; } };
  return { events, session, router };
}

const input = { task: 'fix it', selectedContext: [], unselectedManifest: [] };

test('agent stops only after observed passing tests', async () => {
  const { events, session, router } = fixture(['reason', 'stop']);
  const reasoner: CodingReasoner = { async decide() { return { tool: { name: 'run_tests' }, usage: { inputTokens: 0, outputTokens: 0 } }; } };
  const result = await new AgentLoop(session, reasoner, router).run({
    ...input,
    selectedContext: [{ candidate: { id: 'file.ts', path: 'file.ts', kind: 'file', approxTokens: 1 }, text: 'code' }],
  });
  assert.equal(result.outcome, 'passed');
  assert.equal(events.at(-1)!.type, 'agent_end');
  assert.ok(events.some(({ type }) => type === 'snapshot'));
});

test('submission policy stops after an edit and leaves success to authoritative evaluation', async () => {
  const { session, router } = fixture(['reason', 'stop']);
  const reasoner: CodingReasoner = { async decide() {
    return { tool: { name: 'write_file', path: 'fix.py', content: 'fixed = True\n' }, usage: { inputTokens: 0, outputTokens: 0 } };
  } };
  const result = await new AgentLoop(session, reasoner, router, undefined, {
    maxDynamicContextTokens: 100, completionPolicy: 'submission',
  }).run({ ...input, selectedContext: [{ candidate: { id: 'fix.py', path: 'fix.py', kind: 'file', approxTokens: 1 }, text: '' }] });
  assert.equal(result.termination, 'stop');
  assert.equal(result.outcome, 'unknown');
});

test('localized replacement counts as a successful edit and logs only hashes', async () => {
  const { events, session, router } = fixture(['reason', 'run_tests', 'stop']);
  const reasoner: CodingReasoner = { async decide() { return {
    tool: { name: 'replace_text', path: 'large.py', oldText: 'before', newText: 'after' },
    usage: { inputTokens: 0, outputTokens: 0 },
  }; } };
  const result = await new AgentLoop(session, reasoner, router).run({
    ...input, selectedContext: [{ candidate: { id: 'large.py', path: 'large.py', kind: 'file', approxTokens: 1 }, text: '' }],
  });
  assert.equal(result.outcome, 'passed');
  const event = events.find(({ type }) => type === 'tool_call')!;
  assert.equal(event.payload.name, 'replace_text');
  const args = event.payload.args as Record<string, unknown>;
  assert.equal(args.oldText, undefined);
  assert.match(String(args.old_text_hash), /^[a-f0-9]{64}$/);
});

test('agent rejects a router action outside the code-computed feasible set', async () => {
  const { session } = fixture([]);
  const router: Router = { async route() { return { action: 'stop', source: 'llm' }; } };
  const reasoner: CodingReasoner = { async decide() { return { thought: 'unused', usage: { inputTokens: 0, outputTokens: 0 } }; } };
  const result = await new AgentLoop(session, reasoner, router).run(input);
  assert.equal(result.termination, 'error');
});

test('agent terminates at its step budget', async () => {
  const { session, router } = fixture(['reason', 'reason', 'reason']);
  const limited = new Session('run', 'task', session.tools, session.logger, { maxSteps: 1, maxReasoningTokens: 100, wallClockMs: 10_000 });
  const reasoner: CodingReasoner = { async decide() { return { thought: 'again', usage: { inputTokens: 0, outputTokens: 0 } }; } };
  const result = await new AgentLoop(limited, reasoner, router).run(input);
  assert.equal(result.termination, 'budget');
});

test('agent classifies a dollar-cap exception as budget termination', async () => {
  const { session, router } = fixture(['reason']);
  const reasoner: CodingReasoner = { async decide() { throw new BudgetExceededError(0.1, 0.1, 0.15); } };
  const result = await new AgentLoop(session, reasoner, router).run(input);
  assert.equal(result.termination, 'budget');
});

test('agent retains failed reasoning usage and classifies usage overflow as budget', async () => {
  const first = fixture(['reason']);
  const failed: CodingReasoner = { async decide() { throw new ConsumedReasoningError(new Error('bad JSON'), 6); } };
  const failedResult = await new AgentLoop(first.session, failed, first.router).run(input);
  assert.equal(failedResult.termination, 'error');
  assert.equal(failedResult.reasoningTokens, 6);

  const second = fixture(['reason']);
  const limited = new Session('run', 'task', second.session.tools, second.session.logger, {
    maxSteps: 10, maxReasoningTokens: 5, wallClockMs: 10_000,
  });
  const overBudget = await new AgentLoop(limited, failed, second.router).run(input);
  assert.equal(overBudget.termination, 'budget');
  assert.equal(overBudget.reasoningTokens, 6);
});

test('successful dynamic reads expand context and leave the manifest', async () => {
  const { session, router } = fixture(['read_file', 'reason', 'stop']);
  const inputs: Parameters<CodingReasoner['decide']>[0][] = [];
  const reasoner: CodingReasoner = { async decide(turn) {
    inputs.push(turn);
    return { thought: 'use newly loaded context', tool: { name: 'run_tests' }, usage: { inputTokens: 0, outputTokens: 0 } };
  } };
  const planner = {
    async retrievalQuery() { return 'unused'; },
    async readTarget() { return 'extra.ts'; },
  };
  const result = await new AgentLoop(session, reasoner, router, planner).run({
    ...input,
    selectedContext: [{ candidate: { id: 'base', path: 'base.ts', kind: 'file', approxTokens: 1 }, text: 'base' }],
    unselectedManifest: ['extra.ts'],
  });
  assert.equal(result.outcome, 'passed');
  assert.deepEqual(inputs[0]!.unselectedManifest, []);
  assert.deepEqual(inputs[0]!.additionalContext, [{ source: 'read_file', target: 'extra.ts', text: '' }]);
});

test('rejects malformed reasoner and tool plugin results without unsafe fallback execution', async () => {
  const first = fixture(['reason']);
  let tests = 0;
  first.session.tools.runTests = async () => { tests++; return { ok: true, output: 'pass', durationMs: 1 }; };
  const unknown: CodingReasoner = { async decide() {
    return { tool: { name: 'shell' } } as unknown as Awaited<ReturnType<CodingReasoner['decide']>>;
  } };
  const invalidDecision = await new AgentLoop(first.session, unknown, first.router).run(input);
  assert.equal(invalidDecision.termination, 'error');
  assert.equal(tests, 0);

  const second = fixture(['run_tests']);
  second.session.tools.runTests = async () => ({ ok: 'yes', output: 'pass', durationMs: 1 }) as never;
  const unused: CodingReasoner = { async decide() { return { thought: 'unused', usage: { inputTokens: 0, outputTokens: 0 } }; } };
  const invalidTool = await new AgentLoop(second.session, unused, second.router).run(input);
  assert.equal(invalidTool.termination, 'error');
  assert.equal(invalidTool.outcome, 'unknown');
});

test('rejects malformed route evidence and snapshot ids', async () => {
  const first = fixture([]);
  const invalidRouter: Router = { async route() {
    return { action: 'reason', source: 'rule', probs: { reason: 2 } };
  } };
  const unused: CodingReasoner = { async decide() { return { thought: 'unused', usage: { inputTokens: 0, outputTokens: 0 } }; } };
  assert.equal((await new AgentLoop(first.session, unused, invalidRouter).run(input)).termination, 'error');

  const second = fixture(['run_tests']);
  second.session.tools.snapshot = async () => ({ id: '' });
  assert.equal((await new AgentLoop(second.session, unused, second.router).run(input)).termination, 'error');
});

test('dynamic context is bounded and tool logs contain hashes rather than output', async () => {
  const { events, session, router } = fixture(['read_file', 'reason', 'stop'], true, 'abcdef');
  const inputs: Parameters<CodingReasoner['decide']>[0][] = [];
  const reasoner: CodingReasoner = { async decide(turn) {
    inputs.push(turn); return { tool: { name: 'run_tests' }, usage: { inputTokens: 0, outputTokens: 0 } };
  } };
  const planner = { async retrievalQuery() { return ''; }, async readTarget() { return 'extra.ts'; } };
  await new AgentLoop(session, reasoner, router, planner, {
    maxDynamicContextTokens: 1, charsPerToken: 2,
  }).run({
    ...input,
    selectedContext: [{ candidate: { id: 'base', path: 'base.ts', kind: 'file', approxTokens: 1 }, text: 'base' }],
    unselectedManifest: ['extra.ts'],
  });
  assert.equal(inputs[0]!.additionalContext[0]!.text, 'ab');
  const read = events.find(({ type, payload }) => type === 'tool_call' && payload.name === 'read_file')!;
  assert.equal(read.payload.output, undefined);
  assert.equal(read.payload.output_chars, 6);
  assert.equal(read.payload.context_chars, 2);
  assert.equal(read.payload.context_truncated, true);
  assert.match(String(read.payload.output_hash), /^[a-f0-9]{64}$/);
});
