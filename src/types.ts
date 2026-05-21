export type RoleName = 'manager' | 'planner' | 'reviewer' | 'implementer' | 'finalReviewer';

export type AgentProfileKind = 'deepseek' | 'codex' | 'claude' | 'stub';

export type WorkflowDifficulty = 'low' | 'medium' | 'high';

export type WorkflowRoleName = 'architect' | 'planReviewer' | 'developer' | 'finalReviewer';

export type WorkflowRoleProfiles = Record<WorkflowDifficulty, Record<WorkflowRoleName, string>>;

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
  | 'Manager / Workflow'
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
  model?: string;
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

export interface ManagerConfig {
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
    watchIntervalSeconds: number;
    pairingCode?: string;
  };
  maxRevisionRounds: number;
  roles: Record<RoleName, string>;
  workflowRoles: WorkflowRoleProfiles;
  profiles: Record<string, AgentProfileConfig>;
  verification: {
    allowlist: string[];
  };
}

export type WorkflowStatus =
  | 'created'
  | 'briefing'
  | 'awaiting_brief_confirmation'
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
  | 'manager-brief'
  | 'initial-plan'
  | 'review'
  | 'revision-instructions'
  | 'revised-plan'
  | 'manager-explanation'
  | 'qa-log'
  | 'decision-log'
  | 'implementation-log'
  | 'git-pre-status'
  | 'git-post-status'
  | 'git-pre-diff'
  | 'git-post-diff'
  | 'test-build-log'
  | 'final-review'
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
  briefConfirmed: boolean;
  briefRevisionRequests: string[];
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
}

export interface ReviewResult {
  markdown: string;
}

export interface ImplementationResult {
  markdown: string;
  changedFiles: string[];
}

export type FinalReviewRoute = 'complete' | 'route_to_implementer' | 'route_to_planner' | 'ask_user_direction';

export interface FinalReviewResult {
  markdown: string;
  passed: boolean;
}

export interface ManagerTextResult {
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
  | { kind: 'clarify'; markdown: string };

export interface ManagerRouteResult {
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
