import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import type { HarnessPlugin } from './plugins.js';
import { assertHarnessPlugin } from './plugins.js';

/** Loads a user plugin module. It may default-export the plugin or export `plugin`. */
export async function loadHarnessPlugin(modulePath: string): Promise<HarnessPlugin> {
  const loaded = await import(pathToFileURL(resolve(modulePath)).href) as { default?: unknown; plugin?: unknown };
  const candidate = loaded.default ?? loaded.plugin;
  assertHarnessPlugin(candidate);
  return candidate;
}
