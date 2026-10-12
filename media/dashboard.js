/* All database and project content is rendered as text, never executable HTML. */
(() => {
  'use strict';
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  let snapshot = null,
    history = [],
    baseline = null,
    profiles = [],
    busy = false,
    shownId = null,
    trusted = true,
    monitoring = false,
    intervalSeconds = 30,
    nextRefresh = null,
    slowQueryMs = 100,
    ascending = false,
    refreshFailed = false;
  const tips = {
    add: 'Use guided setup with a link, login details, project detection or a SQLite file.',
    'welcome-add': 'Start with a guided connection. Credentials are saved securely in VS Code.',
    detect: 'Inspect environment and ORM files without executing project code.',
    'project-detect': 'Find supported database URLs, frameworks and models in this workspace.',
    manage: 'Edit individual fields, rename, update URL, change TLS or remove this connection.',
    refresh: 'Collect a new read-only diagnostic snapshot from the selected database.',
    retry: 'Try collecting diagnostics again after checking connection settings.',
    live: 'Automatically refresh while this dashboard is visible. Stop pauses future refreshes.',
    interval:
      'Choose how often live monitoring collects a new snapshot. This updates your VS Code setting.',
    cancel: 'Stop monitoring and cancel the current database operation.',
    export:
      'Save Markdown, JSON or CSV locally; query text is omitted unless you choose to include it.',
    baseline: 'Save these cumulative query counters to compare with a later refresh.',
    'clear-baseline': 'Remove the local comparison baseline without resetting database statistics.',
    'clear-history':
      'Remove local chart history for this connection; server statistics are unchanged.',
    explain:
      'Inspect an estimated SELECT query plan. Replace parameter placeholders with literals.',
    analyze:
      'PostgreSQL only: execute SELECT after explicit confirmation. This can create database load.',
    settings: 'Adjust timeouts, the slow-query threshold, monitoring interval and history limits.',
    'query-sort': 'Choose which query counter to sort by.',
    'sort-direction': 'Switch between highest-first and lowest-first query order.',
    'slow-only':
      'Show patterns with mean latency at or above your configured slow-query threshold.',
    'finding-filter': 'Limit advisory findings to a severity.',
    'trend-metric': 'Choose a metric from your locally captured history.',
    connection: 'Select a saved connection; changing it clears old results before refreshing.',
    sql: 'Enter one trusted SELECT. Use representative values instead of $1 or ? placeholders.',
  };
  for (const [id, tip] of Object.entries(tips)) $(id).title = tip;
  for (const id of ['query', 'session', 'table', 'index'])
    $(id + '-filter').title =
      'Search the available records. Clearing the field shows all records again.';
  const tableData = new Map();
  const state = vscode.getState() || {};
  const send = (type, extra = {}) => vscode.postMessage({ type, ...extra });
  const el = (tag, text, cls) => {
    const n = document.createElement(tag);
    if (text !== undefined) n.textContent = String(text);
    if (cls) n.className = cls;
    return n;
  };
  const fmt = (v) =>
    typeof v === 'number'
      ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(v)
      : String(v);
  const bytes = (n) => {
    if (n === 0) return '0 B';
    const i = Math.min(4, Math.floor(Math.log(Math.max(1, n)) / Math.log(1024)));
    return fmt(n / 1024 ** i) + ' ' + ['B', 'KB', 'MB', 'GB', 'TB'][i];
  };
  const empty = (box, text) => {
    box.replaceChildren(el('div', text, 'empty'));
  };
  function tab(id) {
    if (id !== 'overview' && $('view-mode').value === 'simple') {
      $('view-mode').value = 'advanced';
      applyView();
    }
    if (!document.querySelector(`[data-tab="${CSS.escape(String(id))}"]`)) id = 'overview';
    document.querySelectorAll('.tab').forEach((x) => (x.hidden = x.id !== id));
    document.querySelectorAll('[data-tab]').forEach((x) => {
      x.setAttribute('aria-selected', String(x.dataset.tab === id));
      x.tabIndex = x.dataset.tab === id ? 0 : -1;
      x.setAttribute('aria-controls', x.dataset.tab);
    });
    vscode.setState({ ...vscode.getState(), tab: id });
  }
  document
    .querySelectorAll('[data-tab]')
    .forEach((b) => b.addEventListener('click', () => tab(b.dataset.tab)));
  document.querySelector('.tabs').addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tabs = [...document.querySelectorAll('[data-tab]')];
    const current = tabs.indexOf(document.activeElement);
    if (current < 0) return;
    event.preventDefault();
    const index =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? tabs.length - 1
          : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tab(tabs[index].dataset.tab);
    tabs[index].focus();
  });
  function table(id, headers, rows) {
    tableData.set(id, { headers, rows });
    const filter = $(id.replace('-table', '-filter'))?.value.toLowerCase() || '';
    rows = rows.filter((row) =>
      row.some((value) =>
        String(value instanceof Node ? value.textContent : (value ?? ''))
          .toLowerCase()
          .includes(filter),
      ),
    );
    const box = $(id);
    if (!rows.length) {
      empty(
        box,
        filter
          ? 'No matching records. Clear the search to view all records.'
          : 'No data available. Check collection notes for permissions and engine capabilities.',
      );
      return;
    }
    const t = el('table'),
      thead = el('thead'),
      tr = el('tr');
    headers.forEach((x) => {
      const th = el('th', x);
      th.scope = 'col';
      tr.append(th);
    });
    thead.append(tr);
    t.append(thead);
    const body = el('tbody');
    for (const row of rows) {
      const r = el('tr');
      for (const value of row) {
        const td = el('td');
        if (value instanceof Node) td.append(value);
        else td.textContent = String(value ?? '—');
        if (typeof value === 'number') td.className = 'num';
        r.append(td);
      }
      body.append(r);
    }
    t.append(body);
    box.replaceChildren(t);
  }
  function finding(f) {
    const d = el('article', undefined, 'finding ' + f.severity);
    const names = {
      'Dead tuple pressure': 'Old row versions need attention',
      'Long idle transactions': 'Some unfinished work has been left waiting',
      'Indexes with no recorded reads': 'Some lookup indexes have no recorded use',
    };
    const descriptions = {
      sessions:
        'Some database work is waiting or unfinished. Ask your developer to check the affected requests and what is holding them up.',
      tables:
        'Stored data or the way it is searched may need attention. Ask your developer to review the evidence before making changes.',
      indexes:
        'These lookup structures may need review. Keep them until your developer has checked normal and occasional workloads.',
      queries:
        'Some application requests may be using more database time than expected. Ask your developer to inspect the most expensive requests.',
    };
    const title =
      names[f.title] ||
      f.title
        .replace('expensive query pattern', 'slow request pattern')
        .replace('blocked session', 'waiting request');
    d.append(el('h3', title), el('p', descriptions[f.section] || f.action));
    const details = el('details');
    details.append(
      el('summary', 'Evidence and technical next steps'),
      el('p', f.detail),
      el('p', f.action, 'action'),
    );
    if (f.confidence) details.append(el('p', `Confidence: ${f.confidence} · ${f.evidence || ''}`));
    d.append(details);
    if (f.section) {
      const button = el('button', 'View supporting information');
      button.onclick = () => tab(f.section);
      d.append(button);
    }
    return d;
  }
  function renderQueries() {
    if (!snapshot) return;
    const filter = $('query-filter').value.toLowerCase(),
      sort = $('query-sort').value;
    const rows = snapshot.queries
      .filter(
        (q) =>
          q.query.toLowerCase().includes(filter) &&
          (!$('slow-only').checked || q.meanMs >= slowQueryMs),
      )
      .sort((a, b) => (ascending ? a[sort] - b[sort] : b[sort] - a[sort]))
      .map((q) => {
        const sql = el('div', q.query, 'sql');
        const b = el('button', 'Use in plan');
        b.addEventListener('click', () => {
          $('sql').value = q.query;
          tab('plan');
        });
        return [
          sql,
          fmt(q.calls),
          fmt(q.totalMs),
          fmt(q.meanMs),
          fmt(q.rows),
          snapshot.capabilities.includes('explain') ? b : '—',
        ];
      });
    $('query-count').textContent =
      `${rows.length} of ${snapshot.queries.length} available patterns`;
    table(
      'query-table',
      ['Query / command', 'Calls', 'Total ms', 'Mean ms', 'Rows', 'Inspect'],
      rows,
    );
  }
  function renderFindings() {
    if (!snapshot) return;
    const severity = $('finding-filter').value;
    const rank = { critical: 0, warning: 1, info: 2 };
    const findings = snapshot.findings
      .filter((f) => severity === 'all' || f.severity === severity)
      .sort((a, b) => rank[a.severity] - rank[b.severity]);
    $('findings').replaceChildren(...findings.map(finding));
    if (!findings.length)
      empty(
        $('findings'),
        severity === 'all'
          ? 'No advisory findings in the available statistics. This is not a complete health assessment.'
          : 'No findings with this severity.',
      );
  }
  function syncControls() {
    const selected = profiles.find((p) => p.id === $('connection').value);
    $('interval').disabled = busy;
    $('copy-report').disabled = busy || !snapshot;
    $('guided-compare').disabled =
      busy ||
      !snapshot ||
      snapshot.queryMode === 'samples' ||
      !snapshot.capabilities.includes('queries');
    for (const id of [
      'setup-submit',
      'setup-detect',
      'setup-file',
      'reconnect',
      'setup-address',
      'setup-local',
    ])
      $(id).disabled = busy || !trusted;
    for (const id of ['add', 'welcome-add', 'detect', 'project-detect'])
      $(id).disabled = busy || !trusted;
    $('manage').disabled = busy || !trusted || !selected || selected.engine === 'demo';
    for (const id of ['refresh', 'retry', 'live'])
      $(id).disabled =
        busy || !selected || !!selected?.unavailable || (!trusted && selected.engine !== 'demo');
    for (const id of ['baseline', 'export', 'clear-history']) $(id).disabled = busy || !snapshot;
    $('live').disabled =
      !selected ||
      !!selected?.unavailable ||
      (!trusted && selected.engine !== 'demo') ||
      (busy && !monitoring);
    $('clear-baseline').disabled = busy || baseline === null;
    $('analyze').disabled = busy || !trusted || snapshot?.engine !== 'postgres';
    $('explain').disabled =
      busy ||
      !snapshot?.capabilities.includes('explain') ||
      (!trusted && snapshot?.engine !== 'demo');
  }
  function renderSummary() {
    if (!snapshot) return;
    const counts = { critical: 0, warning: 0, info: 0 };
    snapshot.findings.forEach((f) => counts[f.severity]++);
    const box = $('snapshot-summary');
    box.replaceChildren(
      el(
        'strong',
        refreshFailed
          ? 'Last successful snapshot'
          : snapshot.engine === 'demo'
            ? 'Demo findings'
            : 'Snapshot findings',
      ),
    );
    for (const severity of ['critical', 'warning', 'info']) {
      const button = el(
        'button',
        `${counts[severity]} ${severity === 'info' ? 'information' : severity}`,
        'summary-chip ' + severity,
      );
      button.addEventListener('click', () => {
        $('finding-filter').value = severity;
        renderFindings();
        tab('overview');
      });
      box.append(button);
    }
    box.append(
      el('span', 'Based on available statistics; review collection notes.', 'summary-note'),
    );
  }
  function updateTabCounts(s) {
    for (const [id, name, count] of [
      ['queries', 'Queries', s.queries.length],
      ['sessions', 'Sessions & locks', s.sessions.length],
      ['tables', 'Tables & collections', s.tables.length],
      ['indexes', 'Indexes', s.indexes.length],
    ]) {
      const button = document.querySelector(`[data-tab="${id}"]`);
      button.textContent = name + (count === null ? '' : ` (${count})`);
    }
  }
  function renderMonitoringStatus() {
    $('monitor-status').textContent = busy
      ? 'Operation in progress. Cancel to stop it.'
      : monitoring
        ? `Live monitoring · every ${intervalSeconds}s · next refresh in ${Math.max(0, Math.ceil(((nextRefresh || Date.now()) - Date.now()) / 1000))}s`
        : 'Monitoring is paused. Refresh manually when needed.';
  }
  setInterval(renderMonitoringStatus, 1000);
  function renderSnapshot(s, h) {
    snapshot = s;
    refreshFailed = false;
    $('stale').hidden = true;
    $('retry').hidden = true;
    history = h || [];
    $('welcome').hidden = true;
    $('dashboard').hidden = false;
    $('engine').textContent = s.engine.toUpperCase();
    $('updated').textContent = 'Captured ' + new Date(s.timestamp).toLocaleTimeString();
    $('metrics').replaceChildren(
      ...s.metrics.map((m) => {
        const d = el('article', undefined, 'metric');
        d.title = m.description + ' Value: ' + String(m.value);
        d.append(
          el('div', m.label, 'metric-label'),
          el(
            'div',
            m.unit === 'bytes'
              ? bytes(m.value)
              : (typeof m.value === 'number' && Math.abs(m.value) >= 1000000
                  ? new Intl.NumberFormat(undefined, {
                      notation: 'compact',
                      maximumFractionDigits: 2,
                    }).format(m.value)
                  : fmt(m.value)) + (m.unit ? ' ' + m.unit : ''),
            'metric-value',
          ),
          el('div', m.description, 'metric-description'),
        );
        return d;
      }),
    );
    renderGuidance();
    renderSummary();
    updateTabCounts(s);
    renderFindings();
    if (!s.findings.length)
      empty(
        $('findings'),
        'No advisory findings in the available statistics. This is not a complete health assessment.',
      );
    $('notices').replaceChildren(...s.notices.map((n) => el('li', n)));
    renderQueries();
    table(
      'session-table',
      ['Session', 'User', 'State', 'Age (s)', 'Wait', 'Blockers', 'Query'],
      s.sessions.map((r) => [
        r.id,
        r.user,
        r.state,
        fmt(r.ageSeconds),
        r.wait,
        r.blockers.join(', ') || '—',
        el('div', r.query, 'sql'),
      ]),
    );
    const isPg = ['postgres', 'demo'].includes(s.engine);
    table(
      'table-table',
      ['Object', 'Rows / keys', 'Size', 'Seq scans', 'Index scans', 'Dead rows', 'Notes'],
      s.tables.map((t) => [
        t.name,
        ['sqlite', 'mongodb'].includes(s.engine) ? '—' : fmt(t.rows),
        t.sizeBytes ? bytes(t.sizeBytes) : '—',
        isPg ? fmt(t.scans) : '—',
        isPg ? fmt(t.indexScans) : '—',
        isPg ? fmt(t.deadRows) : '—',
        el('div', t.extra || '', 'sql'),
      ]),
    );
    table(
      'index-table',
      ['Index', 'Object', 'Recorded reads', 'Size', 'Definition'],
      s.indexes.map((i) => [
        i.name,
        i.table,
        ['postgres', 'demo', 'sqlserver'].includes(s.engine) ? fmt(i.scans) : '—',
        i.sizeBytes ? bytes(i.sizeBytes) : '—',
        el('div', i.definition, 'sql'),
      ]),
    );
    $('baseline').disabled = busy;
    $('export').disabled = busy;
    $('analyze').disabled = s.engine !== 'postgres' || busy;
    $('explain').disabled = !s.capabilities.includes('explain') || busy;
    const previous = $('trend-metric').value || vscode.getState()?.trendMetric;
    $('trend-metric').replaceChildren(
      ...s.metrics
        .filter((m) => typeof m.value === 'number' && Number.isFinite(m.value))
        .map((m) => {
          const option = el('option', m.label);
          option.value = m.label;
          return option;
        }),
    );
    if ([...$('trend-metric').options].some((x) => x.value === previous))
      $('trend-metric').value = previous;
    $('query-context').textContent =
      s.queryMode === 'samples'
        ? 'Individual profiler or slow-log samples. These are not cumulative workload totals.'
        : 'Cumulative counters since the database statistics reset. Use a baseline to compare an interval.';
    syncControls();
    renderTrend();
  }
  function renderTrend() {
    const svg = $('trend');
    svg.replaceChildren();
    const label = $('trend-metric').value;
    const metric = snapshot?.metrics.find((m) => m.label === label);
    const points = history
      .map((s) => ({
        value: s.metrics.find((m) => m.label === label)?.value,
        timestamp: s.timestamp,
      }))
      .filter((p) => typeof p.value === 'number' && Number.isFinite(p.value));
    const values = points.map((p) => p.value);
    $('trend-label').textContent =
      `${label || 'Metric'} · ${values.length} local samples · oldest to newest`;
    if (values.length < 2) {
      $('trend-stats').textContent = 'Refresh or start monitoring to plot history.';
      svg.setAttribute('hidden', '');
      return;
    }
    svg.removeAttribute('hidden');
    const format = (v) =>
      metric?.unit === 'bytes' ? bytes(v) : fmt(v) + (metric?.unit ? ' ' + metric.unit : '');
    const min = Math.min(...values),
      max = Math.max(...values),
      range = max - min || 1;
    $('trend-stats').textContent =
      `Min ${format(min)} · Max ${format(max)} · Latest ${format(values.at(-1))}`;
    svg.setAttribute('aria-label', `${label}. ${$('trend-stats').textContent}`);
    const ns = 'http://www.w3.org/2000/svg';
    for (const y of [10, 55, 100]) {
      const line = document.createElementNS(ns, 'line');
      for (const [key, value] of Object.entries({
        x1: 0,
        x2: 800,
        y1: y,
        y2: y,
        class: 'trend-grid',
      }))
        line.setAttribute(key, value);
      svg.append(line);
    }
    const coordinates = values.map((v, i) => ({
      x: (i / (values.length - 1)) * 800,
      y: max === min ? 55 : 100 - ((v - min) / range) * 90,
    }));
    const line = document.createElementNS(ns, 'polyline');
    line.setAttribute('points', coordinates.map((p) => `${p.x},${p.y}`).join(' '));
    line.setAttribute('class', 'trend-line');
    svg.append(line);
    coordinates.forEach((p, i) => {
      const point = document.createElementNS(ns, 'circle');
      point.setAttribute('cx', p.x);
      point.setAttribute('cy', p.y);
      point.setAttribute('r', '5');
      point.setAttribute('class', 'trend-point');
      const title = document.createElementNS(ns, 'title');
      title.textContent = `${new Date(points[i].timestamp).toLocaleString()}: ${format(values[i])}`;
      point.append(title);
      svg.append(point);
    });
  }
  function planNode(n) {
    const box = el('div', undefined, 'plan-node');
    box.append(
      el('strong', n.name),
      el(
        'p',
        [
          n.rows !== undefined ? 'Estimated rows ' + fmt(n.rows) : '',
          n.cost !== undefined ? 'Cost ' + fmt(n.cost) : '',
          n.actualMs !== undefined ? 'Actual ' + fmt(n.actualMs) + ' ms per loop' : '',
        ]
          .filter(Boolean)
          .join(' · '),
      ),
    );
    if (n.detail) box.append(el('p', n.detail));
    n.children.forEach((c) => box.append(planNode(c)));
    return box;
  }
  $('connection').addEventListener('change', () => {
    baseline = null;
    $('comparison').replaceChildren();
    $('plan-result').replaceChildren();
    send('select', { id: $('connection').value });
  });
  $('refresh').onclick = $('retry').onclick = () => send('refresh');
  $('trend-metric').onchange = () => {
    vscode.setState({ ...vscode.getState(), trendMetric: $('trend-metric').value });
    renderTrend();
  };
  $('cancel').onclick = () => send('cancel');
  function showSetup() {
    $('setup').hidden = false;
    $('welcome').hidden = true;
    $('dashboard').hidden = true;
    $('setup').scrollIntoView({ block: 'start' });
    $('setup-engine').focus();
  }
  $('add').onclick = $('welcome-add').onclick = showSetup;
  $('setup-close').onclick = () => {
    $('setup').hidden = true;
    $('welcome').hidden = !!shownId;
    $('dashboard').hidden = !shownId;
    $('setup-password').value = '';
    $('setup-uri').value = '';
    $('setup-uri').setCustomValidity('');
    $('setup-show-password').checked = false;
    $('setup-show-password').onchange();
  };
  $('setup-detect').onclick = () => send('detect');
  $('setup-file').onclick = () => send('sqliteFile');
  $('reconnect').onclick = () => send('reconnect');
  let addressMode = false;
  function setupMode(useAddress) {
    addressMode = useAddress;
    $('setup-address-fields').hidden = !useAddress;
    $('setup-fields').hidden = useAddress;
    $('setup-address').setAttribute('aria-pressed', String(useAddress));
    $('setup-local').setAttribute('aria-pressed', String(!useAddress));
    $('setup-uri').required = useAddress;
    $('setup-uri').disabled = !useAddress;
    for (const key of ['host', 'engine', 'database', 'user', 'password', 'port'])
      $('setup-' + key).disabled = useAddress;
    $('setup-port-label').hidden = useAddress;
    $('setup-field-help').hidden = useAddress;
    $('setup-host').required = !useAddress;
    $('setup-hint').textContent = useAddress
      ? 'Paste once and connect. No database type, host or port selection needed.'
      : 'Enter your server address and account details. Under SSH or containers, localhost is the workspace computer.';
    $('setup-' + (useAddress ? 'uri' : 'engine')).focus();
  }
  $('setup-show-password').onchange = () => {
    for (const key of ['password', 'uri'])
      $('setup-' + key).type = $('setup-show-password').checked ? 'text' : 'password';
  };
  $('setup-uri').oninput = () => {
    const value = $('setup-uri').value.trim();
    const scheme = value.match(/^([a-z+]+):\/\//i)?.[1].toLowerCase();
    const names = {
      postgres: 'PostgreSQL',
      postgresql: 'PostgreSQL',
      mysql: 'MySQL',
      mariadb: 'MariaDB',
      mssql: 'SQL Server',
      sqlserver: 'SQL Server',
      mongodb: 'MongoDB',
      'mongodb+srv': 'MongoDB Atlas / SRV',
      redis: 'Redis',
      rediss: 'Redis with TLS',
    };
    const supported = !!names[scheme];
    $('setup-uri').setCustomValidity(
      value && !supported
        ? 'Paste a supported database connection link, including its scheme (for example postgresql://).'
        : '',
    );
    $('setup-link-check').textContent = !value
      ? 'Paste the complete connection link from your provider.'
      : supported
        ? names[scheme] +
          ' link detected. Login and monitoring access will be checked when you connect.'
        : 'This is not a supported database link. Use login details for separate server and account fields.';
  };
  $('setup-address').onclick = () => setupMode(true);
  $('setup-local').onclick = () => setupMode(false);
  const defaults = {
    postgres: [5432, 'postgres'],
    mysql: [3306, ''],
    sqlserver: [1433, 'master'],
    mongodb: [27017, 'admin'],
    redis: [6379, '0'],
  };
  $('setup-engine').onchange = () => {
    const [port, database] = defaults[$('setup-engine').value];
    $('setup-port').value = port;
    $('setup-database').value = database;
    $('setup-field-help').textContent = {
      postgres:
        'Database defaults to postgres. Use your monitoring account; your application may use a different database.',
      mysql: 'Enter your application database name and monitoring account. Standard port: 3306.',
      sqlserver:
        'Database defaults to master. Enter your application database and SQL login. Standard port: 1433.',
      mongodb:
        'For Atlas, SRV or authentication options, use your provider’s connection link. Login details use the database entered here for authentication.',
      redis:
        'Database is a numeric index, usually 0. Leave username empty for password-only authentication.',
    }[$('setup-engine').value];
    $('setup-user').value = {
      postgres: 'postgres',
      mysql: 'root',
      sqlserver: '',
      mongodb: '',
      redis: '',
    }[$('setup-engine').value];
  };
  $('connection-form').onsubmit = (event) => {
    event.preventDefault();
    if (busy || !trusted) return;
    const fields = {};
    for (const key of [
      'engine',
      'uri',
      'host',
      'port',
      'database',
      'user',
      'password',
      'name',
      'security',
    ])
      fields[key] = $('setup-' + key).value;
    if (!addressMode) fields.uri = '';
    send('connect', { ...fields, monitor: $('setup-monitor').checked });
    $('setup-error-details').hidden = true;
    $('setup-status').classList.remove('error');
    $('setup-status').textContent =
      'Checking login and collecting available diagnostics… You can cancel above.';
  };
  $('detect').onclick = $('project-detect').onclick = () => send('detect');
  $('demo').onclick = () => send('demo');
  $('live').onclick = () => send('live');
  $('manage').onclick = () => send('manage');
  $('settings').onclick = () => send('settings');
  $('clear-history').onclick = () => send('clearHistory');
  $('clear-baseline').onclick = () => send('clearBaseline');
  $('finding-filter').onchange = renderFindings;
  for (const id of ['session', 'table', 'index']) {
    $(id + '-filter').oninput = () => {
      const data = tableData.get(id + '-table');
      if (data) table(id + '-table', data.headers, data.rows);
    };
  }
  $('export').onclick = () => send('export');
  $('explain').onclick = () => send('explain', { sql: $('sql').value, execute: false });
  $('analyze').onclick = () => send('explain', { sql: $('sql').value, execute: true });
  $('query-filter').oninput = renderQueries;
  $('query-sort').onchange = renderQueries;
  $('slow-only').onchange = renderQueries;
  $('sort-direction').onclick = () => {
    ascending = !ascending;
    $('sort-direction').textContent = ascending ? 'Lowest first ↑' : 'Highest first ↓';
    $('sort-direction').setAttribute('aria-pressed', String(ascending));
    renderQueries();
  };
  $('interval').onchange = () => send('interval', { seconds: Number($('interval').value) });
  $('baseline').onclick = () => {
    if (!snapshot) return;
    baseline = snapshot.timestamp;
    syncControls();
    send('baseline');
    $('comparison').textContent = 'Baseline saved. Refresh to compare cumulative query counters.';
  };
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'setup') {
      showSetup();
    } else if (m.type === 'setupError') {
      const lines = String(m.message).split('\n');
      $('setup-status').textContent = lines.length > 1 ? lines.at(-1) : m.message;
      $('setup-error-technical').textContent = m.message;
      $('setup-error-details').hidden = false;
      $('setup-status').classList.add('error');
    } else if (m.type === 'helpCopied' || m.type === 'reportCopied') {
      $('copy-status').textContent =
        m.type === 'helpCopied'
          ? 'Administrator request copied. Nothing was sent.'
          : 'Report copied. Review before sharing.';
    } else if (m.type === 'connected') {
      $('setup-password').value = '';
      $('setup-uri').value = '';
      $('setup-uri').setCustomValidity('');
      $('setup-show-password').checked = false;
      $('setup-show-password').onchange();
      $('setup').hidden = true;
      $('setup-status').textContent = 'Connected successfully.';
    } else if (m.type === 'profiles') {
      profiles = m.profiles;
      trusted = m.trusted !== false;
      slowQueryMs = Number.isFinite(m.slowQueryMs) ? m.slowQueryMs : 100;
      $('slow-only').parentElement.title = `Mean latency at least ${slowQueryMs} ms`;
      if (Number.isFinite(m.intervalSeconds)) {
        intervalSeconds = m.intervalSeconds;
        if (![...$('interval').options].some((o) => Number(o.value) === intervalSeconds)) {
          const opt = el('option', `${intervalSeconds} seconds`);
          opt.value = intervalSeconds;
          $('interval').append(opt);
        }
        $('interval').value = String(intervalSeconds);
      }
      $('trust-notice').hidden = trusted;
      const major = Number(String(m.runtimeNode || '22').split('.')[0]);
      $('compatibility-notice').hidden = major >= 22;
      $('compatibility-notice').textContent =
        'Older VS Code runtime: PostgreSQL, MySQL/MariaDB, SQLite and demo are available. Some engines require an update to VS Code 1.101 or newer.';
      const recent =
        profiles.find((p) => p.id === m.recent && p.engine !== 'demo') ||
        profiles.find((p) => p.engine !== 'demo');
      $('reconnect').hidden = !recent;
      $('reconnect').textContent = recent ? 'Reconnect to ' + recent.name : 'Reconnect';
      const selected = m.selected;
      if (shownId !== selected || m.reset) {
        shownId = selected;
        snapshot = null;
        history = [];
        baseline = null;
        tableData.clear();
        for (const id of ['query-filter', 'session-filter', 'table-filter', 'index-filter'])
          $(id).value = '';
        $('finding-filter').value = 'all';
        $('slow-only').checked = false;
        refreshFailed = false;
        $('snapshot-summary').replaceChildren();
        $('trend-stats').textContent = '';
        updateTabCounts({ queries: [], sessions: [], tables: [], indexes: [] });
        $('query-count').textContent = '';
        $('sql').value = '';
        for (const id of [
          'metrics',
          'findings',
          'notices',
          'query-table',
          'session-table',
          'table-table',
          'index-table',
          'plan-result',
          'comparison',
          'trend',
        ])
          $(id).replaceChildren();
        $('error').hidden = true;
        $('stale').hidden = true;
        $('retry').hidden = true;
        $('updated').textContent = 'Ready';
        $('engine').textContent = 'READY';
        $('trend-label').textContent = 'Refresh to build a local history.';
        $('trend-metric').replaceChildren();
        for (const id of ['baseline', 'export', 'explain', 'analyze']) $(id).disabled = true;
      }
      $('connection').replaceChildren(el('option', 'Choose a connection'));
      $('connection').firstChild.value = '';
      for (const p of profiles) {
        const opt = el('option', p.name + ' · ' + p.engine);
        opt.value = p.id;
        opt.title = p.unavailable || p.target || '';
        if (p.unavailable) opt.textContent += ' · update VS Code required';
        $('connection').append(opt);
      }
      $('connection').value = selected || '';
      const profile = profiles.find((p) => p.id === selected);
      $('connection-detail').textContent = profile
        ? `${profile.name} · ${profile.target || ''} · ${profile.engine === 'demo' ? 'Sample data only' : profile.engine === 'sqlite' ? 'Local snapshot' : profile.tls ? 'Verified TLS' : 'Plaintext connection'}`
        : 'Choose a connection or explore the demo to get started.';
      if (profile?.unavailable) {
        $('compatibility-notice').hidden = false;
        $('compatibility-notice').textContent = profile.unavailable;
      }
      syncControls();
      if (snapshot) renderQueries();
      renderMonitoringStatus();
      if (!selected) {
        snapshot = null;
        $('dashboard').hidden = true;
        $('welcome').hidden = false;
      } else if (!snapshot) {
        $('dashboard').hidden = false;
        $('welcome').hidden = true;
      }
      if (!$('setup').hidden) {
        $('welcome').hidden = true;
        $('dashboard').hidden = true;
      }
    } else if (m.type === 'snapshot') {
      renderSnapshot(m.snapshot, m.history);
      $('error').hidden = true;
    } else if (m.type === 'busy') {
      busy = m.value;
      $('busy').hidden = !busy;
      $('cancel').hidden = !busy;
      $('connection').disabled = busy;
      syncControls();
      renderMonitoringStatus();
    } else if (m.type === 'error') {
      $('setup-status').textContent =
        'Connection could not be completed. Review the message below and try again.';
      $('error').textContent = m.message;
      $('error').hidden = false;
      if (m.stale) {
        refreshFailed = true;
        renderSummary();
        $('stale').hidden = !snapshot;
        $('retry').hidden = false;
        if (snapshot)
          $('updated').textContent =
            'Stale · last captured ' + new Date(snapshot.timestamp).toLocaleTimeString();
      }
    } else if (m.type === 'live') {
      $('live').textContent = m.value ? 'Stop monitoring' : 'Start monitoring';
      $('live').setAttribute('aria-pressed', String(m.value));
      monitoring = m.value;
      intervalSeconds = m.intervalSeconds || intervalSeconds;
      nextRefresh = monitoring
        ? Date.now() +
          (Number.isFinite(m.nextRefreshInMs) ? m.nextRefreshInMs : intervalSeconds * 1000)
        : null;
      syncControls();
      renderMonitoringStatus();
    } else if (m.type === 'plan') {
      const box = $('plan-result');
      box.replaceChildren(
        el(
          'p',
          `${m.plan.executed ? 'Executed' : 'Estimated'} plan · ${fmt(m.plan.elapsedMs)} ms including connection setup`,
        ),
        ...m.plan.findings.map(finding),
        ...m.plan.nodes.map(planNode),
      );
      const d = el('details');
      d.append(el('summary', 'Raw plan'), el('pre', JSON.stringify(m.plan.raw, null, 2)));
      box.append(d);
      tab('plan');
    } else if (m.type === 'sql') {
      $('sql').value = m.sql;
      tab('plan');
    } else if (m.type === 'baselineState') {
      baseline = m.timestamp;
      if (snapshot) renderGuidance();
      syncControls();
    } else if (m.type === 'baselineCleared') {
      baseline = null;
      if (snapshot) renderGuidance();
      $('comparison').replaceChildren();
      syncControls();
    } else if (m.type === 'comparison') {
      $('comparison').replaceChildren(
        el('h3', 'Compared with baseline'),
        el(
          'p',
          m.comparison.incompatible
            ? 'Interval comparisons need cumulative query statistics from the same connection.'
            : m.comparison.reset
              ? 'Server restart or statistics reset detected; counter deltas are unavailable.'
              : `${fmt(m.comparison.elapsedSeconds)} seconds since baseline. Negative or missing counters are excluded.`,
        ),
      );
      const valid = m.comparison.queries.filter((q) => q.callsDelta !== null);
      const ul = el('ul');
      valid
        .slice(0, 15)
        .forEach((q) =>
          ul.append(
            el(
              'li',
              `${q.id}: +${fmt(q.callsDelta)} calls · +${fmt(q.totalMsDelta)} ms · ${q.intervalMeanMs === null ? '—' : fmt(q.intervalMeanMs)} ms interval mean`,
            ),
          ),
        );
      $('comparison').append(ul);
    } else if (m.type === 'discovery') {
      $('setup').hidden = true;
      const d = $('discovery');
      d.replaceChildren(
        el('h3', 'Frameworks'),
        el('p', m.frameworks.join(', ') || 'No supported frameworks detected.'),
        el('h3', 'Models'),
      );
      const list = el('ul');
      m.models.forEach((x) => list.append(el('li', x.name + ' · ' + x.source)));
      d.append(list, el('h3', 'Connection candidates'));
      const candidates = el('ul');
      m.connections.forEach((x) =>
        candidates.append(el('li', x.engine + ' · ' + x.target + ' · ' + x.source)),
      );
      d.append(candidates, ...m.notices.map((n) => el('p', n)));
      $('dashboard').hidden = false;
      $('welcome').hidden = true;
      tab('project');
    }
  });

  function applyView() {
    const simple = $('view-mode').value === 'simple';
    document.body.classList.toggle('simple-view', simple);
    vscode.setState({ ...vscode.getState(), mode: $('view-mode').value });
    if (simple) tab('overview');
  }
  $('view-mode').value = state.mode || 'simple';
  $('view-mode').onchange = applyView;
  const help = () => {
    $('connection-assistance').hidden = false;
    $('connection-assistance').scrollIntoView({ block: 'start' });
    $('copy-help').focus();
  };
  $('welcome-help').onclick = $('setup-help').onclick = $('readiness-help').onclick = help;
  $('help-close').onclick = () => {
    $('connection-assistance').hidden = true;
  };
  $('copy-help').onclick = () => send('copyHelp');
  $('copy-report').onclick = () => send('copyReport');
  $('guided-compare').onclick = () => {
    if (!snapshot || busy) return;
    if (!baseline) {
      send('baseline');
      $('next-description').textContent =
        'Before-change snapshot saved. After your developer makes a change, use the application normally, then click Check again. Similar workloads give more useful comparisons.';
    } else {
      send('refresh');
      tab('overview');
    }
  };
  function renderGuidance() {
    const s = snapshot;
    const availability = s.availability || [];
    const limited = availability.some((a) => !['available', 'unsupported'].includes(a.state));
    const active = s.recentQueryCalls === undefined ? s.queries.length > 0 : s.recentQueryCalls > 0;
    $('next-title').textContent =
      s.engine === 'demo'
        ? 'Sample results — your database is not connected'
        : limited
          ? 'Connected with limited visibility'
          : s.findings.length
            ? 'Some checks need attention'
            : !active && s.engine !== 'sqlite'
              ? 'Not enough query activity to assess performance'
              : 'No issues detected by the available checks';
    $('next-description').textContent = baseline
      ? 'Before-change snapshot saved. After a change, use the application normally and click Check again. Compare similar workloads; differences alone do not prove that a change helped.'
      : limited
        ? 'Some diagnostics need administrator help. You can use the available results now; missing data does not mean the database is healthy.'
        : s.findings.length
          ? 'Start with the findings below. Each explains the evidence and a next step. Copy a report if a developer needs to help.'
          : 'Use your application normally and check again. These checks are advisory and do not cover every possible issue.';
    $('observation').textContent =
      s.observation ||
      (s.queryMode === 'samples'
        ? 'Query information contains individual samples, not a complete workload history.'
        : 'First-check query totals are historical. Refresh again to assess matched recent activity.');
    const labels = {
      available: 'Available',
      unsupported: 'Not collected for this engine',
      'permission-required': 'Monitoring access needed',
      'not-configured': 'Setup needed',
      failed: 'Check failed',
    };
    $('readiness').replaceChildren(
      ...availability
        .filter((a) => a.state !== 'unsupported')
        .map((a) => {
          const row = el('p');
          row.append(
            el('strong', `${a.label}: ${labels[a.state] || a.state}. `),
            document.createTextNode(a.action),
          );
          return row;
        }),
    );
    const unsupported = availability.filter((a) => a.state === 'unsupported');
    if (unsupported.length)
      $('readiness').append(
        el('p', 'Not collected for this engine: ' + unsupported.map((a) => a.label).join(', ')),
      );
    if (!availability.length)
      $('readiness').append(el('p', 'Available sections: ' + s.capabilities.join(', ')));
    $('guided-compare').disabled =
      busy || s.queryMode === 'samples' || !s.capabilities.includes('queries');
    $('guided-compare').textContent = baseline
      ? 'Check again and compare'
      : 'Check again after a change';
  }
  applyView();
  syncControls();
  tab(state.mode === 'advanced' ? state.tab || 'overview' : 'overview');
  // Restore advanced navigation only when explicitly selected.

  send('ready');
})();
