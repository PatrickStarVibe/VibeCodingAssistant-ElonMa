#!/usr/bin/env node

import { ArtifactStore } from './artifacts.js';
import { createHeavyAgentAdapter, createManagerAdapter } from './adapters.js';
import { getDefaultManagerRoot, loadConfig } from './config.js';
import { ManagerConversationService } from './conversation.js';
import { LarkBridge } from './larkBridge.js';
import { LarkBridgeStateStore } from './larkBridgeState.js';
import { LarkSdkClient } from './larkSdkClient.js';
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

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  const managerRoot = getDefaultManagerRoot();
  const config = await loadConfig(managerRoot, options.configPath);
  const store = new ArtifactStore(managerRoot, config);
  const manager = createManagerAdapter(config);
  const workflow = new WorkflowService(
    store,
    config,
    manager,
    createHeavyAgentAdapter(config, !options.stubHeavyAgents),
  );
  const conversation = new ManagerConversationService(workflow, store, manager, config);
  const bridge = new LarkBridge(
    config,
    store,
    new LarkSdkClient(config),
    conversation,
    new LarkBridgeStateStore(managerRoot, config),
  );

  await bridge.start();
  process.once('SIGINT', () => {
    bridge.stop();
    process.exit(0);
  });
  process.once('SIGTERM', () => {
    bridge.stop();
    process.exit(0);
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
