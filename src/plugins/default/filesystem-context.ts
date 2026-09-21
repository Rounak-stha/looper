import fg from 'fast-glob';
import MiniSearch from 'minisearch';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import type { ContextCandidate, ContextProvider } from '../../core/types.js';

interface Document {
  id: string;
  path: string;
  kind: ContextCandidate['kind'];
  /** Bounded repository text used only by the local retrieval index. */
  searchText: string;
  /** Short bounded text exposed to selectors. */
  summary: string;
  approxTokens: number;
}

const SOURCE_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.cs', '.css', '.ex', '.exs', '.go', '.h', '.hpp', '.html', '.java', '.js', '.jsx',
  '.kt', '.kts', '.lua', '.m', '.mm', '.php', '.pl', '.pm', '.py', '.rb', '.rs', '.scala', '.sh', '.sql',
  '.swift', '.ts', '.tsx', '.vue', '.xml', '.yaml', '.yml',
]);
const TEST_PATH = /(?:^|\/)(?:test|tests|testing|spec|specs|__tests__)\/|(?:^|[._-])(?:test|tests|spec)(?:[._-]|$)/i;

/** Language-neutral fallback index based only on paths and bounded text previews. */
export class FilesystemContextProvider implements ContextProvider {
  private constructor(
    private readonly root: string,
    private readonly index: MiniSearch<Document>,
    private readonly candidates: ReadonlyMap<string, ContextCandidate>,
  ) {}

  static async create(root: string, options: { maxFiles?: number; maxFileBytes?: number } = {}): Promise<FilesystemContextProvider> {
    const absoluteRoot = resolve(root);
    const maxFiles = positiveInteger(options.maxFiles ?? 20_000, 'maxFiles');
    const maxFileBytes = positiveInteger(options.maxFileBytes ?? 1_000_000, 'maxFileBytes');
    const discovered = (await fg('**/*', {
      cwd: absoluteRoot, onlyFiles: true, unique: true, followSymbolicLinks: false, dot: false,
      ignore: ['.git/**', 'node_modules/**', 'vendor/**', 'dist/**', 'build/**', 'coverage/**', '.venv/**', 'venv/**', '__pycache__/**'],
    })).filter((path) => SOURCE_EXTENSIONS.has(extname(path).toLowerCase())).sort();
    if (discovered.length > maxFiles) throw new Error(`Repository has ${discovered.length} source files; maximum is ${maxFiles}`);
    const documents: Document[] = [];
    for (const path of discovered) {
      const buffer = await readFile(resolve(absoluteRoot, path));
      if (buffer.includes(0)) continue;
      const bounded = buffer.subarray(0, maxFileBytes).toString('utf8');
      const summary = bounded.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 8).join(' ').slice(0, 1000);
      documents.push({
        id: path, path, kind: TEST_PATH.test(path) ? 'test' : 'file',
        searchText: bounded, summary, approxTokens: Math.ceil(buffer.length / 4),
      });
    }
    const index = new MiniSearch<Document>({
      fields: ['path', 'searchText'], storeFields: ['path'],
      searchOptions: { boost: { path: 3 }, prefix: true, fuzzy: 0.2 },
    });
    index.addAll(documents);
    const candidates = new Map(documents.map((document) => [document.id, toCandidate(document)]));
    return new FilesystemContextProvider(absoluteRoot, index, candidates);
  }

  async search(query: string, options: { limit: number }): Promise<ContextCandidate[]> {
    const matched = this.index.search(query).slice(0, options.limit)
      .map(({ id }) => this.candidates.get(String(id))).filter((item): item is ContextCandidate => item !== undefined);
    const seen = new Set(matched.map(({ id }) => id));
    return [...matched, ...[...this.candidates.values()].filter(({ id }) => !seen.has(id))
      .sort((a, b) => a.path.localeCompare(b.path)).slice(0, Math.max(0, options.limit - matched.length))];
  }

  async load(id: string): Promise<{ id: string; text: string; tokens: number }> {
    if (!this.candidates.has(id)) throw new Error(`Unknown candidate: ${id}`);
    const text = await readFile(resolve(this.root, id), 'utf8');
    return { id, text, tokens: Math.ceil(text.length / 4) };
  }
}

function toCandidate(document: Document): ContextCandidate {
  return { id: document.id, path: document.path, kind: document.kind, summary: document.summary, approxTokens: document.approxTokens };
}
function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}
