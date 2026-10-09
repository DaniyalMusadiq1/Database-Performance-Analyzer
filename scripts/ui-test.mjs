import { build } from 'esbuild';
import { readFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const cryptoModule = await import('node:crypto');
const result = await build({
  entryPoints: ['src/view.ts'],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  external: ['vscode'],
});
const mod = { exports: {} };
const vscode = { Uri: { joinPath: (_root, ...parts) => parts.join('/') } };
vm.runInNewContext(result.outputFiles[0].text, {
  require: (name) => (name === 'vscode' ? vscode : requireBuiltin(name)),
  module: mod,
  exports: mod.exports,
});
function requireBuiltin(name) {
  if (name === 'node:crypto') return cryptoModule;
  throw new Error(name);
}
const html = mod.exports.dashboardHtml({ cspSource: "'self'", asWebviewUri: (p) => '/' + p }, {});
const theme = `:root{--vscode-font-family:system-ui;--vscode-editor-font-family:monospace;--vscode-editor-foreground:#e6edf1;--vscode-editor-background:#111c24;--vscode-editorWidget-background:#17252f;--vscode-panel-border:#2d414e;--vscode-descriptionForeground:#9aaeb9;--vscode-button-background:#2c8871;--vscode-button-foreground:white;--vscode-button-hoverBackground:#379880;--vscode-button-secondaryBackground:#263c4b;--vscode-button-secondaryForeground:#e6edf1;--vscode-button-secondaryHoverBackground:#345163;--vscode-input-background:#17252f;--vscode-input-foreground:#e6edf1;--vscode-input-border:#344e5e;--vscode-charts-green:#71d3b0;--vscode-charts-yellow:#e7bd65;--vscode-charts-red:#ed827d;--vscode-charts-blue:#82b6dc;--vscode-focusBorder:#71d3b0;--vscode-inputValidation-errorBorder:#d56c66;--vscode-inputValidation-errorBackground:#4b292d}`;
const server = createServer(async (req, res) => {
  if (req.url === '/') {
    res.setHeader('Content-Type', 'text/html');
    res.end(html);
    return;
  }
  if (['/media/dashboard.js', '/media/dashboard.css'].includes(req.url)) {
    res.setHeader('Content-Type', req.url.endsWith('js') ? 'application/javascript' : 'text/css');
    res.end((req.url.endsWith('css') ? theme : '') + (await readFile('.' + req.url, 'utf8')));
    return;
  }
  res.statusCode = 404;
  res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
let browser;
try {
  browser = await chromium.launch({
    executablePath: process.env.DBPERF_CHROME_PATH || '/usr/bin/google-chrome',
    headless: true,
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1360, height: 1050 } });
  // Wait for posted webview messages to reach the next rendered frame before assertions.
  const evaluate = page.evaluate.bind(page);
  page.evaluate = async (...args) => {
    const result = await evaluate(...args);
    await evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    return result;
  };
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    let state = {};
    window.sent = [];
    window.acquireVsCodeApi = () => ({
      postMessage: (m) => window.sent.push(m),
      getState: () => state,
      setState: (s) => (state = s),
    });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  assert.ok(await page.locator('#welcome').isVisible());
  await page.click('#demo');
  assert.ok(await page.evaluate(() => window.sent.some((m) => m.type === 'demo')));
  const r = await build({
    entryPoints: ['src/demo.ts'],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
  });
  const dm = { exports: {} };
  vm.runInNewContext(r.outputFiles[0].text, { module: dm, exports: dm.exports });
  const snapshot = dm.exports.demoSnapshot();
  const profiles = [
    { id: 'demo', name: 'Commerce demo', engine: 'demo' },
    {
      id: 'other',
      name: 'Other connection',
      engine: 'postgres',
      tls: true,
      target: 'localhost:5432/app',
    },
  ];
  await page.evaluate(
    ({ profiles, snapshot }) => {
      window.postMessage({ type: 'profiles', profiles, selected: 'demo' }, '*');
      window.postMessage({ type: 'busy', value: false }, '*');
      window.postMessage({ type: 'snapshot', snapshot, history: [snapshot] }, '*');
    },
    { profiles, snapshot },
  );
  await page.locator('#metrics .metric').first().waitFor();
  assert.equal(await page.locator('#metrics .metric').count(), 4);
  assert.ok(await page.locator('#manage').isDisabled(), 'Demo is not a saved connection');
  await page.click('#baseline');
  assert.ok(await page.locator('#clear-baseline').isEnabled());
  await page.click('#clear-baseline');
  assert.ok(await page.evaluate(() => window.sent.some((m) => m.type === 'clearBaseline')));
  await page.evaluate(() => window.postMessage({ type: 'baselineCleared' }, '*'));
  assert.ok(await page.locator('#clear-baseline').isDisabled());
  await page.selectOption('#finding-filter', 'critical');
  assert.equal(await page.locator('#findings .warning').count(), 0);
  await page.selectOption('#finding-filter', 'all');
  await page.click('[data-tab=tables]');
  const totalTables = await page.locator('#table-table tbody tr').count();
  await page.fill('#table-filter', 'nonexistent-table');
  assert.equal(await page.locator('#table-table tbody tr').count(), 0);
  assert.ok((await page.locator('#table-table').innerText()).includes('No matching records'));
  await page.fill('#table-filter', '');
  assert.equal(await page.locator('#table-table tbody tr').count(), totalTables);
  await page.click('[data-tab=overview]');
  assert.ok(await page.locator('#export').isEnabled());
  assert.ok(await page.locator('#baseline').isEnabled());
  assert.ok((await page.locator('[data-tab=queries]').innerText()).includes('(3)'));
  await page.locator('#snapshot-summary .critical').click();
  assert.equal(await page.inputValue('#finding-filter'), 'critical');
  assert.equal(await page.locator('#findings .warning').count(), 0);
  await page.selectOption('#finding-filter', 'all');
  await page.selectOption('#interval', '15');
  assert.ok(
    await page.evaluate(() => window.sent.some((m) => m.type === 'interval' && m.seconds === 15)),
  );
  await page.evaluate(() =>
    window.postMessage(
      { type: 'live', value: true, intervalSeconds: 15, nextRefreshInMs: 15000 },
      '*',
    ),
  );
  assert.ok((await page.locator('#monitor-status').innerText()).includes('every 15s'));
  await page.evaluate(() => window.postMessage({ type: 'busy', value: true }, '*'));
  assert.ok(await page.locator('#live').isEnabled(), 'Monitoring can be stopped during collection');
  await page.evaluate(() => {
    window.postMessage({ type: 'busy', value: false }, '*');
    window.postMessage({ type: 'live', value: false }, '*');
  });
  const previous = structuredClone(snapshot);
  previous.timestamp = new Date(Date.parse(snapshot.timestamp) - 15000).toISOString();
  previous.metrics[0].value = 5;
  await page.evaluate(
    ({ snapshot, previous }) =>
      window.postMessage({ type: 'snapshot', snapshot, history: [previous, snapshot] }, '*'),
    { snapshot, previous },
  );
  assert.ok((await page.locator('#trend-stats').innerText()).includes('Latest'));
  assert.equal(await page.locator('#trend circle').count(), 2);

  assert.ok(
    await page
      .locator('#findings')
      .innerText()
      .then((x) => x.includes('blocked session')),
  );
  await page.selectOption('#trend-metric', 'Cache hit ratio');
  assert.ok((await page.locator('#trend-label').innerText()).includes('Cache hit ratio'));
  await page.locator('[data-tab=overview]').focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('[data-tab=queries]').getAttribute('aria-selected'), 'true');
  await page.click('[data-tab=queries]');
  assert.equal(await page.locator('#query-table tbody tr').count(), 3);
  await page.check('#slow-only');
  assert.ok((await page.locator('#query-table tbody tr').count()) < 3);
  await page.uncheck('#slow-only');
  await page.click('#sort-direction');
  const ascendingTimes = await page
    .locator('#query-table tbody tr td:nth-child(3)')
    .allTextContents();
  const numericTimes = ascendingTimes.map((x) => Number(x.replace(/,/g, '')));
  assert.deepEqual(
    numericTimes,
    [...numericTimes].sort((a, b) => a - b),
  );
  await page.click('#sort-direction');

  await page.fill('#query-filter', 'inventory');
  assert.equal(await page.locator('#query-table tbody tr').count(), 1);
  await page.fill('#query-filter', '');
  await page.locator('#query-table button').first().click();
  assert.ok((await page.inputValue('#sql')).startsWith('SELECT customer_id'));
  await page.click('#explain');
  assert.ok(await page.evaluate(() => window.sent.some((m) => m.type === 'explain' && !m.execute)));
  const hostile = structuredClone(snapshot);
  hostile.queries[0].query = '<img src=x onerror="window.pwned=true">';
  await page.evaluate(
    (s) => window.postMessage({ type: 'snapshot', snapshot: s, history: [s] }, '*'),
    hostile,
  );
  await page.click('[data-tab=queries]');
  assert.equal(await page.locator('#query-table img').count(), 0);
  assert.equal(await page.evaluate(() => window.pwned), undefined);
  await page.evaluate(
    (s) => window.postMessage({ type: 'snapshot', snapshot: s, history: [s] }, '*'),
    snapshot,
  );
  await page.evaluate(() =>
    window.postMessage({ type: 'error', message: 'Test refresh failure', stale: true }, '*'),
  );
  assert.ok(await page.locator('#stale').isVisible());
  await page.click('#retry');
  assert.ok(await page.evaluate(() => window.sent.some((m) => m.type === 'refresh')));
  await page.evaluate(
    (s) => window.postMessage({ type: 'snapshot', snapshot: s, history: [s] }, '*'),
    snapshot,
  );
  assert.ok(await page.locator('#stale').isHidden());
  await page.evaluate(() => window.postMessage({ type: 'busy', value: true }, '*'));
  assert.ok(await page.locator('#add').isDisabled());
  assert.ok(await page.locator('#explain').isDisabled());
  await page.evaluate(() => window.postMessage({ type: 'busy', value: false }, '*'));
  await page.click('[data-tab=overview]');
  await mkdir('media/screenshots', { recursive: true });
  await page.screenshot({ path: 'media/screenshots/dashboard.png', fullPage: true });
  await page.setViewportSize({ width: 560, height: 1000 });
  assert.ok(await page.locator('#refresh').isVisible());
  await page.screenshot({ path: 'media/screenshots/dashboard-narrow.png', fullPage: true });
  await page.evaluate(
    (profiles) => window.postMessage({ type: 'profiles', profiles, selected: 'other' }, '*'),
    profiles,
  );
  assert.equal(
    await page.locator('#metrics .metric').count(),
    0,
    'Changing connection clears stale metrics',
  );
  await page.evaluate(
    (profiles) =>
      window.postMessage({ type: 'profiles', profiles, selected: 'demo', reset: true }, '*'),
    profiles,
  );
  assert.equal(await page.locator('#metrics .metric').count(), 0);
  await page.evaluate(
    (profiles) =>
      window.postMessage({ type: 'profiles', profiles, selected: 'demo', trusted: false }, '*'),
    profiles,
  );
  assert.ok(await page.locator('#trust-notice').isVisible());
  assert.ok(await page.locator('#add').isDisabled());
  assert.ok(await page.locator('#detect').isDisabled());
  assert.ok(
    await page.locator('#refresh').isEnabled(),
    'Demo refresh remains available without trust',
  );
  await page.evaluate(
    (profiles) =>
      window.postMessage({ type: 'profiles', profiles, selected: 'other', trusted: false }, '*'),
    profiles,
  );
  assert.ok(await page.locator('#refresh').isDisabled(), 'Real database refresh needs trust');
  await page.evaluate(
    (profiles) =>
      window.postMessage({ type: 'profiles', profiles, selected: 'other', trusted: true }, '*'),
    profiles,
  );
  assert.ok(await page.locator('#manage').isEnabled());
  assert.ok((await page.locator('#connection-detail').innerText()).includes('Verified TLS'));
  await page.click('#manage');
  assert.ok(await page.evaluate(() => window.sent.some((m) => m.type === 'manage')));
  await page.click('#settings');
  assert.ok(await page.evaluate(() => window.sent.some((m) => m.type === 'settings')));
  assert.deepEqual(errors, []);
  console.log(
    'Dashboard passed: setup, demo, tabs, filtering, SQL actions, injection protection, stale-state clearing and responsive layout.',
  );
} finally {
  await browser?.close();
  server.close();
}
