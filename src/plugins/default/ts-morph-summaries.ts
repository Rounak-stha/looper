import { Project, SyntaxKind } from 'ts-morph';

export interface FileSummary {
  summary: string;
  symbols: string[];
  imports: string[];
}

/** Uses ts-morph; this module only maps its AST into the harness summary shape. */
export function summarizeTypeScript(path: string, text: string): FileSummary {
  const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true });
  const source = project.createSourceFile(path, text, { overwrite: true });
  const symbols = [
    ...source.getClasses().flatMap((node) => node.getName() ?? []),
    ...source.getFunctions().flatMap((node) => node.getName() ?? []),
    ...source.getInterfaces().map((node) => node.getName()),
    ...source.getTypeAliases().map((node) => node.getName()),
    ...source.getEnums().map((node) => node.getName()),
    ...source.getVariableDeclarations().map((node) => node.getName()),
  ];
  const imports = source.getImportDeclarations().map((node) => node.getModuleSpecifierValue());
  const firstStatement = source.getStatements()[0];
  const comment = firstStatement?.getLeadingCommentRanges()[0]?.getText()
    .replace(/^\/\*+|\*+\/$|^\/\//g, '').replace(/\s+/g, ' ').trim() ?? '';
  const parts = [
    symbols.length ? `exports: ${symbols.slice(0, 12).join(', ')}` : '',
    comment,
    imports.length ? `imports: ${imports.slice(0, 8).join(', ')}` : '',
  ].filter(Boolean);
  return { summary: parts.join(' | ').slice(0, 700) || 'No exported symbols or top-level documentation', symbols, imports };
}

// Keep SyntaxKind referenced so dependency/API drift is caught by type checking.
void SyntaxKind.SourceFile;
