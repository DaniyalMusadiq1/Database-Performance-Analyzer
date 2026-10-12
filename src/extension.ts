import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { serialize, deserialize } from 'node:v8';
import { runtimeIssue } from './compatibility';
import { collect, explain } from './adapters';
import { Profile, Options, Snapshot } from './types';
import { detectEngine, redactError, targetOf, validateUri, validateSql } from './security';
import { inspectFiles } from './discovery';
import { dashboardHtml } from './view';
import { compareSnapshots } from './analysis';
import { exportSnapshot } from './reports';
import { SnapshotHistory, chartHistory } from './history';
import { CancelledError, throwIfAborted } from './lifecycle';
import { loadProfiles, SerialQueue } from './profiles';
import { settingNumber } from './settings';
import {
  buildConnectionUri,
  defaultConnectionTls,
  connectionFailure,
  connectionDefaults,
  NetworkEngine,
  connectionFields,
  preserveConnectionOptions,
} from './connection';
class ConnectionTree implements vscode.TreeDataProvider<vscode.TreeItem> {
  private changed = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  onDidChangeTreeData = this.changed.event;
  constructor(private getProfiles: () => Profile[]) {}
  refresh() {
    this.changed.fire(undefined);
  }
  dispose() {
    this.changed.dispose();
  }
  getTreeItem(item: vscode.TreeItem) {
    return item;
  }
  getChildren() {
    const actions = [
      {
        label: 'Open dashboard',
        command: 'dbPerf.open',
        icon: 'dashboard',
        tooltip: 'Open your performance dashboard without the Command Palette.',
      },
      {
        label: 'Add a connection',
        command: 'dbPerf.add',
        icon: 'add',
        tooltip:
          'Choose guided setup, local defaults, a URL, project detection or a SQLite file. Requires workspace trust.',
      },
      {
        label: 'Detect project databases',
        command: 'dbPerf.detect',
        icon: 'search',
        tooltip:
          'Find database configuration and models in this project. Requires workspace trust.',
      },
      {
        label: 'Explore demo',
        command: 'dbPerf.demo',
        icon: 'beaker',
        tooltip: 'Try the dashboard with synthetic data; no database or workspace trust is needed.',
      },
    ].map((action) => {
      const item = new vscode.TreeItem(action.label);
      item.id = action.command;
      item.contextValue = 'dashboardAction';
      item.iconPath = new vscode.ThemeIcon(action.icon);
      item.tooltip = action.tooltip;
      item.command = { command: action.command, title: action.label };
      return item;
    });
    const connections = this.getProfiles().map((p) => {
      const item = new vscode.TreeItem(p.name);
      item.id = p.id;
      item.description = p.engine;
      item.tooltip = `${p.name}\n${p.engine} · ${p.target}`;
      item.iconPath = new vscode.ThemeIcon(p.engine === 'demo' ? 'beaker' : 'database');
      item.contextValue = p.engine === 'demo' ? 'demo' : 'database';
      item.command = { command: 'dbPerf.open', title: 'Open Dashboard', arguments: [p.id] };
      return item;
    });
    return [...actions, ...connections];
  }
}
export function activate(context: vscode.ExtensionContext) {
  let profiles = loadProfiles(context.globalState.get<unknown>('profiles', []));
  const profileChanges = new SerialQueue();
  let panel: vscode.WebviewPanel | undefined;
  let selected: string | undefined;
  let monitoring: NodeJS.Timeout | undefined;
  let nextRefreshAt: number | undefined;
  let controller: AbortController | undefined;
  let busy = false;
  let connecting = false;
  let disposed = false;
  let baseline: Snapshot | undefined;
  let current: Snapshot | undefined;
  let refreshError: string | undefined;
  const history = new SnapshotHistory();
  const output = vscode.window.createOutputChannel('Database Performance Analyzer');
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
  status.text = '$(database) DB Performance';
  status.command = 'dbPerf.open';
  status.tooltip = 'Open Database Performance Analyzer';
  status.show();
  const demo: Profile = {
    id: 'demo',
    name: 'Commerce demo',
    engine: 'demo',
    target: 'Synthetic sample',
    tls: false,
    createdAt: '',
  };
  const all = () => [...profiles, demo];
  const tree = new ConnectionTree(() => profiles);
  context.subscriptions.push(
    tree,
    output,
    status,
    vscode.window.registerTreeDataProvider('dbPerf.connections', tree),
  );
  const post = (m: unknown) => {
    if (!disposed && panel) void panel.webview.postMessage(m);
  };
  const monitoringSeconds = () =>
    settingNumber(
      vscode.workspace.getConfiguration('dbPerf').get('refreshIntervalSeconds'),
      30,
      5,
      300,
      true,
    );
  const sendLive = () =>
    post({
      type: 'live',
      value: !!monitoring,
      intervalSeconds: monitoringSeconds(),
      nextRefreshInMs: monitoring && nextRefreshAt ? Math.max(0, nextRefreshAt - Date.now()) : null,
    });
  const sendProfiles = (reset = false) =>
    post({
      type: 'profiles',
      profiles: all().map((p) => ({
        id: p.id,
        name: p.name,
        engine: p.engine,
        target: p.target,
        tls: p.tls,
        unavailable: runtimeIssue(p.engine),
      })),
      selected,
      recent: context.globalState.get<string>('lastConnection'),
      reset,
      trusted: vscode.workspace.isTrusted,
      slowQueryMs: options().slowQueryMs,
      intervalSeconds: monitoringSeconds(),
      runtimeNode: process.versions.node,
    });
  const options = (): Options => {
    const c = vscode.workspace.getConfiguration('dbPerf');
    return {
      timeoutMs: settingNumber(c.get('queryTimeoutMs'), 10000, 1000, 60000, true),
      slowQueryMs: settingNumber(c.get('slowQueryMs'), 100, 1, 3600000),
      wasmPath: vscode.Uri.joinPath(context.extensionUri, 'dist', 'sql-wasm.wasm').fsPath,
      sqliteWorkerPath: vscode.Uri.joinPath(context.extensionUri, 'dist', 'sqlite-worker.js')
        .fsPath,
      signal: controller?.signal,
    };
  };
  const trust = () => {
    if (!vscode.workspace.isTrusted)
      throw new Error(
        'Trust this workspace before connecting to databases or inspecting project configuration.',
      );
  };
  const stop = () => {
    if (monitoring) clearInterval(monitoring);
    monitoring = undefined;
    nextRefreshAt = undefined;
    sendLive();
  };
  const cancel = () => {
    stop();
    controller?.abort(new CancelledError());
  };
  const getProfile = () => all().find((p) => p.id === selected);
  async function operation<T>(
    label: string,
    fn: (p: Profile, uri: string) => Promise<T>,
  ): Promise<T | undefined> {
    if (busy) return;
    const p = getProfile();
    if (!p) {
      post({ type: 'error', message: 'Choose a connection first.' });
      return;
    }
    if (p.engine !== 'demo') trust();
    busy = true;
    controller = new AbortController();
    const activeController = controller;
    post({ type: 'busy', value: true });
    status.text = '$(sync~spin) DB Performance';
    let uri = '';
    try {
      uri = p.engine === 'demo' ? '' : ((await context.secrets.get('dbPerf.uri.' + p.id)) ?? '');
      if (!uri && p.engine !== 'demo')
        throw new Error(
          'Connection URL is missing from secret storage. Use Update Connection URL.',
        );
      throwIfAborted(activeController.signal);
      const result = await fn(p, uri);
      if (activeController.signal.aborted || disposed) return;
      return result;
    } catch (e) {
      const message = redactError(e, uri);
      if (label === 'Refresh') refreshError = message;
      post({ type: 'error', message, stale: label === 'Refresh' });
      output.appendLine(`${new Date().toISOString()} ${label}: ${message}`);
      if (monitoring) stop();
      return;
    } finally {
      busy = false;
      controller = undefined;
      status.text = '$(database) DB Performance';
      post({ type: 'busy', value: false });
    }
  }
  async function refresh() {
    const id = selected;
    const s = await operation('Refresh', async (p, uri) => collect(p, uri, options()));
    if (!s || id !== selected) return;
    current = s;
    refreshError = undefined;
    const max = settingNumber(
      vscode.workspace.getConfiguration('dbPerf').get('maxHistory'),
      60,
      5,
      300,
      true,
    );
    const h = history.add(id!, s, max);
    post({ type: 'snapshot', snapshot: s, history: chartHistory(h) });
    if (baseline) post({ type: 'comparison', comparison: compareSnapshots(baseline, s) });
  }
  async function open(id?: string) {
    if (!panel) {
      panel = vscode.window.createWebviewPanel(
        'dbPerf.dashboard',
        'Database Performance',
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
        },
      );
      panel.webview.html = dashboardHtml(panel.webview, context.extensionUri);
      panel.onDidDispose(
        () => {
          panel = undefined;
          stop();
          cancel();
        },
        undefined,
        context.subscriptions,
      );
      panel.onDidChangeViewState(
        (e) => {
          if (!e.webviewPanel.visible) stop();
        },
        undefined,
        context.subscriptions,
      );
      panel.webview.onDidReceiveMessage(
        async (m: unknown) => {
          if (!m || typeof m !== 'object') return;
          const v = m as Record<string, unknown>;
          try {
            switch (v.type) {
              case 'ready':
                sendProfiles();
                post({ type: 'busy', value: busy });
                sendLive();
                post({ type: 'baselineState', timestamp: baseline?.timestamp ?? null });
                if (current)
                  post({
                    type: 'snapshot',
                    snapshot: current,
                    history: chartHistory(history.get(selected!)),
                  });
                if (refreshError) post({ type: 'error', message: refreshError, stale: true });
                break;
              case 'interval':
                if (
                  typeof v.seconds !== 'number' ||
                  !Number.isInteger(v.seconds) ||
                  v.seconds < 5 ||
                  v.seconds > 300
                )
                  throw new Error('Choose an interval from 5 to 300 seconds.');
                await vscode.workspace
                  .getConfiguration('dbPerf')
                  .update('refreshIntervalSeconds', v.seconds, vscode.ConfigurationTarget.Global);
                sendProfiles();
                break;
              case 'settings':
                await vscode.commands.executeCommand(
                  'workbench.action.openSettings',
                  '@ext:DaniyalMusadiq.database-performance-analyzer',
                );
                break;
              case 'manage':
                await manage();
                break;
              case 'clearBaseline':
                baseline = undefined;
                post({ type: 'baselineCleared' });
                break;
              case 'clearHistory':
                if (busy) throw new Error('Wait for the current operation to finish.');
                if (selected) history.delete(selected);
                baseline = undefined;
                post({ type: 'baselineCleared' });
                if (current) post({ type: 'snapshot', snapshot: current, history: [] });
                if (refreshError) post({ type: 'error', message: refreshError, stale: true });
                break;
              case 'connect':
                try {
                  await connectForm(v);
                } catch (error) {
                  post({ type: 'setupError', message: redactError(error) });
                }
                break;
              case 'add':
                post({ type: 'setup' });
                break;
              case 'sqliteFile':
                await addSqlite();
                break;
              case 'reconnect': {
                const id = context.globalState.get<string>('lastConnection') || profiles[0]?.id;
                if (id && profiles.some((p) => p.id === id)) await select(id);
                break;
              }
              case 'advancedAdd':
                await add();
                break;
              case 'detect':
                await detect();
                break;
              case 'demo':
                await select('demo');
                break;
              case 'select':
                if (typeof v.id === 'string') await select(v.id);
                break;
              case 'refresh':
                await refresh();
                break;
              case 'cancel':
                cancel();
                break;
              case 'live':
                toggleLive();
                break;
              case 'baseline':
                if (current) {
                  baseline = deserialize(serialize(current)) as Snapshot;
                  post({ type: 'baselineState', timestamp: baseline.timestamp });
                  post({ type: 'comparison', comparison: compareSnapshots(baseline, current) });
                }
                break;
              case 'export':
                await exportReport();
                break;
              case 'explain':
                if (typeof v.sql === 'string' && typeof v.execute === 'boolean')
                  await runPlan(v.sql, v.execute);
                break;
            }
          } catch (e) {
            post({ type: 'error', message: redactError(e) });
          }
        },
        undefined,
        context.subscriptions,
      );
    } else panel.reveal();
    if (id && all().some((p) => p.id === id)) await select(id);
    else sendProfiles();
  }
  async function select(id: string) {
    if (busy) {
      post({ type: 'error', message: 'Cancel the current operation before changing connections.' });
      sendProfiles();
      return;
    }
    if (
      selected === id &&
      current &&
      !refreshError &&
      Date.now() - Date.parse(current.timestamp) < 10000
    ) {
      sendProfiles();
      post({ type: 'snapshot', snapshot: current, history: chartHistory(history.get(id)) });
      return;
    }
    stop();
    selected = all().some((p) => p.id === id) ? id : undefined;
    baseline = undefined;
    current = undefined;
    refreshError = undefined;
    sendProfiles(true);
    if (selected) {
      await refresh();
      if (current && selected !== 'demo')
        await context.globalState.update('lastConnection', selected);
    }
  }
  function toggleLive(refreshNow = true) {
    if (monitoring) {
      stop();
      return;
    }
    if (!selected) {
      post({ type: 'error', message: 'Choose a connection before starting monitoring.' });
      return;
    }
    if (getProfile()?.engine !== 'demo') trust();
    const secs = settingNumber(
      vscode.workspace.getConfiguration('dbPerf').get('refreshIntervalSeconds'),
      30,
      5,
      300,
      true,
    );
    nextRefreshAt = Date.now() + secs * 1000;
    monitoring = setInterval(() => {
      nextRefreshAt = Date.now() + secs * 1000;
      sendLive();
      if (!busy && panel?.visible) void refresh();
    }, secs * 1000);
    sendLive();
    if (refreshNow) void refresh();
  }
  async function add(seed?: string) {
    trust();
    let prepared = false;
    if (!seed) {
      const method = await vscode.window.showQuickPick(
        [
          {
            label: 'Local database defaults',
            description: 'localhost and the standard port are filled in',
            mode: 'local',
          },
          {
            label: 'Detect from this project',
            description: 'Find URLs in environment and ORM configuration files',
            mode: 'detect',
          },
          {
            label: 'Guided connection setup',
            description: 'Choose an engine and enter individual fields',
            mode: 'guided',
          },
          {
            label: 'Paste a connection URL',
            description: 'For existing URLs, cloud services and advanced options',
            mode: 'url',
          },
          {
            label: 'Open a SQLite database file',
            description: 'Choose a local snapshot or backup',
            mode: 'sqlite',
          },
        ],
        { title: 'Add database connection', ignoreFocusOut: true },
      );
      if (!method) return;
      if (method.mode === 'detect') return detect();
      if (method.mode === 'sqlite') {
        const files = await vscode.window.showOpenDialog({
          canSelectMany: false,
          canSelectFiles: true,
          canSelectFolders: false,
          openLabel: 'Select database snapshot',
        });
        if (!files?.[0]) return;
        if (files[0].scheme !== 'file')
          throw new Error('Choose a local SQLite file on the workspace host.');
        seed = files[0].toString();
        prepared = true;
      } else if (method.mode === 'guided' || method.mode === 'local') {
        seed = await guidedConnection(undefined, method.mode === 'local');
        prepared = true;
        if (!seed) return;
      }
    }
    const uri = prepared
      ? seed
      : await vscode.window.showInputBox({
          title: 'Review database connection URL',
          prompt:
            'Connection URL (saved securely in VS Code SecretStorage). Engine is detected from the URL.',
          password: true,
          value: seed,
          placeHolder: 'postgresql://user:password@localhost:5432/database',
          ignoreFocusOut: true,
          validateInput: (value) => {
            try {
              validateUri(value);
              return undefined;
            } catch (e) {
              return (e as Error).message;
            }
          },
        });
    if (!uri) return;
    const engine = detectEngine(uri);
    const issue = runtimeIssue(engine);
    if (issue) throw new Error(issue);
    await saveConnection(uri, '', defaultConnectionTls(uri), false);
  }
  async function saveConnection(uri: string, name: string, tls: boolean, live: boolean) {
    trust();
    validateUri(uri);
    const engine = detectEngine(uri);
    const issue = runtimeIssue(engine);
    if (issue) throw new Error(issue);
    let p: Profile = {
      id: randomUUID(),
      name: name.trim() || `${engine} · ${targetOf(uri)}`,
      engine,
      target: targetOf(uri),
      tls,
      createdAt: new Date().toISOString(),
    };
    if (busy || connecting) throw new Error('Wait for the current operation to finish.');
    stop();
    connecting = true;
    const checkController = new AbortController();
    controller = checkController;
    busy = true;
    post({ type: 'busy', value: true });
    let checked: Snapshot;
    try {
      checked = await collect(p, uri, options());
      throwIfAborted(checkController.signal);
      if (disposed) return;
      await profileChanges.run(async () => {
        for (const existing of profiles.filter(
          (x) => x.engine === engine && x.target === p.target && x.tls === tls,
        )) {
          if ((await context.secrets.get('dbPerf.uri.' + existing.id)) === uri) {
            p = existing;
            return;
          }
        }
        await context.secrets.store('dbPerf.uri.' + p.id, uri);
        try {
          await context.globalState.update('profiles', [...profiles, p]);
        } catch (e) {
          await context.secrets.delete('dbPerf.uri.' + p.id);
          throw e;
        }
        profiles = [...profiles, p];
        tree.refresh();
      });
      checked.connection = p.name;
      await open();
      stop();
      selected = p.id;
      current = checked;
      baseline = undefined;
      refreshError = undefined;
      const h = history.add(
        p.id,
        checked,
        settingNumber(
          vscode.workspace.getConfiguration('dbPerf').get('maxHistory'),
          60,
          5,
          300,
          true,
        ),
      );
      sendProfiles(true);
      post({ type: 'snapshot', snapshot: checked, history: chartHistory(h) });
      await context.globalState.update('lastConnection', p.id);
      post({ type: 'connected' });
      if (live) toggleLive(false);
    } catch (error) {
      throw new Error(connectionFailure(error, uri));
    } finally {
      connecting = false;
      busy = false;
      controller = undefined;
      post({ type: 'busy', value: false });
    }
  }
  async function addSqlite() {
    trust();
    const files = await vscode.window.showOpenDialog({
      canSelectMany: false,
      canSelectFiles: true,
      canSelectFolders: false,
      openLabel: 'Connect SQLite snapshot',
      filters: { 'SQLite databases': ['sqlite', 'sqlite3', 'db'], 'All files': ['*'] },
    });
    if (!files?.[0]) return;
    if (files[0].scheme !== 'file')
      throw new Error('Choose a local SQLite file on the workspace host.');
    await saveConnection(files[0].toString(), '', false, false);
  }
  async function connectForm(v: Record<string, unknown>) {
    trust();
    const field = (key: string) => (typeof v[key] === 'string' ? (v[key] as string) : '');
    const engine = field('engine');
    if (!Object.prototype.hasOwnProperty.call(connectionDefaults, engine))
      throw new Error('Choose a supported database.');
    const uri =
      field('uri').trim() ||
      buildConnectionUri(
        engine as NetworkEngine,
        field('host'),
        field('port'),
        field('database'),
        field('user'),
        field('password'),
      );
    const security = field('security');
    const tls = security === 'verified' || (security !== 'local' && defaultConnectionTls(uri));
    if (!tls && /^(rediss|mongodb\+srv):/i.test(uri))
      throw new Error(
        'This address requires encrypted transport. Choose Automatic or Verified TLS.',
      );
    const name = field('name');
    if (name.length > 100) throw new Error('Use at most 100 characters for the connection name.');
    await saveConnection(uri, name, tls, v.monitor === true);
  }
  async function inputStep(
    title: string,
    step: number,
    total: number,
    prompt: string,
    value: string,
    password: boolean,
    validate: (value: string) => string | undefined,
  ): Promise<string | { back: true } | undefined> {
    return new Promise((resolve) => {
      const input = vscode.window.createInputBox();
      input.title = title;
      input.step = step;
      input.totalSteps = total;
      input.prompt = prompt;
      input.value = value;
      input.password = password;
      input.ignoreFocusOut = true;
      input.buttons = step > 1 ? [vscode.QuickInputButtons.Back] : [];
      input.placeholder = password
        ? 'Never stored in project files or sent to the dashboard'
        : prompt;
      let settled = false;
      const handlers: vscode.Disposable[] = [];
      const finish = (result: string | { back: true } | undefined) => {
        if (settled) return;
        settled = true;
        handlers.forEach((h) => h.dispose());
        input.dispose();
        resolve(result);
      };
      handlers.push(
        input.onDidAccept(() => {
          const error = validate(input.value);
          input.validationMessage = error;
          if (!error) finish(input.value);
        }),
      );
      handlers.push(
        input.onDidChangeValue((value) => {
          input.validationMessage = validate(value);
        }),
      );
      handlers.push(input.onDidTriggerButton(() => finish({ back: true })));
      handlers.push(input.onDidHide(() => finish(undefined)));
      input.show();
    });
  }
  async function guidedConnection(original?: string, local = false): Promise<string | undefined> {
    const existing = original ? connectionFields(original) : undefined;
    const picked = existing
      ? { engine: existing.engine }
      : await vscode.window.showQuickPick(
          (Object.keys(connectionDefaults) as NetworkEngine[])
            .filter((engine) => !runtimeIssue(engine))
            .map((engine) => ({
              label: engine,
              description: `Default port ${connectionDefaults[engine].port}`,
              engine,
            })),
          {
            title: 'Choose database engine',
            placeHolder: 'MariaDB uses MySQL. Cloud/SRV URLs use Paste a connection URL.',
            ignoreFocusOut: true,
          },
        );
    if (!picked) return;
    const engine = picked.engine,
      defaults = connectionDefaults[engine];
    const fields = [
      {
        label:
          'Host only: localhost, a server name, or an IP address. Under Remote SSH this refers to the remote host.',
        value: existing?.host || 'localhost',
        password: false,
      },
      {
        label: `Port: standard ${engine} port is ${defaults.port}. Enter a custom port if your server uses one.`,
        value: existing?.port || String(defaults.port),
        password: false,
      },
      {
        label:
          engine === 'redis'
            ? 'Database index: usually 0; this must be a nonnegative integer.'
            : 'Database name: use the database your application connects to.',
        value: existing?.database ?? defaults.database,
        password: false,
      },
      {
        label:
          'Username: use a read-only account where possible. Leave empty only if authentication does not require it.',
        value: existing?.user || '',
        password: false,
      },
      {
        label: existing
          ? 'Password: leave empty to keep the saved password, or type a replacement. Use the URL editor to remove a saved password.'
          : 'Password: special characters are encoded automatically. Leave empty if authentication does not require it.',
        value: '',
        password: true,
      },
    ];
    const values: string[] = fields.map((f) => f.value);
    const start = local ? 2 : 0;
    for (let i = start; i < fields.length;) {
      const field = fields[i];
      const result = await inputStep(
        `${existing ? 'Edit' : 'Connect'} ${engine}`,
        i - start + 1,
        fields.length - start,
        field.label,
        values[i],
        field.password,
        (value) => {
          if (i === 0 && (!value.trim() || /[\s/@?#]/.test(value)))
            return 'Enter only a hostname or IP address, without a URL or port.';
          if (i === 1 && (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535))
            return 'Enter a port between 1 and 65535.';
          if (i === 2 && engine === 'redis' && !/^\d+$/.test(value))
            return 'Enter a nonnegative database index.';
          return undefined;
        },
      );
      if (result === undefined) return;
      if (typeof result !== 'string') {
        i = Math.max(start, i - 1);
        continue;
      }
      values[i] = result;
      i++;
    }
    const uri = buildConnectionUri(
      engine,
      values[0],
      values[1],
      values[2],
      values[3],
      values[4] || existing?.password || '',
    );
    return original ? preserveConnectionOptions(original, uri) : uri;
  }
  async function manage() {
    trust();
    if (busy) throw new Error('Cancel the current operation before managing connections.');
    const p = profiles.find((p) => p.id === selected);
    if (!p) throw new Error('Select a saved database connection first.');
    const action = await vscode.window.showQuickPick(
      [
        'Edit connection fields',
        'Rename',
        'Update connection URL',
        'Change transport security',
        'Remove connection',
      ],
      { title: `Manage ${p.name}` },
    );
    const item = new vscode.TreeItem(p.name);
    item.id = p.id;
    if (action === 'Edit connection fields') {
      const original = await context.secrets.get('dbPerf.uri.' + p.id);
      if (!original) throw new Error('Saved URL is missing. Use Update connection URL.');
      if (p.engine === 'sqlite') {
        const files = await vscode.window.showOpenDialog({
          canSelectMany: false,
          canSelectFiles: true,
          canSelectFolders: false,
          openLabel: 'Replace database file',
        });
        if (files?.[0]) await updateUrl(item, files[0].toString());
      } else {
        const updated = await guidedConnection(original);
        if (updated) await updateUrl(item, updated);
      }
      return;
    }
    if (action === 'Update connection URL') return updateUrl(item);
    if (action === 'Remove connection') return remove(item);
    let name = p.name,
      tls = p.tls;
    if (action === 'Rename') {
      const value = await vscode.window.showInputBox({
        title: 'Rename connection',
        value: p.name,
        validateInput: (v) =>
          !v.trim() || v.length > 100 ? 'Enter a name from 1 to 100 characters.' : undefined,
      });
      if (value === undefined) return;
      name = value.trim();
    } else if (action === 'Change transport security') {
      if (p.engine === 'sqlite')
        throw new Error('SQLite uses a local file and has no transport security setting.');
      const value = await vscode.window.showQuickPick(
        ['Verified TLS', 'Plaintext (local development or trusted tunnel)'],
        { title: 'Transport security' },
      );
      if (!value) return;
      tls = value === 'Verified TLS';
    } else return;
    await profileChanges.run(async () => {
      if (busy) throw new Error('Cancel the current operation first.');
      if (!profiles.some((x) => x.id === p.id)) throw new Error('Connection was removed.');
      const uri = await context.secrets.get('dbPerf.uri.' + p.id);
      if (!tls && uri && /^(rediss|mongodb\+srv):/i.test(uri))
        throw new Error('This connection URL requires verified TLS.');
      const next = profiles.map((x) => (x.id === p.id ? { ...x, name, tls } : x));
      await context.globalState.update('profiles', next);
      profiles = next;
      history.delete(p.id);
      tree.refresh();
      if (selected === p.id) {
        stop();
        current = undefined;
        baseline = undefined;
        refreshError = undefined;
      }
      sendProfiles(true);
    });
    if (selected === p.id) await refresh();
  }
  async function detect() {
    trust();
    await open();
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Detecting database configuration and models',
        cancellable: true,
      },
      async (_progress, token) => {
        const uris = await vscode.workspace.findFiles(
          '**/{package.json,*.prisma,.env,.env.*,docker-compose*.yml,docker-compose*.yaml,compose*.yml,compose*.yaml,settings.py,models.py,*entity.ts,*model.ts,*model.js,drizzle.config.ts,knexfile.js}',
          '**/{node_modules,.git,dist,build,venv,.venv,vendor}/**',
          100,
          token,
        );
        const files: { path: string; text: string }[] = [];
        // Bounded parallel reads reduce remote-workspace latency without unbounded file IO.
        for (let i = 0; i < uris.length; i += 6) {
          if (token.isCancellationRequested) return;
          const batch = await Promise.all(
            uris.slice(i, i + 6).map(async (uri) => {
              try {
                const st = await vscode.workspace.fs.stat(uri);
                if (st.size > 1048576 || token.isCancellationRequested) return;
                return {
                  path: vscode.workspace.asRelativePath(uri),
                  text: Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'),
                };
              } catch {
                return;
              }
            }),
          );
          for (const file of batch) if (file) files.push(file);
        }
        if (token.isCancellationRequested) return;
        const result = inspectFiles(files);
        post({
          type: 'discovery',
          ...result,
          connections: result.connections.map((c) => ({
            engine: c.engine,
            target: c.target,
            source: c.source,
          })),
        });
        if (result.connections.length) {
          const picked =
            result.connections.length === 1
              ? { uri: result.connections[0].uri }
              : await vscode.window.showQuickPick(
                  result.connections.map((c) => ({
                    label: c.engine + ' · ' + c.target,
                    description: c.source,
                    uri: c.uri,
                  })),
                  {
                    title: 'Discovered databases',
                    placeHolder:
                      'Choose a connection to review and save, or Escape to view discovery results',
                  },
                );
          if (picked) await saveConnection(picked.uri, '', defaultConnectionTls(picked.uri), false);
        } else
          void vscode.window.showInformationMessage(
            'Discovery complete. Review detected frameworks and models in the dashboard; add a connection URL manually.',
          );
      },
    );
  }
  async function runPlan(sql: string, execute: boolean) {
    const p = getProfile();
    if (!p) throw new Error('Select a connection first.');
    validateSql(sql, p.engine);
    if (execute) {
      if (p.engine !== 'postgres')
        throw new Error('Executed plans are available only for PostgreSQL.');
      const yes = await vscode.window.showWarningMessage(
        'EXPLAIN ANALYZE executes this SELECT on the database. A read-only transaction limits database writes, but functions can have external effects. Use a read-only account and a trusted query. It can create load until the timeout.',
        { modal: true },
        'Execute selected query',
      );
      if (yes !== 'Execute selected query') return;
    }
    if (getProfile() !== p || disposed)
      throw new Error('Connection changed while confirming the plan. Review and run it again.');
    const plan = await operation('Explain', async (profile, uri) =>
      explain(profile, uri, sql, execute, options()),
    );
    if (plan) post({ type: 'plan', plan });
  }
  async function exportReport() {
    if (!current) throw new Error('Refresh a connection before exporting.');
    const snapshot = deserialize(serialize(current)) as Snapshot;
    const f = await vscode.window.showQuickPick(
      [
        { label: 'Markdown report', ext: 'md', format: 'markdown' as const },
        { label: 'JSON snapshot', ext: 'json', format: 'json' as const },
        { label: 'Query statistics CSV', ext: 'csv', format: 'csv' as const },
      ],
      { title: 'Export performance report' },
    );
    if (!f) return;
    const privacy = await vscode.window.showQuickPick(
      [
        { label: 'Omit query text and session users', include: false },
        {
          label: 'Include query text and session users',
          description: 'May contain literals, identifiers, or sensitive command arguments',
          include: true,
        },
      ],
      { title: 'Report privacy' },
    );
    if (!privacy) return;
    const destination = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.joinPath(
        vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(homedir()),
        `database-performance-${new Date().toISOString().replace(/[:.]/g, '-')}.${f.ext}`,
      ),
      filters: { [f.label]: [f.ext] },
    });
    if (!destination) return;
    await vscode.workspace.fs.writeFile(
      destination,
      Buffer.from(exportSnapshot(snapshot, f.format, privacy.include)),
    );
    await vscode.window.showTextDocument(destination);
  }
  async function remove(item?: vscode.TreeItem) {
    trust();
    const id = item?.id ?? selected;
    const p = profiles.find((p) => p.id === id);
    if (!p) return;
    if (busy) throw new Error('Cancel the current database operation first.');
    const yes = await vscode.window.showWarningMessage(
      `Remove connection “${p.name}” and its stored credential?`,
      { modal: true },
      'Remove',
    );
    if (yes !== 'Remove') return;
    await profileChanges.run(async () => {
      if (busy) throw new Error('Cancel the current database operation first.');
      const next = profiles.filter((x) => x.id !== id);
      await context.globalState.update('profiles', next);
      profiles = next;
      await context.secrets.delete('dbPerf.uri.' + id);
      history.delete(id!);
      if (selected === id) {
        stop();
        selected = undefined;
        current = undefined;
        baseline = undefined;
        refreshError = undefined;
      }
      tree.refresh();
      sendProfiles();
    });
  }
  async function updateUrl(item?: vscode.TreeItem, preparedUri?: string) {
    trust();
    const p = profiles.find((p) => p.id === (item?.id ?? selected));
    if (!p) return;
    if (busy) throw new Error('Cancel the current operation before updating credentials.');
    const uri =
      preparedUri ||
      (await vscode.window.showInputBox({
        title: 'Update connection URL',
        password: true,
        prompt: `Enter a ${p.engine} URL. The existing secret is never displayed.`,
        validateInput: (v) => {
          try {
            validateUri(v);
            if (detectEngine(v) !== p.engine) return 'Use the same engine or add a new connection.';
          } catch (e) {
            return (e as Error).message;
          }
        },
      }));
    if (!uri) return;
    validateUri(uri);
    if (detectEngine(uri) !== p.engine)
      throw new Error('Use the same engine or add a new connection.');
    if ((/^rediss:/i.test(uri) || /^mongodb\+srv:/i.test(uri)) && !p.tls)
      throw new Error('This URL requires verified TLS. Add a new connection with TLS enabled.');
    await profileChanges.run(async () => {
      if (busy) throw new Error('Cancel the current database operation first.');
      if (!profiles.some((x) => x.id === p.id))
        throw new Error('This connection has been removed. Add it again.');
      const previous = await context.secrets.get('dbPerf.uri.' + p.id);
      await context.secrets.store('dbPerf.uri.' + p.id, uri);
      const next = profiles.map((x) => (x.id === p.id ? { ...x, target: targetOf(uri) } : x));
      try {
        await context.globalState.update('profiles', next);
      } catch (error) {
        if (previous) await context.secrets.store('dbPerf.uri.' + p.id, previous);
        else await context.secrets.delete('dbPerf.uri.' + p.id);
        throw error;
      }
      profiles = next;
      history.delete(p.id);
      if (selected === p.id) {
        current = undefined;
        baseline = undefined;
        refreshError = undefined;
        stop();
      }
      tree.refresh();
      sendProfiles(true);
    });
    if (selected === p.id) await refresh();
  }
  const register = (id: string, fn: (...args: any[]) => unknown) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: any[]) => {
        try {
          return await fn(...args);
        } catch (e) {
          void vscode.window.showErrorMessage(redactError(e));
        }
      }),
    );
  register('dbPerf.open', open);
  register('dbPerf.add', async () => {
    trust();
    await open();
    post({ type: 'setup' });
  });
  register('dbPerf.detect', detect);
  register('dbPerf.demo', () => open('demo'));
  register('dbPerf.refresh', refresh);
  register('dbPerf.remove', remove);
  register('dbPerf.password', updateUrl);
  register('dbPerf.manage', manage);
  register('dbPerf.explain', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) throw new Error('Open a SQL document and select a SELECT query.');
    const sql = editor.document.getText(editor.selection.isEmpty ? undefined : editor.selection);
    await open();
    if (!selected) {
      const p = await vscode.window.showQuickPick(
        all()
          .filter((p) => ['postgres', 'mysql', 'sqlserver', 'sqlite', 'demo'].includes(p.engine))
          .map((p) => ({ label: p.name, id: p.id })),
        { placeHolder: 'Choose a SQL connection' },
      );
      if (!p) return;
      await select(p.id);
    }
    post({ type: 'sql', sql });
    await runPlan(sql, false);
  });
  context.subscriptions.push({
    dispose() {
      disposed = true;
      stop();
      cancel();
      panel?.dispose();
      history.clear();
    },
  });
  context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(() => sendProfiles()));
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('dbPerf')) sendProfiles();
      if (monitoring && event.affectsConfiguration('dbPerf.refreshIntervalSeconds')) {
        stop();
        toggleLive();
      }
    }),
  );
  // Opening the home screen never auto-selects a profile or connects to a database.
  if (vscode.workspace.getConfiguration('dbPerf').get<boolean>('openDashboardOnStartup', false)) {
    void open().catch((error) => {
      if (!disposed) output.appendLine(redactError(error));
    });
  }
  if (!context.globalState.get<boolean>('welcomeShown', false)) {
    void context.globalState
      .update('welcomeShown', true)
      .then(async () => {
        if (disposed) return;
        const choice = await vscode.window.showInformationMessage(
          'Database Performance Analyzer is ready. Open it any time from the database icon in the left sidebar or DB Performance in the bottom status bar.',
          'Open Dashboard',
          'Try Demo',
          'Not now',
        );
        if (disposed) return;
        if (choice === 'Open Dashboard') await open();
        else if (choice === 'Try Demo') await open('demo');
      })
      .then(undefined, (error) => {
        if (!disposed) output.appendLine(redactError(error));
      });
  }
  // Diagnostics below are consumed only by the extension-host smoke test; no credentials are exposed.
  return { profileCount: () => profiles.length, hasDashboard: () => !!panel };
}
export function deactivate() {}
