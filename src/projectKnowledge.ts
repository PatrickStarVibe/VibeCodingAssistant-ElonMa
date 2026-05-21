import { readdir, readFile, stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

import { requireProject, resolveProjectDocsDir } from './projects.js';
import type { ManagerConfig } from './types.js';

const DEFAULT_ALWAYS_BUDGET = 8_000;
const DEFAULT_RETRIEVED_BUDGET = 12_000;
const DEFAULT_MAX_RETRIEVED_CHUNKS = 6;
const MAX_FILE_CHARS = 60_000;

interface KnowledgeChunk {
  path: string;
  heading: string;
  text: string;
  score: number;
}

export interface ProjectContextOptions {
  projectId?: string;
  query: string;
  alwaysBudget?: number;
  retrievedBudget?: number;
  maxRetrievedChunks?: number;
}

export class ProjectKnowledgeService {
  constructor(private readonly managerRoot: string) {}

  async buildContextPacket(config: ManagerConfig, options: ProjectContextOptions): Promise<string> {
    const project = requireProject(config, options.projectId);
    const docsRoot = resolveProjectDocsDir(this.managerRoot, project);
    const files = await listMarkdownFiles(docsRoot).catch(() => []);
    const alwaysPaths = new Set((project.alwaysRead ?? []).map((path) => normalizeRelativePath(path)));
    const chunks = (await Promise.all(files.map((file) => readMarkdownChunks(docsRoot, file)))).flat();
    const alwaysChunks = chunks.filter((chunk) => alwaysPaths.has(normalizeRelativePath(chunk.path)));
    const retrievedChunks = rankChunks(
      chunks.filter((chunk) => !alwaysPaths.has(normalizeRelativePath(chunk.path))),
      options.query,
    ).slice(0, options.maxRetrievedChunks ?? DEFAULT_MAX_RETRIEVED_CHUNKS);

    const always = renderChunks(alwaysChunks, options.alwaysBudget ?? DEFAULT_ALWAYS_BUDGET);
    const retrieved = renderChunks(retrievedChunks, options.retrievedBudget ?? DEFAULT_RETRIEVED_BUDGET);

    return [
      '## Project Context Packet',
      `Project: ${project.name} (${project.id})`,
      `Target workspace: ${project.targetDir}`,
      `Project docs folder: ${docsRoot}`,
      'These Markdown notes are user-provided project memory. They may be stale; if they conflict with current code, current code wins.',
      '',
      '### Always Read Markdown',
      always || 'No always-read Markdown was configured or found.',
      '',
      '### Retrieved Markdown',
      retrieved || 'No relevant Markdown was found for this request.',
    ].join('\n');
  }
}

export function renderProjectContextSummary(config: ManagerConfig, projectId: string | undefined): string {
  const project = requireProject(config, projectId);
  return [
    `Project: ${project.name} (${project.id})`,
    `Target workspace: ${project.targetDir}`,
    `Docs folder: ${project.docsDir}`,
  ].join('\n');
}

async function listMarkdownFiles(root: string): Promise<string[]> {
  const rootStat = await stat(root).catch(() => undefined);
  if (!rootStat?.isDirectory()) return [];
  return walkMarkdown(root, root);
}

async function walkMarkdown(root: string, dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkMarkdown(root, path));
    } else if (entry.isFile() && entry.name.toLocaleLowerCase().endsWith('.md')) {
      files.push(normalizeRelativePath(relative(root, path)));
    }
  }
  return files;
}

async function readMarkdownChunks(root: string, relativePath: string): Promise<KnowledgeChunk[]> {
  const fullPath = resolve(root, relativePath);
  const content = (await readFile(fullPath, 'utf8')).slice(0, MAX_FILE_CHARS);
  return splitMarkdown(content).map((chunk) => ({
    path: normalizeRelativePath(relativePath),
    heading: chunk.heading,
    text: chunk.text,
    score: 0,
  }));
}

function splitMarkdown(content: string): Array<{ heading: string; text: string }> {
  const lines = content.split(/\r?\n/);
  const chunks: Array<{ heading: string; text: string }> = [];
  let heading = 'Document';
  let buffer: string[] = [];

  for (const line of lines) {
    const match = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (match && buffer.join('\n').trim()) {
      chunks.push({ heading, text: buffer.join('\n').trim() });
      heading = match[2] ?? 'Section';
      buffer = [line];
    } else {
      if (match) heading = match[2] ?? 'Section';
      buffer.push(line);
    }
  }

  const text = buffer.join('\n').trim();
  if (text) chunks.push({ heading, text });
  return chunks.length > 0 ? chunks : [{ heading: 'Document', text: content.trim() }];
}

function rankChunks(chunks: KnowledgeChunk[], query: string): KnowledgeChunk[] {
  const tokens = extractTokens(query);
  if (tokens.length === 0) return chunks.map((chunk) => ({ ...chunk, score: 0 }));
  return chunks
    .map((chunk) => ({ ...chunk, score: scoreChunk(chunk, tokens) }))
    .filter((chunk) => chunk.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

function scoreChunk(chunk: KnowledgeChunk, tokens: string[]): number {
  const title = `${chunk.path} ${chunk.heading}`.toLocaleLowerCase();
  const text = chunk.text.toLocaleLowerCase();
  return tokens.reduce((score, token) => {
    const inTitle = title.includes(token) ? 4 : 0;
    const inText = text.includes(token) ? 1 : 0;
    return score + inTitle + inText;
  }, 0);
}

function extractTokens(text: string): string[] {
  const matches = text.toLocaleLowerCase().match(/[a-z0-9_-]{2,}|[\p{Script=Han}]{2,}/gu) ?? [];
  return [...new Set(matches)].slice(0, 80);
}

function renderChunks(chunks: KnowledgeChunk[], budget: number): string {
  let remaining = budget;
  const rendered: string[] = [];
  for (const chunk of chunks) {
    if (remaining <= 0) break;
    const header = `#### ${chunk.path}#${chunk.heading}`;
    const bodyBudget = Math.max(0, remaining - header.length - 2);
    if (bodyBudget <= 0) break;
    const body = truncate(chunk.text, bodyBudget);
    rendered.push(`${header}\n${body}`);
    remaining -= header.length + body.length + 2;
  }
  return rendered.join('\n\n');
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 20)).trimEnd()}\n[truncated]`;
}

function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, '/');
}
