import type { ReasoningRequest, ReasoningResult } from '../models/types.js';
import type { AgentDecision, AgentToolCall, AgentTurnInput } from './types.js';
import type { CodingDecisionCodec } from './reasoning-adapter.js';

/** Provider-independent JSON protocol for a generative coding model. */
export class JsonCodingDecisionCodec implements CodingDecisionCodec {
  request(input: AgentTurnInput): Omit<ReasoningRequest, 'role'> {
    return {
      messages: [
        {
          role: 'system',
          content: [
            'Return exactly one JSON object and no prose or markdown.',
            'Use only one of these exact forms:',
            '{"thought":"brief reasoning"}',
            '{"thought":"why","tool":{"name":"read_file","path":"relative/path.py","startLine":1,"endLine":200}}',
            '{"thought":"why","tool":{"name":"search","query":"search text"}}',
            '{"thought":"why","tool":{"name":"write_file","path":"relative/path.py","content":"complete replacement file contents"}}',
            '{"thought":"why","tool":{"name":"replace_text","path":"relative/path.py","oldText":"exact unique existing text","newText":"replacement text"}}',
            '{"thought":"why","tool":{"name":"run_tests"}}',
            '{"thought":"tests passed","done":true}.',
            'The tool object must contain a string name field; never use {"tool":{"read_file":...}} or function-call wrappers.',
            'Choose at most one tool. Paths must come from the repository manifest. Prefer replace_text for localized edits; oldText must match exactly once. Read results may prefix lines as "LINE: "; those prefixes are annotations and must not be included in oldText. write_file content must be the complete file.',
            'Do not set done before an observed passing test.',
          ].join('\n'),
        },
        { role: 'user', content: JSON.stringify(input) },
      ],
      temperature: 0,
    };
  }

  repair(request: Omit<ReasoningRequest, 'role'>, result: ReasoningResult, error: Error): Omit<ReasoningRequest, 'role'> {
    return {
      ...request,
      messages: [
        request.messages[0]!,
        { role: 'assistant', content: bounded(result.content, 4_000) },
        {
          role: 'user',
          content: `The JSON above was rejected: ${bounded(error.message, 500)}. Preserve its intended action, but return it in one exact allowed JSON form. Do not include prose or markdown.`,
        },
      ],
    };
  }

  decode(result: ReasoningResult): AgentDecision {
    let value: unknown;
    try {
      value = JSON.parse(stripFence(result.content));
    } catch (error) {
      throw new CodingDecisionError(`Model returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CodingDecisionError('Decision must be an object');
    const record = value as Record<string, unknown>;
    const decision: AgentDecision = {};
    if (record.thought !== undefined) {
      if (typeof record.thought !== 'string') throw new CodingDecisionError('thought must be a string');
      decision.thought = record.thought;
    }
    if (record.done !== undefined) {
      if (typeof record.done !== 'boolean') throw new CodingDecisionError('done must be a boolean');
      decision.done = record.done;
    }
    if (record.tool !== undefined) decision.tool = parseTool(record.tool);
    if (!decision.thought && !decision.tool) throw new CodingDecisionError('Decision requires thought or tool');
    return decision;
  }
}

export class CodingDecisionError extends Error {
  constructor(message: string) { super(message); this.name = 'CodingDecisionError'; }
}

function parseTool(value: unknown): AgentToolCall {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CodingDecisionError('tool must be an object');
  const tool = value as Record<string, unknown>;
  if (tool.name === 'run_tests') return { name: 'run_tests' };
  if (tool.name === 'read_file' && typeof tool.path === 'string') {
    const startLine = optionalPositiveInteger(tool.startLine, 'tool.startLine');
    const endLine = optionalPositiveInteger(tool.endLine, 'tool.endLine');
    if (startLine !== undefined && endLine !== undefined && endLine < startLine) {
      throw new CodingDecisionError('tool.endLine must be greater than or equal to tool.startLine');
    }
    return {
      name: 'read_file', path: tool.path,
      ...(startLine === undefined ? {} : { startLine }), ...(endLine === undefined ? {} : { endLine }),
    };
  }
  if (tool.name === 'search' && typeof tool.query === 'string') return { name: 'search', query: tool.query };
  if (tool.name === 'write_file' && typeof tool.path === 'string' && typeof tool.content === 'string') {
    return { name: 'write_file', path: tool.path, content: tool.content };
  }
  if (tool.name === 'replace_text' && typeof tool.path === 'string'
    && typeof tool.oldText === 'string' && tool.oldText.length > 0 && typeof tool.newText === 'string') {
    return { name: 'replace_text', path: tool.path, oldText: tool.oldText, newText: tool.newText };
  }
  throw new CodingDecisionError('Unknown or invalid tool call');
}

function optionalPositiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 1) throw new CodingDecisionError(`${name} must be a positive integer`);
  return value as number;
}

function bounded(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function stripFence(content: string): string {
  const trimmed = content.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return match?.[1] ?? trimmed;
}
