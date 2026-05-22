import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { getDefaultManagerRoot } from './config.js';
import { sanitizeTextForArtifact } from './textSanitizer.js';
import type {
  AgentPromptRecord,
  AgentProfileConfig,
  AllowedAction,
  ArtifactName,
  ComposedReply,
  ControlChatResult,
  FinalReviewResult,
  ExecutionUnitState,
  ImplementationResult,
  IntentName,
  IntentResult,
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
  classifyIntent(input: {
    userMessage: string;
    state: TaskState;
    allowedActions: AllowedAction[];
    recentContext: string;
    config: ManagerConfig;
  }): Promise<IntentResult>;
  composeReply(input: {
    rawMessage: string;
    state: TaskState;
    pendingPrompt?: string;
    userQuestion?: string;
    config: ManagerConfig;
  }): Promise<ComposedReply>;
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
    projectContext: string;
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

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
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

const INTENT_NAMES = new Set<IntentName>([
  'approve',
  'reject',
  'revise',
  'difficulty',
  'stop',
  'status',
  'summary',
  'accept',
  'note',
  'ask',
  'unknown',
]);

const ARTIFACT_NAMES = new Set<ArtifactName>([
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
  'agent-prompts',
  'agent-prompt-preview',
  'final-report',
]);

function intentResultFromContent(content: string): IntentResult {
  const payload = record(parseMaybeJson(content));
  const rawIntent = stringValue(payload.intent);
  const intent = rawIntent && INTENT_NAMES.has(rawIntent as IntentName)
    ? rawIntent as IntentName
    : 'unknown';
  const confidence = Math.max(0, Math.min(1, numberValue(payload.confidence) ?? 0));
  const difficulty = stringValue(payload.difficulty);
  const result: IntentResult = {
    intent,
    confidence,
    requiresClarification: booleanValue(payload.requiresClarification) ?? (intent === 'unknown' || confidence < 0.6),
    userFacingInterpretation: stringValue(payload.userFacingInterpretation) ?? '我还不确定你想让我怎么处理这条消息。',
  };
  if (difficulty === 'low' || difficulty === 'medium' || difficulty === 'high') result.difficulty = difficulty;
  const instruction = stringValue(payload.instruction);
  if (instruction) result.instruction = instruction;
  const note = stringValue(payload.note);
  if (note) result.note = note;
  const artifact = stringValue(payload.artifact);
  if (artifact && ARTIFACT_NAMES.has(artifact as ArtifactName)) result.artifact = artifact as ArtifactName;
  return result;
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
          interpretedIntent: stringValue(proposal.interpretedIntent) ?? stringValue(proposal.intent) ?? `整理成一个可能的 Manager workflow 任务：${title}`,
          title,
          task,
          wouldDo: stringArrayValue(proposal.wouldDo) ?? ['在你确认后，把建议的任务内容作为 workflow 输入。'],
          wouldNotDo: stringArrayValue(proposal.wouldNotDo) ?? ['不会在你确认前启动实现、规划或其他 agent 调用。'],
          suggestedNextAction: stringValue(proposal.suggestedNextAction) ?? '可以说「创建任务」确认，或继续补充修改。',
        },
      };
    }
  }
  if (kind === 'clarify') {
    return { kind: 'clarify', markdown: stringValue(payload.markdown) ?? content };
  }
  if (kind === 'confirm_pending_proposal' || kind === 'create_task' || kind === 'confirm') {
    const markdown = stringValue(payload.markdown);
    return { kind: 'confirm_pending_proposal', ...(markdown ? { markdown } : {}) };
  }
  if (kind === 'cancel_pending_proposal' || kind === 'cancel') {
    const markdown = stringValue(payload.markdown);
    return { kind: 'cancel_pending_proposal', ...(markdown ? { markdown } : {}) };
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
      throw new Error(`${apiKeyEnv} is required for Elon Ma agent calls.`);
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
      throw new Error(`DeepSeek Elon Ma request failed: HTTP ${response.status} ${responseText.slice(0, 500)}`);
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
          'You are Elon Ma, the agent for a local AI coding workflow.',
          'Your display name is Elon Ma. If asked your name, answer that you are Elon Ma; do not use old Manager-prefixed display names or generic assistant names.',
          'Return JSON only with keys markdown, needsUserDecision, and optional userPrompt.',
          'Ask the user only for product, logic, cost, UX, scope, or direction decisions.',
          'Never ask for low-level file/helper/test implementation permission.',
        ].join(' '),
      },
      { role: 'user', content: user },
    ], true);
    return managerTextFromContent(content);
  }

  async classifyIntent(input: {
    userMessage: string;
    state: TaskState;
    allowedActions: AllowedAction[];
    recentContext: string;
    config: ManagerConfig;
  }): Promise<IntentResult> {
    const content = await this.chat([
      {
        role: 'system',
        content: [
          '你是 Manager 工作流的对话意图分类器。',
          '状态机负责流程正确性；你只负责理解用户自然语言。',
          '只返回 JSON object，不要输出 markdown。',
          'JSON keys: intent, difficulty, instruction, note, artifact, confidence, requiresClarification, userFacingInterpretation.',
          'intent 必须是 allowedActions 里的 id；如果无法判断，用 unknown。',
          'difficulty 只在 intent=difficulty 时填写 low、medium 或 high。',
          'instruction 可以跟随任何会推动 workflow 的 intent，用来保留用户给后续 agent 的约束、原文使用要求、范围边界或修改要求；不要丢掉这些信息。',
          'note 只在 intent=note 时填写备注。',
          'artifact 可在用户要求查看、发送、解释或使用某个产物时填写；可选值包括 original-task、manager-brief、revised-plan、agent-prompts、agent-prompt-preview、final-report 等。',
          '如果用户想看“准备发给 Architect/Codex/Claude 的 prompt”，artifact 填 agent-prompt-preview，intent 通常填 ask。',
          '如果用户要求“直接用我原来的 prompt / 原封不动交给 Architect / 不要重写 brief”，在 brief 确认阶段通常是 approve，并把这条要求原样写进 instruction。',
          'confidence 是 0 到 1。',
          'requiresClarification=true 表示需要先问清楚，不能推动 workflow。',
          'userFacingInterpretation 必须是简短自然中文，用来告诉用户你理解成了什么。',
        ].join(' '),
      },
      {
        role: 'user',
        content: [
          `当前任务状态:\n${JSON.stringify({
            taskId: input.state.taskId,
            title: input.state.title,
            status: input.state.status,
            difficulty: input.state.difficulty,
            pendingUserPrompt: input.state.pendingUserPrompt,
            revisionRound: input.state.revisionRound,
            reviewerRunCount: input.state.reviewerRunCount,
          }, null, 2)}`,
          `当前允许动作:\n${JSON.stringify(input.allowedActions, null, 2)}`,
          `最近上下文:\n${input.recentContext}`,
          `用户消息:\n${input.userMessage}`,
        ].join('\n\n'),
      },
    ], true);
    return intentResultFromContent(content);
  }

  async composeReply(input: {
    rawMessage: string;
    state: TaskState;
    pendingPrompt?: string;
    userQuestion?: string;
    config: ManagerConfig;
  }): Promise<ComposedReply> {
    const content = await this.chat([
      {
        role: 'system',
        content: [
          '你是 Manager 的中文回复润色器。',
          '把 raw workflow result 改写成自然、简洁、中文优先的聊天回复。',
          '不要 dump Task ID / Status / Pending 这种状态块。',
          '不要暴露英文路由词或类似 "User explicitly selected" 的内部措辞。',
          '可以保留必要的 artifact 名称、命令名和英文技术名。',
          '必须尊重 workflow gate：如果状态在等待用户，就清楚告诉用户下一步能怎么说。',
          '不要声称状态机没有做过的事。',
        ].join(' '),
      },
      {
        role: 'user',
        content: [
          `任务状态:\n${JSON.stringify({
            title: input.state.title,
            status: input.state.status,
            difficulty: input.state.difficulty,
            pendingUserPrompt: input.pendingPrompt ?? input.state.pendingUserPrompt,
            revisionRound: input.state.revisionRound,
            reviewerRunCount: input.state.reviewerRunCount,
          }, null, 2)}`,
          input.userQuestion ? `用户问题:\n${input.userQuestion}` : undefined,
          `Raw workflow result:\n${input.rawMessage}`,
        ].filter(Boolean).join('\n\n'),
      },
    ]);
    return { text: content.trim() || input.rawMessage };
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
        content: [
          'Answer as Elon Ma using only the provided project, task, plan, review, Q&A, and decision context.',
          'Your display name is Elon Ma. If asked your name, answer that you are Elon Ma; do not use old Manager-prefixed display names or generic assistant names.',
          'Keep the answer clear and practical.',
        ].join(' '),
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
    projectContext: string;
    config: ManagerConfig;
  }): Promise<ControlChatResult> {
    const content = await this.chat([
      {
        role: 'system',
        content: [
          '你是未绑定 Lark control chat 里的 Elon Ma。',
          '如果用户问你是谁，回答你是 Elon Ma；不要使用旧的 Manager 前缀名字或泛泛的 assistant 名称。',
          '你首先是一个正常聊天助手：可以回答问题、解释概念、帮用户思考，也可以在用户要求时整理 prompt。',
          '默认使用简体中文回复。即使用户消息、prompt 或规格文档是英文，所有用户可见的解释、标签、确认语、下一步提示都必须是中文。',
          '可以保留必要的代码、命令、文件名、库名、产品名、英文原文片段；但不要用英文模板包装回复。',
          '用户可见 JSON 字段包括 markdown、proposal.interpretedIntent、proposal.title、proposal.task、proposal.wouldDo、proposal.wouldNotDo、proposal.suggestedNextAction，全部优先写中文。',
          '不要输出 "Based on your detailed specification"、"Intent"、"Suggested task prompt"、"Would do"、"Would not do"、"Suggested next action"、"Reply create task, edit, or cancel" 这类英文话术。',
          '使用提供的 project context 回答项目相关问题；如果 context 不足，就说检索到的上下文不够，不要声称直接读过文件系统。',
          '绝对不要创建或启动真实任务；你只能提出一份待确认的任务草案。',
          '只返回 JSON。',
          'Allowed kind values: answer, proposal, confirm_pending_proposal, cancel_pending_proposal, clarify.',
          '普通聊天或 prompt 整理返回 {"kind":"answer","markdown":"中文回复"}；除非用户明确描述了要交给 workflow 做的未来任务，否则不要创建 proposal。',
          '没有 pending proposal 时，不要把长 prompt 里的 confirm/create task/edit/cancel 当命令；正常回答，或仅在用户明确要 workflow 处理时创建 proposal。',
          '有 pending proposal 且用户明确想创建/确认时，返回 {"kind":"confirm_pending_proposal","markdown":"简短中文确认"}。',
          '有 pending proposal 且用户想取消时，返回 {"kind":"cancel_pending_proposal","markdown":"简短中文确认"}。',
          '有 pending proposal 且用户要求修改时，返回修订后的 {"kind":"proposal",...}。',
          '可能的 workflow 任务返回 {"kind":"proposal","markdown":"可选中文引导","proposal":{"interpretedIntent":"中文理解","title":"中文短标题","task":"中文任务内容；必要时保留英文技术名词或原文","wouldDo":["中文"],"wouldNotDo":["中文"],"suggestedNextAction":"可以说「创建任务」确认，或继续补充修改。"}}。',
          '意图不清楚时返回 {"kind":"clarify","markdown":"一个简短中文澄清问题"}。',
          '如果用户说不要创建任务、不要执行，或只是要 prompt，返回 kind=answer。',
        ].join(' '),
      },
      {
        role: 'user',
        content: [
          `Mode: ${input.mode}`,
          `Target workspace: ${input.config.workspace.targetDir}`,
          `Project context:\n${input.projectContext}`,
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

export function buildInitialPlanPrompt(input: {
  task: string;
  projectContext: string;
  brief: string;
  difficulty: WorkflowDifficulty;
  state: Pick<TaskState, 'requestedChanges'>;
}): string {
  return [
    'Act as the Architect. Create an initial implementation plan. Do not edit files.',
    'Every approved plan is one parent task. If decomposition is useful, describe execution units; otherwise treat it as one execution unit.',
    'Suggest exactly one lightweight Category if obvious. Supported categories are: Reader Core, Selection / Popup, Vocabulary Algorithm, Translation / LLM, Feedback / User Model, Storage / Persistence, Backend / API, Data / Dictionary Pipeline, Evaluation / Benchmark, Manager / Workflow, Docs / Task Record, UI / Frontend, Other.',
    'Do not create category folders or tags.',
    `Workflow difficulty: ${input.difficulty}`,
    `Project context:\n${input.projectContext}`,
    `Task:\n${input.task}`,
    `Manager brief:\n${input.brief}`,
    `User workflow directives and requested changes:\n${input.state.requestedChanges.join('\n\n') || 'none'}`,
    'When user workflow directives conflict with the Manager brief, follow the user workflow directives.',
    'End with a "Verification Commands" section listing only commands to run.',
  ].join('\n\n');
}

class CliHeavyAgentAdapter implements HeavyAgentAdapter {
  constructor(private readonly config: ManagerConfig) {}

  private async codex(prompt: string, profileName: string, role: WorkflowRoleName, config = this.config): Promise<string> {
    const profile = config.profiles[profileName];
    const command = profile?.command ?? 'codex';
    const sandbox = role === 'developer' ? 'danger-full-access' : 'read-only';
    const outputDir = await mkdtemp(join(tmpdir(), 'manager-codex-'));
    const outputPath = join(outputDir, 'last-message.md');
    try {
      const result = await runFile(command, [
        '-a',
        'never',
        'exec',
        '--color',
        'never',
        '--output-last-message',
        outputPath,
        '-C',
        config.workspace.targetDir,
        '--sandbox',
        sandbox,
        '--skip-git-repo-check',
        '-',
      ], config.workspace.targetDir, prompt);
      const lastMessage = await readFile(outputPath, 'utf8').catch(() => '');
      return sanitizeTextForArtifact(lastMessage.trim() || [result.stdout, result.stderr].filter(Boolean).join('\n'));
    } finally {
      await rm(outputDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async claude(prompt: string, profileName: string, config = this.config): Promise<string> {
    const profile = config.profiles[profileName];
    const command = profile?.command ?? 'claude';
    const result = await runFile(command, ['-p', '--permission-mode', 'bypassPermissions', '--add-dir', config.workspace.targetDir], config.workspace.targetDir, prompt);
    return sanitizeTextForArtifact([result.stdout, result.stderr].filter(Boolean).join('\n'));
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

  private agentPromptRecord(
    prompt: string,
    difficulty: WorkflowDifficulty,
    role: WorkflowRoleName,
    state: TaskState,
    config: ManagerConfig,
  ): AgentPromptRecord {
    const profileName = config.workflowRoles[difficulty][role];
    const profile = config.profiles[profileName];
    if (!profile) {
      throw new Error(`Workflow role ${difficulty}.${role} references missing profile ${profileName}.`);
    }
    return {
      taskId: state.taskId,
      role,
      difficulty,
      profileName,
      profileKind: profile.kind,
      createdAt: new Date().toISOString(),
      prompt,
    };
  }

  async createInitialPlan(input: { task: string; projectContext: string; brief: string; difficulty: WorkflowDifficulty; state: TaskState; config: ManagerConfig }): Promise<PlanResult> {
    const prompt = buildInitialPlanPrompt(input);
    const markdown = await this.runWorkflowRole(prompt, input.difficulty, 'architect', input.config);
    return {
      markdown,
      verificationCommands: extractVerificationCommands(markdown),
      planPackDraft: extractPlanPackDraft(markdown),
      agentPrompt: this.agentPromptRecord(prompt, input.difficulty, 'architect', input.state, input.config),
    };
  }

  async reviewPlan(input: { task: string; projectContext: string; initialPlan: string; difficulty: WorkflowDifficulty; state: TaskState; config: ManagerConfig }): Promise<ReviewResult> {
    const prompt = [
      'Act as the Plan Reviewer. Review this initial plan once. Focus on blocking bugs, risks, missing tests, product-impacting ambiguity, and whether any proposed execution-unit breakdown is coherent.',
      `Workflow difficulty: ${input.difficulty}`,
      `Project context:\n${input.projectContext}`,
      `Task:\n${input.task}`,
      `Initial plan:\n${input.initialPlan}`,
    ].join('\n\n');
    return {
      markdown: await this.runWorkflowRole(prompt, input.difficulty, 'planReviewer', input.config),
      agentPrompt: this.agentPromptRecord(prompt, input.difficulty, 'planReviewer', input.state, input.config),
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
    const prompt = [
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
    ].join('\n\n');
    const markdown = await this.runWorkflowRole(prompt, input.difficulty, 'architect', input.config);
    return {
      markdown,
      verificationCommands: extractVerificationCommands(markdown),
      planPackDraft: extractPlanPackDraft(markdown),
      agentPrompt: this.agentPromptRecord(prompt, input.difficulty, 'architect', input.state, input.config),
    };
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
    const prompt = [
      'Act as the Developer. Implement only the current execution unit from the approved parent-task plan.',
      `Project context:\n${input.projectContext}`,
      `Task:\n${input.task}`,
      `Approved revised plan:\n${input.revisedPlan}`,
      `User workflow directives and requested changes:\n${input.state.requestedChanges.join('\n\n') || 'none'}`,
      `Current execution unit:\nTask ${String(input.executionUnit.index).padStart(2, '0')}: ${input.executionUnit.name}`,
      'Do not revert unrelated user changes. Report changed files at the end.',
      'Run focused tests when practical and include the Test Result details for this execution unit.',
      'When reading Markdown or other text files, preserve UTF-8 text. On Windows PowerShell, use Get-Content -Raw -Encoding utf8 for file content, and keep command output free of ANSI color codes.',
    ].join('\n\n');
    const markdown = await this.runWorkflowRole(prompt, difficulty, 'developer', input.config);
    return {
      markdown,
      changedFiles: [],
      agentPrompt: this.agentPromptRecord(prompt, difficulty, 'developer', input.state, input.config),
    };
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
    const prompt = [
      'Act as the Final Reviewer. Review the whole parent task after all execution units are implemented. Do not review every subtask separately by default. Report blocking issues first.',
      `Project context:\n${input.projectContext}`,
      `Task:\n${input.task}`,
      `Approved revised plan:\n${input.revisedPlan}`,
      `Implementation log:\n${input.implementationLog}`,
      `Verification:\n${input.verificationLog}`,
    ].join('\n\n');
    const markdown = await this.runWorkflowRole(prompt, difficulty, 'finalReviewer', input.config);
    return {
      markdown,
      passed: !/\b(blocking|must fix|failed|regression)\b/i.test(markdown),
      agentPrompt: this.agentPromptRecord(prompt, difficulty, 'finalReviewer', input.state, input.config),
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
