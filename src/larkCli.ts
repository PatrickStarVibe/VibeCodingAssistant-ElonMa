#!/usr/bin/env node

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ArtifactStore } from './artifacts.js';
import { BridgeAgentService } from './bridgeAgent.js';
import { createHeavyAgentAdapter, createAssistantAdapter, type AssistantAdapter } from './adapters.js';
import { getDefaultAssistantRoot, loadConfig } from './config.js';
import { LarkTransport } from './larkBridge.js';
import { LarkBridgeStateStore } from './larkBridgeState.js';
import { LarkSdkClient } from './larkSdkClient.js';
import { ProjectKnowledgeService } from './projectKnowledge.js';
import type { AssistantConfig } from './types.js';
import { WorkflowService } from './workflow.js';

interface LarkCliOptions {
  configPath: string | undefined;
  stubHeavyAgents: boolean;
}

function parseCli(argv: string[]): LarkCliOptions {
  let configPath: string | undefined;
  let stubHeavyAgents = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--config') {
      configPath = argv[index + 1];
      index += 1;
    } else if (arg === '--stub-heavy-agents') {
      stubHeavyAgents = true;
    }
  }
  return { configPath, stubHeavyAgents };
}

export function createBridgeAgentService(
  assistantRoot: string,
  workflow: WorkflowService,
  store: ArtifactStore,
  assistant: AssistantAdapter,
  config: AssistantConfig,
): BridgeAgentService {
  return new BridgeAgentService(
    workflow,
    store,
    assistant,
    config,
    new ProjectKnowledgeService(assistantRoot),
  );
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseCli(argv);
  const assistantRoot = getDefaultAssistantRoot();
  const config = await loadConfig(assistantRoot, options.configPath);
  const store = new ArtifactStore(assistantRoot, config);
  const assistant = createAssistantAdapter(config);
  const workflow = new WorkflowService(
    store,
    config,
    assistant,
    createHeavyAgentAdapter(config, !options.stubHeavyAgents),
  );
  const bridgeAgent = createBridgeAgentService(assistantRoot, workflow, store, assistant, config);
  const transport = new LarkTransport(
    config,
    store,
    new LarkSdkClient(config),
    bridgeAgent,
    new LarkBridgeStateStore(assistantRoot, config),
  );

  await transport.start();
  process.once('SIGINT', () => {
    transport.stop();
    process.exit(0);
  });
  process.once('SIGTERM', () => {
    transport.stop();
    process.exit(0);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
