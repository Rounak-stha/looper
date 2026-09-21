#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

let files;
try {
  files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
} catch {
  console.error('Public audit requires a Git worktree so it can inspect exactly the tracked files.');
  process.exit(2);
}

const violations = [];
const forbiddenFiles = [
  /^\.env$/,
  /^\.env\.(?!example$)/,
  /(?:^|\/)node_modules\//,
  /(?:^|)\.cache\//,
  /(?:^|\/)dist\//,
  /(?:^|\/)runs\/.*\.(?:json|jsonl)$/,
  /(?:^|\/)tasks\/.*\.jsonl$/,
  /(?:^|\/)configs\/development\/(?![^/]+\.example\.json$)/,
];
const contentRules = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['OpenAI-style key', /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ['GitHub token', /\bgh[opusr]_[A-Za-z0-9]{20,}\b/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['machine-specific path', /(?:\/Users\/[^/\s"']+\/|\/home\/[^/\s"']+\/|[A-Za-z]:\\Users\\[^\\\s"']+\\)/],
  ['concrete Azure resource host', /https:\/\/(?!(?:YOUR-RESOURCE|example)\.)[A-Za-z0-9-]+\.(?:services\.ai|openai)\.azure\.com/i],
];

for (const file of files) {
  if (forbiddenFiles.some((pattern) => pattern.test(file))) violations.push(`${file}: forbidden tracked artifact`);
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { continue; }
  if (text.includes('\0')) continue;
  for (const [name, pattern] of contentRules) if (pattern.test(text)) violations.push(`${file}: ${name}`);
}

if (violations.length) {
  console.error('Public artifact audit failed:\n' + violations.map((item) => `- ${item}`).join('\n'));
  process.exit(1);
}
console.log(`Public artifact audit passed (${files.length} tracked files).`);
