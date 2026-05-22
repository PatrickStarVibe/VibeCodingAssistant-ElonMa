import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import type { ManagerConfig, TaskProposal, WorkflowStatus } from './types.js';

export interface LarkTaskBinding {
  taskId: string;
  title: string;
  createdAt: string;
}

export interface LarkRunningJob {
  taskId: string;
  label: string;
  startedAt: string;
  lastNotifiedAt?: string;
}

export interface LarkPendingTaskProposal extends TaskProposal {
  originalMessage: string;
  requesterOpenId: string;
  updatedAt: string;
}

export interface LarkBridgeState {
  pairingCode: string;
  pairedOpenIds: string[];
  activeProjectIdByChatId: Record<string, string>;
  bindingsByChatId: Record<string, LarkTaskBinding>;
  runningJobsByTaskId: Record<string, LarkRunningJob>;
  notifiedStatusByTaskId: Record<string, WorkflowStatus>;
  notifiedStatusAtByTaskId: Record<string, string>;
  lastReminderHashByTaskId: Record<string, string>;
  processedEventIds: string[];
  pendingProposalsByChatId: Record<string, LarkPendingTaskProposal>;
}

export class LarkBridgeStateStore {
  constructor(
    private readonly managerRoot: string,
    private readonly config: ManagerConfig,
  ) {}

  statePath(): string {
    return resolve(this.managerRoot, this.config.artifactsDir, 'lark-bridge-state.json');
  }

  async load(): Promise<LarkBridgeState> {
    try {
      return normalizeState(JSON.parse(await readFile(this.statePath(), 'utf8')) as unknown, this.config);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        const state = normalizeState(undefined, this.config);
        await this.save(state);
        return state;
      }
      throw error;
    }
  }

  async save(state: LarkBridgeState): Promise<void> {
    const path = this.statePath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  }
}

export function isAuthorizedOpenId(state: LarkBridgeState, config: ManagerConfig, openId: string): boolean {
  return config.lark.allowedOpenIds.includes(openId) || state.pairedOpenIds.includes(openId);
}

export function rememberEvent(state: LarkBridgeState, eventId: string): LarkBridgeState {
  const ids = [eventId, ...state.processedEventIds.filter((id) => id !== eventId)].slice(0, 200);
  return { ...state, processedEventIds: ids };
}

export function addPairedOpenId(state: LarkBridgeState, openId: string): LarkBridgeState {
  return state.pairedOpenIds.includes(openId)
    ? state
    : { ...state, pairedOpenIds: [...state.pairedOpenIds, openId] };
}

function normalizeState(raw: unknown, config: ManagerConfig): LarkBridgeState {
  const value = record(raw);
  return {
    pairingCode: config.lark.pairingCode ?? stringValue(value.pairingCode) ?? makePairingCode(),
    pairedOpenIds: stringArray(value.pairedOpenIds),
    activeProjectIdByChatId: recordOfStrings(value.activeProjectIdByChatId),
    bindingsByChatId: recordOfBindings(value.bindingsByChatId),
    runningJobsByTaskId: recordOfRunningJobs(value.runningJobsByTaskId),
    notifiedStatusByTaskId: recordOfStatuses(value.notifiedStatusByTaskId),
    notifiedStatusAtByTaskId: recordOfStrings(value.notifiedStatusAtByTaskId),
    lastReminderHashByTaskId: recordOfStrings(value.lastReminderHashByTaskId),
    processedEventIds: stringArray(value.processedEventIds).slice(0, 200),
    pendingProposalsByChatId: recordOfPendingProposals(value.pendingProposalsByChatId),
  };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0) : [];
}

function recordOfStrings(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(record(value)).flatMap(([key, entry]) => (
    typeof entry === 'string' && entry.trim() ? [[key, entry]] : []
  )));
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
  return [];
}

function recordOfBindings(value: unknown): Record<string, LarkTaskBinding> {
  return Object.fromEntries(Object.entries(record(value)).flatMap(([chatId, rawBinding]) => {
    const binding = record(rawBinding);
    const taskId = stringValue(binding.taskId);
    const title = stringValue(binding.title);
    const createdAt = stringValue(binding.createdAt);
    return taskId && title && createdAt ? [[chatId, { taskId, title, createdAt }]] : [];
  }));
}

function recordOfRunningJobs(value: unknown): Record<string, LarkRunningJob> {
  return Object.fromEntries(Object.entries(record(value)).flatMap(([taskId, rawJob]) => {
    const job = record(rawJob);
    const label = stringValue(job.label);
    const startedAt = stringValue(job.startedAt);
    const lastNotifiedAt = stringValue(job.lastNotifiedAt);
    return label && startedAt ? [[taskId, { taskId, label, startedAt, ...(lastNotifiedAt ? { lastNotifiedAt } : {}) }]] : [];
  }));
}

function recordOfStatuses(value: unknown): Record<string, WorkflowStatus> {
  return Object.fromEntries(Object.entries(record(value)).flatMap(([taskId, status]) => (
    isWorkflowStatus(status) ? [[taskId, status]] : []
  )));
}

function recordOfPendingProposals(value: unknown): Record<string, LarkPendingTaskProposal> {
  return Object.fromEntries(Object.entries(record(value)).flatMap(([chatId, rawProposal]) => {
    const proposal = record(rawProposal);
    const interpretedIntent = stringValue(proposal.interpretedIntent);
    const title = stringValue(proposal.title);
    const task = stringValue(proposal.task);
    const suggestedNextAction = stringValue(proposal.suggestedNextAction);
    const originalMessage = stringValue(proposal.originalMessage);
    const requesterOpenId = stringValue(proposal.requesterOpenId);
    const updatedAt = stringValue(proposal.updatedAt);
    if (!interpretedIntent || !title || !task || !suggestedNextAction || !originalMessage || !requesterOpenId || !updatedAt) {
      return [];
    }
    return [[chatId, {
      interpretedIntent,
      title,
      task,
      wouldDo: stringList(proposal.wouldDo),
      wouldNotDo: stringList(proposal.wouldNotDo),
      suggestedNextAction,
      originalMessage,
      requesterOpenId,
      updatedAt,
    }]];
  }));
}

function isWorkflowStatus(value: unknown): value is WorkflowStatus {
  return typeof value === 'string' && [
    'created',
    'briefing',
    'awaiting_brief_confirmation',
    'awaiting_difficulty_selection',
    'planning_requested',
    'planning',
    'task_artifacts_persisting',
    'execution_queue_ready',
    'waiting_user_direction',
    'ready_for_decision',
    'implementation_approved',
    'implementing',
    'execution_unit_implementing',
    'execution_unit_testing',
    'execution_unit_result_recording',
    'next_execution_unit_or_all_done',
    'implemented',
    'final_reviewing',
    'final_review_routing',
    'awaiting_user_acceptance',
    'task_recording',
    'completed',
    'stopped',
  ].includes(value);
}

function makePairingCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}
