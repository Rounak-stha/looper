import fg from 'fast-glob';
import MiniSearch from 'minisearch';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ContextCandidate, ContextProvider } from '../../core/types.js';
import { summarizeTypeScript } from './ts-morph-summaries.js';

interface SearchDocument {
  id: string;
  path: string;
  kind: ContextCandidate['kind'];
  summary: string;
  symbols: string;
  approxTokens: number;
}

/** Thin adapter from MiniSearch to the harness ContextProvider contract. */
export class MiniSearchContextProvider implements ContextProvider {
  private constructor(
    private readonly root: string,
    private readonly index: MiniSearch<SearchDocument>,
    private readonly candidates: ReadonlyMap<string, ContextCandidate>,
  ) {}

  static async create(root: string): Promise<MiniSearchContextProvider> {
    const absoluteRoot = resolve(root);
    const paths = await fg(['**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}', '!**/*.d.ts'], {
      cwd: absoluteRoot, onlyFiles: true, unique: true, followSymbolicLinks: false,
      ignore: ['node_modules/**', 'dist/**', 'build/**', 'coverage/**', '.git/**'],
    });
    const documents = await Promise.all(paths.sort().map(async (path): Promise<SearchDocument> => {
      const text = await readFile(resolve(absoluteRoot, path), 'utf8');
      const summary = summarizeTypeScript(path, text);
      return {
        id: path, path,
        kind: /(?:^|\/)(?:test|tests|__tests__)\/|(?:\.|_)(?:test|spec)\.[cm]?[jt]sx?$/i.test(path) ? 'test' : 'file',
        summary: summary.summary,
        symbols: summary.symbols.join(' '),
        approxTokens: Math.ceil(text.length / 4),
      };
    }));
    const index = new MiniSearch<SearchDocument>({
      fields: ['path', 'symbols', 'summary'], storeFields: ['path'],
      searchOptions: { boost: { path: 2, symbols: 1.5 }, prefix: true, fuzzy: 0.2 },
    });
    index.addAll(documents);
    const candidates = new Map(documents.map((document) => [document.id, toCandidate(document)]));
    return new MiniSearchContextProvider(absoluteRoot, index, candidates);
  }

  async search(query: string, opts: { limit: number }): Promise<ContextCandidate[]> {
    const matched = this.index.search(query).slice(0, opts.limit)
      .map(({ id }) => this.candidates.get(String(id)))
      .filter((candidate): candidate is ContextCandidate => candidate !== undefined);
    if (matched.length >= opts.limit) return matched;
    const seen = new Set(matched.map(({ id }) => id));
    const remainder = [...this.candidates.values()].filter(({ id }) => !seen.has(id))
      .sort((a, b) => a.path.localeCompare(b.path)).slice(0, opts.limit - matched.length);
    return [...matched, ...remainder];
  }

  async load(id: string): Promise<{ id: string; text: string; tokens: number }> {
    if (!this.candidates.has(id)) throw new Error(`Unknown candidate: ${id}`);
    const text = await readFile(resolve(this.root, id), 'utf8');
    return { id, text, tokens: Math.ceil(text.length / 4) };
  }
}

function toCandidate(document: SearchDocument): ContextCandidate {
  return {
    id: document.id, path: document.path, kind: document.kind,
    summary: document.summary, approxTokens: document.approxTokens,
  };
}
