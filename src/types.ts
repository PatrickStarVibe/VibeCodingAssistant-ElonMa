export type AgentProfileKind = string;

export type WorkflowDifficulty = 'low' | 'medium' | 'high';

export type IntentName =
  | 'approve'
  | 'reject'
  | 'revise'
  | 'difficulty'
  | 'stop'
  | 'status'
  | 'summary'
  | 'accept'
  | 'note'
  | 'restart'
  | 'ask'
  | 'unknown';

export interface AllowedAction {
  id: IntentName;
  description: string;
}

export interface IntentResult {
  intent: IntentName;
  difficulty?: WorkflowDifficulty;
  instruction?: string;
  note?: string;
  artifact?: ArtifactName;
  confidence: number;
  requiresClarification: boolean;
  userFacingInterpretation: string;
}

export type OrchestratorActionName =
  | 'respond'
  | 'approve_implementation'
  | 'forward_to_workflow'
  | 'show_artifact'
  | 'ask_clarification'
  | 'wait_for_user';

export interface OrchestratorRuleHint {
  intent: IntentName;
  reply: string;
  instruction?: string;
}

export interface OrchestratorDecision {
  action: OrchestratorActionName;
  intent?: IntentName;
  difficulty?: WorkflowDifficulty;
  instruction?: string;
  text?: string;
  artifact?: ArtifactName;
  question?: string;
  reason?: string;
  reasoning?: string;
  confidence: number;
  userConsentForContinuation?: boolean;
}

export interface OrchestratorDecisionInput {
  state: Pick<TaskState, 'taskId' | 'title' | 'status' | 'difficulty' | 'pendingUserPrompt' | 'revisionRound' | 'reviewerRunCount'>;
  allowedActions: AllowedAction[];
  requestedChanges: string[];
  recentDecisionLog: string;
  latestArtifactName?: ArtifactName;
  latestUserMessage: string;
  ruleHint?: OrchestratorRuleHint;
  previousActionInThisTurn?: OrchestratorDecision;
  rejectionReason?: string;
  config: AssistantConfig;
}

export type BridgeToolName =
  | 'reply_to_user'
  | 'create_task'
  | 'choose_difficulty'
  | 'approve_plan'
  | 'accept_task'
  | 'revise_plan'
  | 'stop_task'
  | 'ask_task_question'
  | 'show_status'
  | 'show_artifact'
  | 'switch_project'
  | 'add_project'
  | 'list_projects'
  | 'schedule_task_to_project_chat'
  | 'create_project_chat'
  | 'create_new_task_from_task_chat';

export interface BridgeToolCall {
  name: BridgeToolName;
  arguments: Record<string, unknown>;
  reasoning?: string;
}

export type BridgeAgentDecision =
  | { kind: 'reply'; text: string }
  | { kind: 'tool_call'; toolCall: BridgeToolCall };

export interface BridgeChatMemoryMessage {
  role: 'user' | 'assistant';
  text: string;
  at: string;
  messageId?: string;
  eventId?: string;
}

export interface BridgeChatSummary {
  summary: string;
  updatedAt: string;
  messageCountCovered: number;
}

export interface BridgeRetrievedMemorySnippet {
  source: string;
  heading?: string;
  text: string;
  score?: number;
}

export interface BridgeRetrievedMemory {
  query: string;
  projectId?: string;
  snippets: BridgeRetrievedMemorySnippet[];
}

export interface BridgeLiveProcessSnapshot {
  id: string;
  command: string;
  cwd: string;
  startedAt: string;
  elapsedMs: number;
  pid?: number;
  taskId?: string;
  role?: HeavyWorkflowRoleName;
  profileName?: string;
  label?: string;
  outputPath?: string;
  stdoutTail?: string;
  stderrTail?: string;
}

export interface BridgeAgentInput {
  latestUserMessage: string;
  chat: {
    chatId: string;
    senderOpenId: string;
    chatKind: 'control' | 'project';
    activeProjectId?: string;
    projectChat?: {
      projectId: string;
      name?: string;
      hasActiveTask: boolean;
    };
    boundTaskId?: string;
    canCreateTask: boolean;
  };
  projectChatsSummary?: Array<{
    chatId: string;
    projectId: string;
    idle: boolean;
    name?: string;
  }>;
  task?: Pick<TaskState, 'taskId' | 'title' | 'status' | 'difficulty' | 'pendingUserPrompt' | 'revisionRound' | 'reviewerRunCount' | 'requestedChanges'> & {
    generatedArtifacts?: ArtifactName[];
  };
  runningJob?: {
    taskId: string;
    label: string;
    startedAt: string;
  };
  liveProcesses?: BridgeLiveProcessSnapshot[];
  recentMessages?: BridgeChatMemoryMessage[];
  chatSummary?: BridgeChatSummary;
  retrievedMemory?: BridgeRetrievedMemory;
  projects: Array<Pick<ProjectConfig, 'id' | 'name'>>;
  config: AssistantConfig;
}

export interface ComposedReply {
  text: string;
}

export type HeavyWorkflowRoleName = 'architect' | 'planReviewer' | 'developer' | 'finalReviewer';

export type WorkflowRoleName = 'assistant' | HeavyWorkflowRoleName;

export type WorkflowRoleProfiles = {
  assistant: string;
} & Record<WorkflowDifficulty, Record<HeavyWorkflowRoleName, string>>;

export interface AgentPromptRecord {
  taskId: string;
  role: WorkflowRoleName;
  difficulty: WorkflowDifficulty;
  profileName: string;
  profileKind: AgentProfileKind;
  model?: string;
  effort?: string;
  createdAt: string;
  prompt: string;
}

export type TaskCategory =
  | 'Reader Core'
  | 'Selection / Popup'
  | 'Vocabulary Algorithm'
  | 'Translation / LLM'
  | 'Feedback / User Model'
  | 'Storage / Persistence'
  | 'Backend / API'
  | 'Data / Dictionary Pipeline'
  | 'Evaluation / Benchmark'
  | 'Assistant / Workflow'
  | 'Docs / Task Record'
  | 'UI / Frontend'
  | 'Other';

export type ExecutionMode = 'single' | 'decomposed';

export type ExecutionUnitStatus = 'Not Started' | 'In Progress' | 'Done' | 'Blocked';

export interface ExecutionUnitDraft {
  name: string;
  markdown?: string;
}

export interface PlanPackDraft {
  category?: string;
  summary?: string;
  executionUnits?: ExecutionUnitDraft[];
}

export interface ExecutionUnitState {
  index: number;
  slug: string;
  name: string;
  status: ExecutionUnitStatus;
  fileName: string;
  testResult?: string;
}

export interface AgentProfileConfig {
  kind: AgentProfileKind;
  provider?: string;
  model?: string;
  effort?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  command?: string;
}

export interface ProjectConfig {
  id: string;
  name: string;
  targetDir: string;
  docsDir: string;
  taskRecordRoot?: string;
  alwaysRead?: string[];
}

export interface AssistantConfig {
  workspace: {
    targetDir: string;
  };
  defaultProjectId?: string;
  projects?: ProjectConfig[];
  artifactsDir: string;
  lark: {
    platform: 'lark' | 'feishu';
    appIdEnv: string;
    appSecretEnv: string;
    allowedOpenIds: string[];
    taskMemberOpenIds: string[];
    controlChatIds: string[];
  };
  maxRevisionRounds: number;
  workflowRoles: WorkflowRoleProfiles;
  profiles: Record<string, AgentProfileConfig>;
  verification: {
    allowlist: string[];
  };
}

export type WorkflowStatus =
  | 'created'
  | 'awaiting_difficulty_selection'
  | 'planning_requested'
  | 'planning'
  | 'task_artifacts_persisting'
  | 'execution_queue_ready'
  | 'waiting_user_direction'
  | 'ready_for_decision'
  | 'implementation_approved'
  | 'implementing'
  | 'execution_unit_implementing'
  | 'execution_unit_testing'
  | 'execution_unit_result_recording'
  | 'next_execution_unit_or_all_done'
  | 'implemented'
  | 'final_reviewing'
  | 'final_review_routing'
  | 'awaiting_user_acceptance'
  | 'task_recording'
  | 'completed'
  | 'stopped';

export type ArtifactName =
  | 'original-task'
  | 'initial-plan'
  | 'review'
  | 'revision-instructions'
  | 'revised-plan'
  | 'assistant-explanation'
  | 'qa-log'
  | 'decision-log'
  | 'implementation-log'
  | 'git-pre-status'
  | 'git-post-status'
  | 'git-pre-diff'
  | 'git-post-diff'
  | 'test-build-log'
  | 'final-review'
  | 'agent-prompts'
  | 'agent-prompt-preview'
  | 'final-report';

export interface TaskState {
  taskId: string;
  title: string;
  projectId?: string;
  category: TaskCategory;
  status: WorkflowStatus;
  createdAt: string;
  updatedAt: string;
  revisionRound: number;
  reviewerRunCount: number;
  difficulty?: WorkflowDifficulty;
  executionMode?: ExecutionMode;
  executionQueue: ExecutionUnitState[];
  currentExecutionIndex?: number;
  approvedAt?: string;
  acceptedAt?: string;
  userAcceptanceNotes: string[];
  stoppedReason?: string;
  pendingUserPrompt?: string;
  lastDecision?: string;
  planSummary?: string;
  artifacts: Partial<Record<ArtifactName, string>>;
  requestedChanges: string[];
}

export interface PlanResult {
  markdown: string;
  verificationCommands: string[];
  planPackDraft?: PlanPackDraft;
  agentPrompt?: AgentPromptRecord;
}

export interface ReviewResult {
  markdown: string;
  agentPrompt?: AgentPromptRecord;
}

export interface ImplementationResult {
  markdown: string;
  changedFiles: string[];
  agentPrompt?: AgentPromptRecord;
}

export type FinalReviewRoute = 'complete' | 'route_to_implementer' | 'route_to_planner' | 'ask_user_direction';

export interface FinalReviewResult {
  markdown: string;
  passed: boolean;
  agentPrompt?: AgentPromptRecord;
}

export interface AssistantTextResult {
  markdown: string;
  needsUserDecision: boolean;
  userPrompt?: string;
}

export interface TaskProposal {
  interpretedIntent: string;
  title: string;
  task: string;
  wouldDo: string[];
  wouldNotDo: string[];
  suggestedNextAction: string;
}

export type ControlChatResult =
  | { kind: 'answer'; markdown: string }
  | { kind: 'proposal'; markdown?: string; proposal: TaskProposal }
  | { kind: 'confirm_pending_proposal'; markdown?: string }
  | { kind: 'cancel_pending_proposal'; markdown?: string }
  | { kind: 'clarify'; markdown: string };

export interface AssistantRouteResult {
  route: FinalReviewRoute;
  reason: string;
  userPrompt?: string;
}

export interface VerificationCommandResult {
  command: string;
  status: 'passed' | 'failed' | 'blocked' | 'skipped';
  output: string;
}

export interface GitSnapshot {
  statusShort: string;
  diff: string;
}
