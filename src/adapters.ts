import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { getDefaultManagerRoot } from './config.js';
import type {
  AgentProfileConfig,
  ControlChatResult,
  FinalReviewResult,
  ExecutionUnitState,
  ImplementationResult,
  ManagerConfig,
  ManagerRouteResult,
  ManagerTextResult,
  PlanPackDraft,
  PlanResult,
  ReviewResult,
  TaskProposal,
  TaskState,
  WorkflowDifficulty,
  WorkflowRoleName,
} from './types.js';
import { runFile } from './processRunner.js';

export interface ManagerAdapter {
  createTaskBrief(input: { task: string; projectContext: string; briefRevisionRequests: string[]; state: TaskState; config: ManagerConfig }): Promise<ManagerTextResult>;
  createRevisionInstructions(input: {
    task: string;
    projectContext: string;
    initialPlan: string;
    review: string;
    requestedChanges: string[];
    state: TaskState;
    config: ManagerConfig;
  }): Promise<ManagerTextResult>;
  explainRevisedPlan(input: {
    task: string;
    projectContext: string;
    revisedPlan: string;
    review: string;
    revisionInstructions: string;
    state: TaskState;
    config: ManagerConfig;
  }): Promise<ManagerTextResult>;
  answerQuestion(input: { question: string; context: string; projectContext: string; state: TaskState; config: ManagerConfig }): Promise<string>;
  interpretAmbiguousReply(input: { reply: string; context: string; state: TaskState; config: ManagerConfig }): Promise<string>;
  handleControlChat(input: {
    message: string;
    pendingProposal?: TaskProposal;
    mode: 'message' | 'edit';
    config: ManagerConfig;
  }): Promise<ControlChatResult>;
  routeAfterFinalReview(input: {
    finalReview: string;
    verificationLog: string;
    state: TaskState;
    config: ManagerConfig;
  }): Promise<ManagerRouteResult>;
}

export interface HeavyAgentAdapter {
  createInitialPlan(input: { task: string; projectContext: string; brief: string; difficulty: WorkflowDifficulty; state: TaskState; config: ManagerConfig }): Promise<PlanResult>;
  reviewPlan(input: { task: string; projectContext: string; initialPlan: string; difficulty: WorkflowDifficulty; state: TaskState; config: ManagerConfig }): Promise<ReviewResult>;
  revisePlan(input: {
    task: string;
    projectContext: string;
    initialPlan: string;
    review: string;
    revisionInstructions: string;
    difficulty: WorkflowDifficulty;
    state: TaskState;
    config: ManagerConfig;
  }): Promise<PlanResult>;
  implement(input: {
    task: string;
    projectContext: string;
    revisedPlan: string;
    executionUnit: ExecutionUnitState;
    state: TaskState;
    config: ManagerConfig;
  }): Promise<ImplementationResult>;
  finalReview(input: {
    task: string;
    projectContext: string;
    revisedPlan: string;
    implementationLog: string;
    verificationLog: string;
    state: TaskState;
    config: ManagerConfig;
  }): Promise<FinalReviewResult>;
}

interface DeepSeekMessage {
  role: 'system' | 'user';
  content: string;
}

function parseMaybeJson(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function managerTextFromContent(content: string): ManagerTextResult {
  const payload = record(parseMaybeJson(content));
  const result: ManagerTextResult = {
    markdown: stringValue(payload.markdown) ?? stringValue(payload.content) ?? content,
    needsUserDecision: booleanValue(payload.needsUserDecision) ?? false,
  };
  const userPrompt = stringValue(payload.userPrompt);
  if (userPrompt) result.userPrompt = userPrompt;
  return result;
}

function routeFromContent(content: string): ManagerRouteResult {
  const payload = record(parseMaybeJson(content));
  const route = stringValue(payload.route);
  if (
    route === 'complete' ||
    route === 'route_to_implementer' ||
    route === 'route_to_planner' ||
    route === 'ask_user_direction'
  ) {
    const result: ManagerRouteResult = {
      route,
      reason: stringValue(payload.reason) ?? content,
    };
    const userPrompt = stringValue(payload.userPrompt);
    if (userPrompt) result.userPrompt = userPrompt;
    return result;
  }

  return {
    route: 'ask_user_direction',
    reason: 'Manager route response was not valid JSON.',
    userPrompt: content,
  };
}

function stringArrayValue(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const items = value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
    return items.length > 0 ? items : undefined;
  }
  if (typeof value === 'string' && value.trim()) {
    return value.split(/\r?\n/).map((line) => line.replace(/^[-*]\s*/, '').trim()).filter(Boolean);
  }
  return undefined;
}

function controlChatFromContent(content: string): ControlChatResult {
  const payload = record(parseMaybeJson(content));
  const kind = stringValue(payload.kind);
  if (kind === 'proposal') {
    const proposal = record(payload.proposal);
    const title = stringValue(proposal.title);
    const task = stringValue(proposal.task) ?? stringValue(proposal.prompt) ?? stringValue(proposal.brief);
    if (title && task) {
      const markdown = stringValue(payload.markdown);
      return {
        kind: 'proposal',
        ...(markdown ? { markdown } : {}),
        proposal: {
          interpretedIntent: stringValue(proposal.interpretedIntent) ?? stringValue(proposal.intent) ?? title,
          title,
          task,
          wouldDo: stringArrayValue(proposal.wouldDo) ?? ['Use the suggested task prompt as the workflow input.'],
          wouldNotDo: stringArrayValue(proposal.wouldNotDo) ?? ['Start implementation before you confirm task creation.'],
          suggestedNextAction: stringValue(proposal.suggestedNextAction) ?? 'Reply create task, edit: <instruction>, or cancel.',
        },
      };
    }
  }
  if (kind === 'clarify') {
    return { kind: 'clarify', markdown: stringValue(payload.markdown) ?? content };
  }
  return { kind: 'answer', markdown: stringValue(payload.markdown) ?? content };
}

export async function loadManagerSkill(name: string): Promise<string> {
  try {
    return await readFile(resolve(getDefaultManagerRoot(), 'manager-skills', `${name}.md`), 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return '';
    }
    throw error;
  }
}

export class DeepSeekManagerAdapter implements ManagerAdapter {
  constructor(private readonly profile: AgentProfileConfig, private readonly env: NodeJS.ProcessEnv = process.env) {}

  private async chat(messages: DeepSeekMessage[], jsonMode = false): Promise<string> {
    const apiKeyEnv = this.profile.apiKeyEnv ?? 'DEEPSEEK_API_KEY';
    const apiKey = this.env[apiKeyEnv]?.trim();
    if (!apiKey) {
      throw new Error(`${apiKeyEnv} is required for Manager agent calls.`);
    }

    const body: Record<string, unknown> = {
      model: this.profile.model ?? 'deepseek-v4-flash',
      messages,
      temperature: 0.1,
    };
    if (jsonMode) {
      body.response_format = { type: 'json_object' };
    }

    const response = await fetch(`${this.profile.baseUrl ?? 'https://api.deepseek.com/v1'}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(`DeepSeek Manager request failed: HTTP ${response.status} ${responseText.slice(0, 500)}`);
    }
    const payload = record(parseMaybeJson(responseText));
    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    const message = record(record(choices[0]).message);
    return stringValue(message.content) ?? responseText;
  }

  private async structuredText(user: string): Promise<ManagerTextResult> {
    const content = await this.chat([
      {
        role: 'system',
        content: [
          'You are the Manager Agent for a local AI coding workflow.',
          'Return JSON only with keys markdown, needsUserDecision, and optional userPrompt.',
          'Ask the user only for product, logic, cost, UX, scope, or direction decisions.',
          'Never ask for low-level file/helper/test implementation permission.',
        ].join(' '),
      },
      { role: 'user', content: user },
    ], true);
    return managerTextFromContent(content);
  }

  async createTaskBrief(input: { task: string; projectContext: string; briefRevisionRequests: string[]; state: TaskState; config: ManagerConfig }): Promise<ManagerTextResult> {
    const hasCorrections = input.briefRevisionRequests.length > 0;
    const corrections = hasCorrections
      ? `\n\nUser corrections from previous brief rounds (apply ALL of them; the user may have used voice input so re-read the original task carefully):\n${input.briefRevisionRequests.map((c, i) => `[Correction ${i + 1}]\n${c}`).join('\n\n')}`
      : '';
    const plainLanguageSkill = await loadManagerSkill('plain-language-briefing');
    return this.structuredText([
      plainLanguageSkill,
      'Produce a CHINESE structured brief for the user to confirm before any planner/reviewer is invoked.',
      'The user often uses voice input which can mistranscribe terms; this brief is the gate where they catch those errors.',
      'Output JSON with fields markdown (the brief content) and needsUserDecision=false. The user will explicitly approve or revise via reply commands.',
      'The markdown body MUST contain these sections in this order, in 中文:',
      '1. ## 需求摘要 - 一段话总结你理解的任务核心',
      '2. ## 我理解你想做的事 - 用 bullet 列出具体要做的功能点和行为',
      '3. ## 关键决策点 - 列出用户没明说但实施前需要确认的产品/范围/UX 选择',
      '4. ## 我可能听错或理解错的地方 - 主动 surface 任何专业术语、文件名、库名、技术词的疑似听写错误，或者前后矛盾的指令',
      '5. ## 不在范围内 - 明确不要做的事（如果原任务有说）',
      'Be concise; total brief should be readable in under 60 seconds.',
      'Do NOT propose implementation details. The planner will do that. Brief is about WHAT, not HOW.',
      `Task title: ${input.state.title}`,
      `Target workspace: ${input.config.workspace.targetDir}`,
      `Project context:\n${input.projectContext}`,
      `Original task:\n${input.task}${corrections}`,
    ].filter(Boolean).join('\n\n'));
  }

  createRevisionInstructions(input: {
    task: string;
    projectContext: string;
    initialPlan: string;
    review: string;
    requestedChanges: string[];
    state: TaskState;
    config: ManagerConfig;
  }): Promise<ManagerTextResult> {
    const hasUserChanges = input.requestedChanges.length > 0;
    const priorityNote = hasUserChanges
      ? 'The user has provided requested changes via revise C. These user changes take PRIORITY and must drive the revision instructions. Reviewer feedback is secondary reference; only include it where it does not conflict with user changes. If reviewer feedback contradicts user changes, follow the user. Do not preserve the original plan structure where user changes override it.'
      : 'Turn the Reviewer feedback into concise revision instructions for the Planner Agent.';
    return this.structuredText([
      priorityNote,
      'Do not ask the user unless there is a product/direction-level decision that the user has not already answered.',
      `Project context:\n${input.projectContext}`,
      `Task:\n${input.task}`,
      `Initial plan:\n${input.initialPlan}`,
      `Reviewer feedback:\n${input.review}`,
      `User requested changes (PRIORITY when present):\n${input.requestedChanges.join('\n\n') || 'none'}`,
    ].join('\n\n'));
  }

  async explainRevisedPlan(input: {
    task: string;
    projectContext: string;
    revisedPlan: string;
    review: string;
    revisionInstructions: string;
    state: TaskState;
    config: ManagerConfig;
  }): Promise<ManagerTextResult> {
    const plainLanguageSkill = await loadManagerSkill('plain-language-briefing');
    return this.structuredText([
      plainLanguageSkill,
      'Explain the revised plan to the user in plain language.',
      'Explain what the plan tries to do, why it flows logically, practical meaning of important technical choices, what the reviewer objected to, and how the revision addressed it.',
      'Identify whether remaining decisions are technical-only or product/direction-level.',
      `Project context:\n${input.projectContext}`,
      `Task:\n${input.task}`,
      `Reviewer feedback:\n${input.review}`,
      `Revision instructions:\n${input.revisionInstructions}`,
      `Revised plan:\n${input.revisedPlan}`,
    ].filter(Boolean).join('\n\n'));
  }

  async answerQuestion(input: { question: string; context: string; projectContext: string; state: TaskState; config: ManagerConfig }): Promise<string> {
    return this.chat([
      {
        role: 'system',
        content: 'Answer as the Manager Agent using only the provided project, task, plan, review, Q&A, and decision context. Keep the answer clear and practical.',
      },
      {
        role: 'user',
        content: [`Question: ${input.question}`, `Project context:\n${input.projectContext}`, input.context].join('\n\n'),
      },
    ]);
  }

  async interpretAmbiguousReply(input: { reply: string; context: string; state: TaskState; config: ManagerConfig }): Promise<string> {
    return this.chat([
      {
        role: 'system',
        content: 'Interpret the user reply as approve, reject, revise, stop, status, summary, or unclear. Do not execute anything. Ask for explicit confirmation in one sentence.',
      },
      {
        role: 'user',
        content: [`Reply: ${input.reply}`, input.context].join('\n\n'),
      },
    ]);
  }

  async handleControlChat(input: {
    message: string;
    pendingProposal?: TaskProposal;
    mode: 'message' | 'edit';
    config: ManagerConfig;
  }): Promise<ControlChatResult> {
    const content = await this.chat([
      {
        role: 'system',
        content: [
          'You are the Manager Agent for an unbound Lark control chat.',
          'Behave like a chatbot first: answer questions, explain concepts, help think, and generate prompts when asked.',
          'Never create or start a real task. You may only propose a task for later confirmation.',
          'Return JSON only.',
          'For normal chat or prompt generation, return {"kind":"answer","markdown":"..."}; do not create a proposal unless the user clearly describes a future workflow task.',
          'For possible workflow tasks, return {"kind":"proposal","markdown":"optional intro","proposal":{"interpretedIntent":"...","title":"...","task":"...","wouldDo":["..."],"wouldNotDo":["..."],"suggestedNextAction":"Reply create task, edit: <instruction>, or cancel."}}.',
          'For unclear intent, return {"kind":"clarify","markdown":"..."} asking a short clarification question.',
          'If the user says not to create a task, not to execute, or only asks for a prompt, return kind=answer.',
        ].join(' '),
      },
      {
        role: 'user',
        content: [
          `Mode: ${input.mode}`,
          `Target workspace: ${input.config.workspace.targetDir}`,
          input.pendingProposal ? `Pending proposal:\n${JSON.stringify(input.pendingProposal, null, 2)}` : 'Pending proposal: none',
          `User message:\n${input.message}`,
        ].join('\n\n'),
      },
    ], true);
    return controlChatFromContent(content);
  }

  async routeAfterFinalReview(input: {
    finalReview: string;
    verificationLog: string;
    state: TaskState;
    config: ManagerConfig;
  }): Promise<ManagerRouteResult> {
    const content = await this.chat([
      {
        role: 'system',
        content: [
          'You route after final review.',
          'Return JSON only: {"route":"complete|route_to_implementer|route_to_planner|ask_user_direction","reason":"...","userPrompt":"optional"}',
          'Route to implementer for contained implementation defects, planner for plan/design mismatch, ask user for product/scope/direction decisions.',
        ].join(' '),
      },
      {
        role: 'user',
        content: [`Final review:\n${input.finalReview}`, `Verification:\n${input.verificationLog}`].join('\n\n'),
      },
    ], true);
    return routeFromContent(content);
  }
}

export class StubHeavyAgentAdapter implements HeavyAgentAdapter {
  async createInitialPlan(input: { task: string; brief: string; difficulty: WorkflowDifficulty; state: TaskState; config: ManagerConfig }): Promise<PlanResult> {
    return {
      markdown: [
        '# Initial Plan',
        '',
        'This is a stub planner artifact. Enable `--allow-agent-calls` to call the configured Planner Agent.',
        '',
        '## Task Brief',
        input.brief,
        '',
        '## Proposed Verification',
        '- npm test',
      ].join('\n'),
      verificationCommands: ['npm test'],
    };
  }

  async reviewPlan(): Promise<ReviewResult> {
    return {
      markdown: [
        '# Reviewer Feedback',
        '',
        'Stub reviewer: no blocking issues found. Enable `--allow-agent-calls` for the configured Reviewer Agent.',
      ].join('\n'),
    };
  }

  async revisePlan(input: {
    task: string;
    initialPlan: string;
    review: string;
    revisionInstructions: string;
    difficulty: WorkflowDifficulty;
    state: TaskState;
    config: ManagerConfig;
  }): Promise<PlanResult> {
    return {
      markdown: [
        '# Revised Plan',
        '',
        'This is a stub revised plan created from the Manager revision instructions.',
        '',
        '## Revision Instructions',
        input.revisionInstructions,
        '',
        '## Verification Commands',
        '- npm test',
      ].join('\n'),
      verificationCommands: ['npm test'],
    };
  }

  async implement(): Promise<ImplementationResult> {
    return {
      markdown: [
        '# Implementation Log',
        '',
        'Stub implementer did not modify the target workspace. Enable `--allow-agent-calls` to call the configured Implementer Agent.',
      ].join('\n'),
      changedFiles: [],
    };
  }

  async finalReview(): Promise<FinalReviewResult> {
    return {
      markdown: [
        '# Final Review',
        '',
        'Stub final reviewer found no blocking issues. Enable `--allow-agent-calls` to call the configured Final Reviewer Agent.',
      ].join('\n'),
      passed: true,
    };
  }
}

class CliHeavyAgentAdapter implements HeavyAgentAdapter {
  constructor(private readonly config: ManagerConfig) {}

  private async codex(prompt: string, profileName: string, role: WorkflowRoleName, config = this.config): Promise<string> {
    const profile = config.profiles[profileName];
    const command = profile?.command ?? 'codex';
    const sandbox = role === 'developer' ? 'danger-full-access' : 'read-only';
    const result = await runFile(command, ['-a', 'never', 'exec', '-C', config.workspace.targetDir, '--sandbox', sandbox, '--skip-git-repo-check', '-'], config.workspace.targetDir, prompt);
    return [result.stdout, result.stderr].filter(Boolean).join('\n');
  }

  private async claude(prompt: string, profileName: string, config = this.config): Promise<string> {
    const profile = config.profiles[profileName];
    const command = profile?.command ?? 'claude';
    const result = await runFile(command, ['-p', '--permission-mode', 'bypassPermissions', '--add-dir', config.workspace.targetDir], config.workspace.targetDir, prompt);
    return [result.stdout, result.stderr].filter(Boolean).join('\n');
  }

  private runWorkflowRole(
    prompt: string,
    difficulty: WorkflowDifficulty,
    role: WorkflowRoleName,
    config: ManagerConfig,
  ): Promise<string> {
    const profileName = config.workflowRoles[difficulty][role];
    const profile = config.profiles[profileName];
    if (!profile) {
      throw new Error(`Workflow role ${difficulty}.${role} references missing profile ${profileName}.`);
    }
    if (profile.kind === 'codex') {
      return this.codex(prompt, profileName, role, config);
    }
    if (profile.kind === 'claude') {
      return this.claude(prompt, profileName, config);
    }
    throw new Error(`Workflow role ${difficulty}.${role} uses unsupported heavy agent profile kind ${profile.kind}.`);
  }

  async createInitialPlan(input: { task: string; projectContext: string; brief: string; difficulty: WorkflowDifficulty; state: TaskState; config: ManagerConfig }): Promise<PlanResult> {
    const markdown = await this.runWorkflowRole([
      'Act as the Architect. Create an initial implementation plan. Do not edit files.',
      'Every approved plan is one parent task. If decomposition is useful, describe execution units; otherwise treat it as one execution unit.',
      'Suggest exactly one lightweight Category if obvious. Supported categories are: Reader Core, Selection / Popup, Vocabulary Algorithm, Translation / LLM, Feedback / User Model, Storage / Persistence, Backend / API, Data / Dictionary Pipeline, Evaluation / Benchmark, Manager / Workflow, Docs / Task Record, UI / Frontend, Other.',
      'Do not create category folders or tags.',
      `Workflow difficulty: ${input.difficulty}`,
      `Project context:\n${input.projectContext}`,
      `Task:\n${input.task}`,
      `Manager brief:\n${input.brief}`,
      `User requested changes from previous planning rounds:\n${input.state.requestedChanges.join('\n\n') || 'none'}`,
      'End with a "Verification Commands" section listing only commands to run.',
    ].join('\n\n'), input.difficulty, 'architect', input.config);
    return { markdown, verificationCommands: extractVerificationCommands(markdown), planPackDraft: extractPlanPackDraft(markdown) };
  }

  async reviewPlan(input: { task: string; projectContext: string; initialPlan: string; difficulty: WorkflowDifficulty; state: TaskState; config: ManagerConfig }): Promise<ReviewResult> {
    return {
      markdown: await this.runWorkflowRole([
        'Act as the Plan Reviewer. Review this initial plan once. Focus on blocking bugs, risks, missing tests, product-impacting ambiguity, and whether any proposed execution-unit breakdown is coherent.',
        `Workflow difficulty: ${input.difficulty}`,
        `Project context:\n${input.projectContext}`,
        `Task:\n${input.task}`,
        `Initial plan:\n${input.initialPlan}`,
      ].join('\n\n'), input.difficulty, 'planReviewer', input.config),
    };
  }

  async revisePlan(input: {
    task: string;
    projectContext: string;
    initialPlan: string;
    review: string;
    revisionInstructions: string;
    difficulty: WorkflowDifficulty;
    state: TaskState;
    config: ManagerConfig;
  }): Promise<PlanResult> {
    const markdown = await this.runWorkflowRole([
      'Act as the Architect. Create the revised plan. Do not edit files.',
      'Every approved plan is one parent task. If decomposition is useful, describe execution units; otherwise treat it as one execution unit.',
      'Suggest exactly one lightweight Category if obvious. Use Other when unsure. Do not create category folders or tags.',
      `Workflow difficulty: ${input.difficulty}`,
      `Project context:\n${input.projectContext}`,
      `Task:\n${input.task}`,
      `Initial plan:\n${input.initialPlan}`,
      `Reviewer feedback:\n${input.review}`,
      `Manager revision instructions:\n${input.revisionInstructions}`,
      'End with a "Verification Commands" section listing only commands to run.',
    ].join('\n\n'), input.difficulty, 'architect', input.config);
    return { markdown, verificationCommands: extractVerificationCommands(markdown), planPackDraft: extractPlanPackDraft(markdown) };
  }

  async implement(input: {
    task: string;
    projectContext: string;
    revisedPlan: string;
    executionUnit: ExecutionUnitState;
    state: TaskState;
    config: ManagerConfig;
  }): Promise<ImplementationResult> {
    const difficulty = input.state.difficulty ?? 'medium';
    const markdown = await this.runWorkflowRole([
      'Act as the Developer. Implement only the current execution unit from the approved parent-task plan.',
      `Project context:\n${input.projectContext}`,
      `Task:\n${input.task}`,
      `Approved revised plan:\n${input.revisedPlan}`,
      `Current execution unit:\nTask ${String(input.executionUnit.index).padStart(2, '0')}: ${input.executionUnit.name}`,
      'Do not revert unrelated user changes. Report changed files at the end.',
      'Run focused tests when practical and include the Test Result details for this execution unit.',
    ].join('\n\n'), difficulty, 'developer', input.config);
    return { markdown, changedFiles: [] };
  }

  async finalReview(input: {
    task: string;
    projectContext: string;
    revisedPlan: string;
    implementationLog: string;
    verificationLog: string;
    state: TaskState;
    config: ManagerConfig;
  }): Promise<FinalReviewResult> {
    const difficulty = input.state.difficulty ?? 'medium';
    const markdown = await this.runWorkflowRole([
      'Act as the Final Reviewer. Review the whole parent task after all execution units are implemented. Do not review every subtask separately by default. Report blocking issues first.',
      `Project context:\n${input.projectContext}`,
      `Task:\n${input.task}`,
      `Approved revised plan:\n${input.revisedPlan}`,
      `Implementation log:\n${input.implementationLog}`,
      `Verification:\n${input.verificationLog}`,
    ].join('\n\n'), difficulty, 'finalReviewer', input.config);
    return {
      markdown,
      passed: !/\b(blocking|must fix|failed|regression)\b/i.test(markdown),
    };
  }
}

export function extractVerificationCommands(markdown: string): string[] {
  return markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => line.replace(/^[-*]\s+/, '').replace(/^`(.+)`$/, '$1').trim())
    .filter((line) => /^(npm (?:run )?(?:test|build|lint)|tsc --noEmit|npx tsc --noEmit)\b/.test(line));
}

export function extractPlanPackDraft(markdown: string): PlanPackDraft {
  const category = markdown.match(/^\s*(?:Category|Task Category)\s*:\s*(.+?)\s*$/im)?.[1]
    ?? markdown.match(/^\|\s*Category\s*\|\s*(.+?)\s*\|/im)?.[1];
  const summary = sectionBody(markdown, 'Plan Summary') ?? firstNonHeadingParagraph(markdown);
  const taskHeadings = [...markdown.matchAll(/^#{1,4}\s+Task\s+\d{1,2}\s*:\s*(.+?)\s*$/gim)];
  const unitHeadings = taskHeadings.length > 0
    ? taskHeadings
    : [...markdown.matchAll(/^#{1,4}\s+Execution Unit\s+\d{1,2}\s*:\s*(.+?)\s*$/gim)];
  return {
    ...(category ? { category: category.trim() } : {}),
    ...(summary ? { summary: summary.trim() } : {}),
    ...(unitHeadings.length > 0
      ? { executionUnits: unitHeadings.map((match) => ({ name: match[1]?.trim() ?? 'Main' })) }
      : {}),
  };
}

function sectionBody(markdown: string, heading: string): string | undefined {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = markdown.match(new RegExp(`^#{1,4}\\s+${escaped}\\s*$\\n([\\s\\S]*?)(?=\\n#{1,4}\\s+|$)`, 'im'));
  return match?.[1]?.trim();
}

function firstNonHeadingParagraph(markdown: string): string | undefined {
  return markdown
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .find((paragraph) => paragraph.length > 0 && !paragraph.startsWith('#') && !paragraph.startsWith('|'));
}

export function createManagerAdapter(config: ManagerConfig, env: NodeJS.ProcessEnv = process.env): ManagerAdapter {
  const profile = config.profiles[config.roles.manager];
  if (!profile || profile.kind !== 'deepseek') {
    throw new Error(`Manager profile ${config.roles.manager} must be a DeepSeek profile for product runs.`);
  }
  return new DeepSeekManagerAdapter(profile, env);
}

export function createHeavyAgentAdapter(config: ManagerConfig, allowAgentCalls: boolean): HeavyAgentAdapter {
  return allowAgentCalls ? new CliHeavyAgentAdapter(config) : new StubHeavyAgentAdapter();
}
