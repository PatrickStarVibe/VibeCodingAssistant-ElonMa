#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

export * from '../../src/taskUsage.js';
import { summarizeTaskUsageFromCliArgs } from '../../src/taskUsage.js';

async function main(): Promise<void> {
  try {
    console.info(await summarizeTaskUsageFromCliArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
