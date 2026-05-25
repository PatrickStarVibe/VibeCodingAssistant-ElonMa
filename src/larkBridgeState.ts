import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import type { AssistantConfig } from './types.js';

export interface ProjectChatRegistration {
  chatId: string;
  projectId: string;
  name?: string;
  activeTaskId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ActiveTaskBinding {
  chatId: string;
  taskId: string;
  title: string;
  startedAt: string;
}

export interface LarkRunningJob {
  taskId: string;
  label: string;
  startedAt: string;
}

export interface LarkBridgeState {
  projectChatsByChatId: Record<string, ProjectChatRegistration>;
  activeTaskByChatId: Record<string, ActiveTaskBinding>;
  activeProjectIdByChatId: Record<string, string>;
  runningJobsByTaskId: Record<string, LarkRunningJob>;
  processedEventIds: string[];
}

interface LegacyTaskBinding {
  taskId: string;
  title: string;
  createdAt: string;
  projectId?: string;
}

export class LarkBridgeStateStore {
  constructor(
    private readonly assistantRoot: string,
    private readonly config: AssistantConfig,
  ) {}

  statePath(): string {
    return resolve(this.assistantRoot, this.config.artifactsDir, 'lark-bridge-state.json');
  }

  async load(): Promise<LarkBridgeState> {
    try {
      const raw = JSON.parse(await readFile(this.statePath(), 'utf8')) as unknown;
      const state = normalizeState(raw);
      if (hasLegacyOrUnknownKeys(raw)) {
        await this.save(state);
      }
      return state;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        const state = normalizeState(undefined);
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

export function isAuthorizedOpenId(config: AssistantConfig, openId: string): boolean {
  return config.lark.allowedOpenIds.includes(openId);
}

export function rememberEvent(state: LarkBridgeState, eventId: string): LarkBridgeState {
  const ids = [eventId, ...state.processedEventIds.filter((id) => id !== eventId)].slice(0, 200);
  return { ...state, processedEventIds: ids };
}

export function listProjectChats(state: LarkBridgeState, projectId: string): ProjectChatRegistration[] {
  return Object.values(state.projectChatsByChatId)
    .filter((chat) => chat.projectId === projectId)
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
}

export function findIdleProjectChat(state: LarkBridgeState, projectId: string): ProjectChatRegistration | undefined {
  return listProjectChats(state, projectId)
    .find((chat) => !chat.activeTaskId && !state.activeTaskByChatId[chat.chatId]);
}

export function registerProjectChat(
  state: LarkBridgeState,
  input: { chatId: string; projectId: string; name?: string; now?: string },
): ProjectChatRegistration {
  const now = input.now ?? new Date().toISOString();
  const existing = state.projectChatsByChatId[input.chatId];
  const name = input.name ?? existing?.name;
  const registration: ProjectChatRegistration = {
    chatId: input.chatId,
    projectId: input.projectId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  if (name) registration.name = name;
  if (existing?.activeTaskId) registration.activeTaskId = existing.activeTaskId;
  state.projectChatsByChatId[input.chatId] = registration;
  return registration;
}

export function bindTaskToProjectChat(
  state: LarkBridgeState,
  chatId: string,
  task: { taskId: string; title: string; projectId: string; chatName?: string; now?: string },
): void {
  const now = task.now ?? new Date().toISOString();
  const existing = state.projectChatsByChatId[chatId];
  const name = task.chatName ?? existing?.name;
  const registration: ProjectChatRegistration = {
    chatId,
    projectId: existing?.projectId ?? task.projectId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    activeTaskId: task.taskId,
  };
  if (name) registration.name = name;
  state.projectChatsByChatId[chatId] = registration;
  state.activeTaskByChatId[chatId] = {
    chatId,
    taskId: task.taskId,
    title: task.title,
    startedAt: now,
  };
}

export function releaseProjectChatTask(
  state: LarkBridgeState,
  chatId: string,
  taskId?: string,
): void {
  const registration = state.projectChatsByChatId[chatId];
  const activeTask = state.activeTaskByChatId[chatId];
  const activeTaskId = taskId ?? activeTask?.taskId ?? registration?.activeTaskId;
  if (activeTaskId) {
    delete state.runningJobsByTaskId[activeTaskId];
  }
  if (activeTask && (!taskId || activeTask.taskId === taskId)) {
    delete state.activeTaskByChatId[chatId];
  }
  if (registration && (!taskId || registration.activeTaskId === taskId || activeTask?.taskId === taskId)) {
    const { activeTaskId: _activeTaskId, ...rest } = registration;
    state.projectChatsByChatId[chatId] = {
      ...rest,
      updatedAt: new Date().toISOString(),
    };
  }
}

function normalizeState(raw: unknown): LarkBridgeState {
  const value = record(raw);
  const activeProjectIdByChatId = recordOfStrings(value.activeProjectIdByChatId);
  const projectChatsByChatId = recordOfProjectChats(value.projectChatsByChatId);
  const activeTaskByChatId = recordOfActiveTasks(value.activeTaskByChatId);
  const legacyBindings = recordOfLegacyBindings(value.bindingsByChatId);

  for (const [chatId, binding] of Object.entries(legacyBindings)) {
    const projectId = binding.projectId ?? activeProjectIdByChatId[chatId];
    if (!projectId || projectChatsByChatId[chatId]) continue;
    projectChatsByChatId[chatId] = {
      chatId,
      projectId,
      activeTaskId: binding.taskId,
      createdAt: binding.createdAt,
      updatedAt: binding.createdAt,
    };
    activeTaskByChatId[chatId] = {
      chatId,
      taskId: binding.taskId,
      title: binding.title,
      startedAt: binding.createdAt,
    };
  }

  return {
    projectChatsByChatId,
    activeTaskByChatId,
    activeProjectIdByChatId,
    runningJobsByTaskId: recordOfRunningJobs(value.runningJobsByTaskId),
    processedEventIds: stringArray(value.processedEventIds).slice(0, 200),
  };
}

function hasLegacyOrUnknownKeys(raw: unknown): boolean {
  const allowed = new Set([
    'projectChatsByChatId',
    'activeTaskByChatId',
    'activeProjectIdByChatId',
    'runningJobsByTaskId',
    'processedEventIds',
  ]);
  const keys = Object.keys(record(raw));
  return keys.some((key) => !allowed.has(key)) || keys.includes('bindingsByChatId');
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

function recordOfProjectChats(value: unknown): Record<string, ProjectChatRegistration> {
  return Object.fromEntries(Object.entries(record(value)).flatMap(([chatId, rawChat]) => {
    const chat = record(rawChat);
    const projectId = stringValue(chat.projectId);
    const createdAt = stringValue(chat.createdAt);
    const updatedAt = stringValue(chat.updatedAt);
    if (!projectId || !createdAt || !updatedAt) return [];
    const name = stringValue(chat.name);
    const activeTaskId = stringValue(chat.activeTaskId);
    return [[chatId, {
      chatId: stringValue(chat.chatId) ?? chatId,
      projectId,
      ...(name ? { name } : {}),
      ...(activeTaskId ? { activeTaskId } : {}),
      createdAt,
      updatedAt,
    }]];
  }));
}

function recordOfActiveTasks(value: unknown): Record<string, ActiveTaskBinding> {
  return Object.fromEntries(Object.entries(record(value)).flatMap(([chatId, rawBinding]) => {
    const binding = record(rawBinding);
    const taskId = stringValue(binding.taskId);
    const title = stringValue(binding.title);
    const startedAt = stringValue(binding.startedAt);
    return taskId && title && startedAt
      ? [[chatId, { chatId: stringValue(binding.chatId) ?? chatId, taskId, title, startedAt }]]
      : [];
  }));
}

function recordOfLegacyBindings(value: unknown): Record<string, LegacyTaskBinding> {
  return Object.fromEntries(Object.entries(record(value)).flatMap(([chatId, rawBinding]) => {
    const binding = record(rawBinding);
    const taskId = stringValue(binding.taskId);
    const title = stringValue(binding.title);
    const createdAt = stringValue(binding.createdAt);
    const projectId = stringValue(binding.projectId);
    return taskId && title && createdAt
      ? [[chatId, { taskId, title, createdAt, ...(projectId ? { projectId } : {}) }]]
      : [];
  }));
}

function recordOfRunningJobs(value: unknown): Record<string, LarkRunningJob> {
  return Object.fromEntries(Object.entries(record(value)).flatMap(([taskId, rawJob]) => {
    const job = record(rawJob);
    const label = stringValue(job.label);
    const startedAt = stringValue(job.startedAt);
    return label && startedAt ? [[taskId, { taskId, label, startedAt }]] : [];
  }));
}
