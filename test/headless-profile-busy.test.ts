import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionUIContext } from '@earendil-works/pi-coding-agent';
import optchat from '../src/index.ts';
import { createProfile, loadConfig, lockProfile, profilePath, profileSocket, saveConfig, SOCKET_PATH_LIMIT } from '../src/profiles.ts';

const agentDir = process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'optchat-headless-agent-'));
after(() => rmSync(agentDir, { recursive: true, force: true }));

async function start(dir: string, mode: 'print' | 'rpc', bound?: string, uiOverride?: (ctx: ExtensionUIContext) => ExtensionUIContext) {
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null,
    modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
  runtime.registerProvider('fixture', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
  });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager,
    noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, extensionFactories: [optchat] });
  await loader.reload();
  const manager = SessionManager.create(dir, join(dir, 'sessions'));
  if (bound) manager.appendCustomEntry('optchat.profile', { name: bound });
  const { session } = await createAgentSession({ modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'),
    resourceLoader: loader, settingsManager, sessionManager: manager, tools: ['zoom'] });
  const errors: string[] = [], notifications: string[] = [];
  const base: ExtensionUIContext = { ...session.extensionRunner.getUIContext(),
    notify: (text, type) => { notifications.push(text); if (type === 'error') errors.push(text); } };
  const uiContext: ExtensionUIContext = uiOverride ? uiOverride(base) : base;
  await session.bindExtensions({ uiContext, mode });
  return { session, errors, notifications, manager };
}

test('a headless session whose profile is busy degrades to a plain session instead of faulting', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-headless-'));
  const oldHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = join(dir, 'home');
  let session: Awaited<ReturnType<typeof start>>['session'] | undefined;
  let unlock: (() => Promise<void>) | undefined;
  try {
    createProfile('busy');
    const config = loadConfig(profilePath('busy'));
    saveConfig(profilePath('busy'), { ...config, compactor: { provider: 'fixture', model: 'fixture', thinking: 'off' }, subagent: { provider: 'fixture', model: 'fixture', thinking: 'off' } });
    unlock = await lockProfile(profilePath('busy'), 'busy · PID 1 · elsewhere');

    // Headless mode (detached runner / pi -p): no ui.select is possible, so a busy
    // profile must degrade instead of throwing out of session_start. Before the fix
    // this faulted the session and the runner's prompt was aborted.
    const headless = await start(dir, 'print', 'busy');
    session = headless.session;
    assert.deepEqual(headless.errors, [], 'session_start must not fault when the profile is busy in headless mode');
    assert.deepEqual(headless.notifications, [], 'no noise expected either');

    // Sanity: in tui mode the same situation still faults (covered in profile-busy.test.ts).

    // The degraded session is not bound to the busy profile and stays usable.
    const bindings = headless.manager.getEntries().filter(e => e.type === 'custom' && e.customType === 'optchat.profile');
    assert.deepEqual(bindings.map(e => (e as any).data), [{ name: 'busy' }], 'the pre-set binding stays; degradation must not add or change bindings: ' + JSON.stringify(bindings));
    const title = headless.session.extensionRunner.getUIContext();
    assert.ok(title, 'extension ui context survives degradation');

    // RPC mode (pi-acp / IDE hosts) carries a real uiContext, so hasUI is true —
    // but a blocking ui.select there hangs the host. It must take the automatic
    // fallback instead of prompting.
    const noSelect = (ctx: ExtensionUIContext): ExtensionUIContext => ({ ...ctx,
      select: async () => { throw new Error('blocking ui.select must not be called in rpc mode'); } });
    const rpcBusy = await start(dir, 'rpc', 'busy', noSelect);
    session = rpcBusy.session;
    assert.deepEqual(rpcBusy.errors, [], 'a busy profile must degrade in rpc mode too, not fault or prompt');

    const rpcUnlocked = await start(dir, 'rpc', undefined, noSelect);
    session = rpcUnlocked.session;
    assert.deepEqual(rpcUnlocked.errors, [], 'rpc session with a single unlocked profile must auto-select it, not fault');
  } finally {
    if (session) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
    await unlock?.();
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

