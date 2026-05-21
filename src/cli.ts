#!/usr/bin/env node
import { resolve } from 'node:path';

import { ArtifactStore } from './artifacts.js';
import { createHeavyAgentAdapter, createManagerAdapter } from './adapters.js';
import { getDefaultManagerRoot, loadConfig } from './config.js';
import { getDefaultProjectId, renderProjectList, requireProject } from './projects.js';
import type { ArtifactName } from './types.js';
import { taskTextFromFile, WorkflowService } from './workflow.js';

interface CliOptions {
  command: string;
  args: string[];
  configPath: string | undefined;
  task: string;
  projectId: string | undefined;
  allowAgentCalls: boolean;
}

const ARTIFACT_NAMES: ArtifactName[] = [
  'original-task',
  'manager-brief',
  'initial-plan',
  'review',
  'revision-instructions',
  'revised-plan',
  'manager-explanation',
  'qa-log',
  'decision-log',
  'implementation-log',
  'git-pre-status',
  'git-post-status',
  'git-pre-diff',
  'git-post-diff',
  'test-build-log',
  'final-review',
  'final-report',
];

function parseCli(argv: string[]): CliOptions {
  const args = [...argv];
  const command = args.shift() ?? 'help';
  let configPath: string | undefined;
  let task = 'latest';
  let projectId: string | undefined;
  let allowAgentCalls = false;
  const rest: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--config') {
      configPath = args[index + 1];
      index += 1;
    } else if (arg === '--task' && command !== 'create') {
      task = args[index + 1] ?? 'latest';
      index += 1;
    } else if (arg === '--project') {
      projectId = args[index + 1];
      index += 1;
    } else if (arg === '--allow-agent-calls') {
      allowAgentCalls = true;
    } else if (arg) {
      rest.push(arg);
    }
  }

  return { command, args: rest, configPath, task, projectId, allowAgentCalls };
}

function valueAfter(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function positional(args: string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value) {
      continue;
    }
    if (value.startsWith('--')) {
      index += 1;
    } else {
      values.push(value);
    }
  }
  return values;
}

function printHelp(): void {
  console.log([
    'Manager AI workflow orchestrator',
    '',
    'Commands:',
    '  create --title "..." --task "..."',
    '  create --title "..." --task-file path/to/task.md',
    '  create --project projectId --title "..." --task "..."',
    '  projects',
    '  project list',
    '  plan --task latest',
    '  status --task latest',
    '  summary --task latest',
    '  show --task latest --artifact revised-plan',
    '  ask --task latest "question"',
    '  reply --task latest "approve A|A|yes|同意|reject B|B|revise C: ...|stop|status|summary"',
    '  reply --task latest --text-file path/to/reply.txt   # for long/non-ASCII replies on Windows',
    '',
    'Flags:',
    '  --config manager.config.local.json',
    '  --allow-agent-calls',
  ].join('\n'));
}

async function makeWorkflow(options: CliOptions): Promise<WorkflowService> {
  const managerRoot = getDefaultManagerRoot();
  const config = await loadConfig(managerRoot, options.configPath);
  const store = new ArtifactStore(managerRoot, config);
  const manager = createManagerAdapter(config);
  const heavyAgents = createHeavyAgentAdapter(config, options.allowAgentCalls);
  return new WorkflowService(store, config, manager, heavyAgents);
}

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  if (options.command === 'help' || options.command === '--help' || options.command === '-h') {
    printHelp();
    return;
  }

  if (options.command === 'create') {
    const managerRoot = getDefaultManagerRoot();
    const config = await loadConfig(managerRoot, options.configPath);
    const store = new ArtifactStore(managerRoot, config);
    const title = valueAfter(options.args, '--title');
    const inlineTask = valueAfter(options.args, '--task');
    const taskFile = valueAfter(options.args, '--task-file');
    if (!title) throw new Error('create requires --title.');
    if (!inlineTask && !taskFile) throw new Error('create requires --task or --task-file.');
    const task = inlineTask ?? await taskTextFromFile(resolve(taskFile ?? ''));
    const projectId = options.projectId ?? getDefaultProjectId(config);
    requireProject(config, projectId);
    const service = new WorkflowService(
      store,
      config,
      createManagerAdapter(config),
      createHeavyAgentAdapter(config, options.allowAgentCalls),
    );
    const result = await service.createTask({ title, task, projectId });
    console.log(result.message);
    console.log(`Status: ${result.state.status}`);
    return;
  }

  if (options.command === 'projects' || (options.command === 'project' && options.args[0] === 'list')) {
    const managerRoot = getDefaultManagerRoot();
    const config = await loadConfig(managerRoot, options.configPath);
    console.log(renderProjectList(config, getDefaultProjectId(config)));
    return;
  }

  const workflow = await makeWorkflow(options);
  switch (options.command) {
    case 'plan': {
      const result = await workflow.planTask(options.task);
      console.log(result.message);
      console.log(`Status: ${result.state.status}`);
      break;
    }
    case 'status':
      console.log(await workflow.status(options.task));
      break;
    case 'summary':
      console.log(await workflow.summary(options.task));
      break;
    case 'show': {
      const artifact = valueAfter(options.args, '--artifact');
      if (!artifact || !ARTIFACT_NAMES.includes(artifact as ArtifactName)) {
        throw new Error(`show requires --artifact with one of: ${ARTIFACT_NAMES.join(', ')}`);
      }
      console.log(await workflow.showArtifact(options.task, artifact as ArtifactName));
      break;
    }
    case 'ask': {
      const question = positional(options.args).join(' ').trim();
      if (!question) throw new Error('ask requires a question.');
      const result = await workflow.askQuestion(options.task, question);
      console.log(result.message);
      break;
    }
    case 'reply': {
      const replyFile = valueAfter(options.args, '--text-file');
      const reply = replyFile
        ? (await taskTextFromFile(resolve(replyFile))).trim()
        : positional(options.args).join(' ').trim();
      if (!reply) throw new Error('reply requires text or --text-file.');
      const result = await workflow.reply(options.task, reply);
      console.log(result.message);
      console.log(`Status: ${result.state.status}`);
      break;
    }
    default:
      throw new Error(`Unknown command: ${options.command}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
