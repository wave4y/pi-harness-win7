(function () {
  'use strict';

  const sessionGroups = window.PiSessionGroups;
  const groupStorageKey = 'pi-harness.workspace-groups.v1';
  const byId = function (id) { return document.getElementById(id); };
  const state = { token: '', bootstrap: null, directory: '', file: null, original: '', rawOriginal: '', lineEnding: '\n', saving: false, ready: false, busy: false, diff: false, context: '', abort: null, cancelled: false, toolCards: new Map(), activeMessage: null, directoryRequest: 0, fileRequest: 0, sessions: [], folderRequest: 0, folderPath: '', folderTarget: '', folderLoading: false };
  const ui = {
    messages: byId('messages'), welcome: byId('welcome'), input: byId('message-input'), send: byId('send-button'), cancel: byId('cancel-button'), editor: byId('file-editor'), editorPanel: byId('editor-panel'), settings: byId('settings-dialog'), fileList: byId('file-list')
  };
  let toastTimer;
  const permissionModes = [
    { value: 'read-only', name: '仅可查看', description: '直接读取工作区文件；修改文件、工作区外访问和外部工具需要逐次批准。' },
    { value: 'workspace-write', name: '工作区内修改', description: '直接读写工作区文件；工作区外访问、外部程序和 MCP 工具需要逐次批准。' },
    { value: 'danger-full-access', name: '完全权限', description: '直接访问当前 Windows 用户可访问的本机文件和外部工具，无需逐次确认。' }
  ];
  state.approvals = new Map();
  state.extensions = null;
  state.extensionsLoading = false;
  state.settingsTab = 'model';
  state.contextStats = null;
  state.permissionSaving = false;
  state.lastCompaction = null;
  state.compactionError = null;
  state.queueSending = false;
  state.compacting = false;
  state.undelivered = [];
  state.restoredQueueIds = new Set();
  state.groupExpansion = loadGroupExpansion();
  state.searchGroupExpansion = Object.create(null);
  state.sessionSearch = '';
  state.sessionStats = null;
  state.statsRequest = 0;
  state.statsTimer = null;
  state.statsPanel = null;
  state.statsError = false;

  function statNumber(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }
  function statDuration(value) {
    if (!statNumber(value)) return '—';
    const seconds = value / 1000;
    if (seconds < 60) return (Math.round(seconds * 10) / 10) + '秒';
    const whole = Math.round(seconds);
    return Math.floor(whole / 60) + '分' + (whole % 60) + '秒';
  }
  function statTokens(value, exact) {
    if (!statNumber(value)) return '—';
    if (exact) return value.toLocaleString('zh-CN') + ' tok';
    const scaled = function (number) { return String(number >= 100 ? Math.round(number) : Math.round(number * 10) / 10); };
    return (value < 1000 ? String(value) : value < 1000000 ? scaled(value / 1000) + 'K' : scaled(value / 1000000) + 'M') + ' tok';
  }
  function statSpeed(value) { return statNumber(value) ? (Math.round(value * 10) / 10) + ' tok/s' : '—'; }
  function statCache(rate) {
    if (!statNumber(rate) || rate > 1) return null;
    if (rate === 1) return '100';
    const percent = rate * 100;
    if (Math.round(percent) < 100) return String(Math.round(percent));
    // A partial cache hit must never round up to a claim of complete reuse.
    for (let places = 1; places <= 12; places++) {
      const text = percent.toFixed(places);
      if (Number(text) < 100) return text.replace(/0+$/, '').replace(/\.$/, '');
    }
    return '<100';
  }
  function statPillLabel(id, pieces) {
    const label = byId(id); label.replaceChildren();
    pieces.forEach(function (piece, index) {
      if (index) { const separator = make('span', 'dsh-stat-separator', '·'); separator.setAttribute('aria-hidden', 'true'); label.appendChild(separator); }
      label.appendChild(document.createTextNode(piece));
    });
  }
  function closeSessionStats(restoreFocus) {
    const kind = state.statsPanel;
    state.statsPanel = null;
    byId('session-stats-panel').hidden = true;
    ['time', 'usage'].forEach(function (name) { byId('session-stats-' + name).setAttribute('aria-expanded', 'false'); });
    if (restoreFocus && kind && !byId('session-stats').hidden) byId('session-stats-' + kind).focus();
  }
  function positionSessionStats() {
    if (!state.statsPanel) return;
    const panel = byId('session-stats-panel');
    const anchor = byId('session-stats-' + state.statsPanel).getBoundingClientRect();
    const width = panel.offsetWidth, height = panel.offsetHeight;
    panel.style.left = Math.max(12, Math.min(anchor.left, window.innerWidth - width - 12)) + 'px';
    panel.style.top = Math.max(12, Math.min(anchor.top - height - 8, window.innerHeight - height - 12)) + 'px';
    panel.style.visibility = 'visible';
  }
  function renderStatsPanel() {
    const stats = state.sessionStats;
    if (!state.statsPanel || !stats) return;
    const usage = stats.usage || {};
    const coverage = stats.coverage || {};
    const reported = Number(usage.reportedSteps || 0), missing = Number(usage.missingSteps || 0);
    const cached = Number(usage.cacheReportedSteps || 0);
    const usageKnown = reported > 0 || (Number(stats.steps || 0) === 0 && missing === 0);
    const cacheHit = cached > 0 ? statCache(usage.cacheHitRate) : null;
    const rows = byId('session-stats-details'); rows.replaceChildren();
    const notes = [];
    function row(label, value) { rows.appendChild(make('dt', '', label)); rows.appendChild(make('dd', '', value)); }
    const isTime = state.statsPanel === 'time';
    byId('session-stats-title').textContent = isTime ? '会话统计' : 'Token 用量';
    byId('session-stats-panel-icon').replaceChildren(icon(isTime ? 'stats-gauge' : 'stats-database'));
    byId('session-stats-headline').textContent = isTime ? stats.turns + ' 轮 ' + stats.steps + ' 步' : statTokens(usageKnown ? usage.total : null, true);
    if (isTime) {
      row('模型用时', statDuration(stats.modelTimeMs));
      row('工具调用用时', statDuration(stats.toolTimeMs));
      row('首 token 平均（TTFT）', statDuration(stats.averageFirstTokenMs));
      row('输出速度（TPS）', statSpeed(stats.tokensPerSecond));
      if (Number(coverage.timedSteps || 0) < Number(stats.steps || 0)) notes.push('部分数据：' + Number(coverage.timedSteps || 0) + ' / ' + stats.steps + ' 个步骤有计时记录，旧历史的用时无法补算。');
      if (Number(coverage.toolTimedCalls || 0) < Number(coverage.toolCalls || 0)) notes.push('工具计时覆盖 ' + Number(coverage.toolTimedCalls || 0) + ' / ' + Number(coverage.toolCalls || 0) + ' 次调用。');
    } else {
      row('缓存命中', cacheHit === null ? '—' : cacheHit + '%');
      row(cached === reported && reported > 0 ? '未缓存输入' : cached === 0 ? '输入（未区分缓存）' : '输入（部分未区分缓存）', statTokens(usageKnown ? usage.input : null, true));
      row('缓存读取', statTokens(cached > 0 ? usage.cacheRead : null, true));
      if (cached === 0 || Number(usage.cacheWrite || 0) > 0) row('缓存写入', statTokens(cached > 0 ? usage.cacheWrite : null, true));
      row('输出', statTokens(usageKnown ? usage.output : null, true));
      if (missing > 0) notes.push(usageKnown ? '部分数据：累计值仅包含 ' + reported + ' 个已报告用量的步骤；另有 ' + missing + ' 个步骤未报告。' : '模型未报告这些步骤的 Token 用量，不能按 0 计算。');
      if (cached === 0) notes.push('服务商未报告缓存明细，缓存用量与命中率未知。');
      else if (cached < reported) notes.push('缓存明细仅覆盖 ' + cached + ' / ' + reported + ' 个已报告用量的步骤；命中率按这些步骤计算。');
    }
    const summary = stats.summary || {};
    if (Number(summary.requests || 0) > 0) {
      const summaryUsage = summary.usage || {};
      row('摘要请求（另计）', summary.requests + ' 次 · ' + statTokens(Number(summaryUsage.reportedSteps || 0) > 0 ? summaryUsage.total : null, true));
      notes.push('摘要请求的用量单独记录，未计入会话 Token 总量。' + (Number(summaryUsage.missingSteps || 0) > 0 ? '部分摘要请求未报告用量。' : ''));
    }
    if (state.statsError) notes.push('统计暂时无法刷新，当前显示上次收到的数据。');
    byId('session-stats-notes').textContent = notes.join('\n');
    byId('session-stats-notes').hidden = !notes.length;
    positionSessionStats();
  }
  function renderSessionStats() {
    const stats = state.sessionStats;
    const visible = !!stats && (Number(stats.steps || 0) > 0 || Number((stats.summary || {}).requests || 0) > 0);
    byId('session-stats').hidden = !visible;
    byId('session-stats').parentElement.classList.toggle('has-session-stats', visible);
    if (!visible) closeSessionStats(false);
    else {
      const timing = [stats.turns + ' 轮 ' + stats.steps + ' 步'];
      if (statNumber(stats.tokensPerSecond)) timing.push(statSpeed(stats.tokensPerSecond));
      statPillLabel('session-stats-time-label', timing);
      byId('session-stats-time').setAttribute('aria-label', '会话统计：' + timing.join(' · '));
      const usage = stats.usage || {};
      const known = Number(usage.reportedSteps || 0) > 0 || (Number(stats.steps || 0) === 0 && Number(usage.missingSteps || 0) === 0);
      const cacheHit = Number(usage.cacheReportedSteps || 0) > 0 ? statCache(usage.cacheHitRate) : null;
      const tokens = [statTokens(known ? usage.total : null, false)];
      if (cacheHit !== null) tokens.push('缓存命中 ' + cacheHit + '%');
      if (known && Number(usage.missingSteps || 0) > 0) tokens.push('部分数据');
      statPillLabel('session-stats-usage-label', tokens);
      byId('session-stats-usage').setAttribute('aria-label', 'Token 用量：' + tokens.join(' · '));
      renderStatsPanel();
    }
    scheduleStatsRefresh();
  }
  function acceptSessionStats(stats, invalidatePending) {
    if (!stats || stats.sessionId !== (state.bootstrap || {}).sessionId) return;
    if (invalidatePending) state.statsRequest++;
    state.sessionStats = stats; state.statsError = false; renderSessionStats();
  }
  async function refreshSessionStats() {
    const sessionId = (state.bootstrap || {}).sessionId;
    if (!sessionId || !state.token) return;
    const request = ++state.statsRequest;
    try {
      const stats = await json('/api/session/stats');
      if (request !== state.statsRequest || sessionId !== (state.bootstrap || {}).sessionId || stats.sessionId !== sessionId) return;
      acceptSessionStats(stats, false);
    } catch (_) {
      if (request !== state.statsRequest || sessionId !== (state.bootstrap || {}).sessionId) return;
      state.statsError = true; renderStatsPanel();
    }
  }
  function scheduleStatsRefresh() {
    clearTimeout(state.statsTimer); state.statsTimer = null;
    if (!state.busy || document.hidden || byId('session-stats').hidden) return;
    state.statsTimer = setTimeout(async function () { state.statsTimer = null; await refreshSessionStats(); scheduleStatsRefresh(); }, 3000);
  }
  function openSessionStats(kind) {
    if (!state.sessionStats || byId('session-stats').hidden) return;
    if (state.statsPanel === kind) { closeSessionStats(true); return; }
    state.statsPanel = kind;
    ['time', 'usage'].forEach(function (name) { byId('session-stats-' + name).setAttribute('aria-expanded', String(name === kind)); });
    const panel = byId('session-stats-panel'); panel.style.visibility = 'hidden'; panel.hidden = false;
    renderStatsPanel(); panel.focus({preventScroll: true});
    refreshSessionStats();
  }

  function loadGroupExpansion() {
    try { return sessionGroups.parseExpansion(window.localStorage.getItem(groupStorageKey)); }
    catch (_) { return Object.create(null); }
  }
  function saveGroupExpansion() {
    try { window.localStorage.setItem(groupStorageKey, JSON.stringify(state.groupExpansion)); }
    catch (_) { /* Sidebar preferences must never prevent opening a conversation. */ }
  }

  function permissionMode() { return (state.bootstrap || {}).permissionMode || 'workspace-write'; }
  function updatePermission() {
    const current = permissionModes.find(function (item) { return item.value === permissionMode(); }) || permissionModes[1];
    byId('permission-label').textContent = current.name;
    byId('permission-icon').replaceChildren(icon('permission-' + current.value));
    byId('permission-button').title = current.description;
    byId('permission-button').setAttribute('aria-label', '访问模式，当前：' + current.name);
    byId('permission-button').disabled = state.busy || state.permissionSaving;
  }
  function closePermissionMenu() {
    byId('permission-menu').hidden = true;
    byId('permission-button').setAttribute('aria-expanded', 'false');
    byId('permission-button').querySelector('.dsh-permission-chevron').classList.remove('dsh-permission-chevronOpen');
  }
  function openPermissionMenu() {
    if (state.busy || state.permissionSaving) return;
    const menu = byId('permission-menu');
    if (!menu.hidden) { closePermissionMenu(); return; }
    menu.replaceChildren();
    permissionModes.forEach(function (option) {
      const button = make('button', 'dsh-menu-item');
      button.type = 'button';
      button.setAttribute('role', 'menuitemradio');
      button.setAttribute('aria-checked', String(option.value === permissionMode()));
      button.title = option.description;
      const seat = make('span', 'dsh-menu-itemIcon');
      seat.appendChild(icon('permission-' + option.value));
      button.appendChild(seat);
      button.appendChild(make('span', 'dsh-menu-itemLabel', option.name));
      if (option.value === permissionMode()) button.appendChild(icon('check'));
      button.addEventListener('click', function () {
        closePermissionMenu();
        if (option.value === permissionMode()) return;
        if (option.value === 'danger-full-access') {
          byId('acknowledge-full-access').checked = false;
          byId('enable-full-access').disabled = true;
          byId('full-access-dialog').showModal();
        } else selectPermission(option.value);
      });
      menu.appendChild(button);
    });
    const rect = byId('permission-button').getBoundingClientRect();
    menu.hidden = false;
    menu.style.left = Math.max(12, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 12)) + 'px';
    menu.style.top = Math.max(12, rect.top - menu.offsetHeight - 6) + 'px';
    byId('permission-button').setAttribute('aria-expanded', 'true');
    byId('permission-button').querySelector('.dsh-permission-chevron').classList.add('dsh-permission-chevronOpen');
    menu.querySelector('[aria-checked="true"]').focus();
  }
  async function selectPermission(mode) {
    if (state.busy || state.permissionSaving) return;
    state.permissionSaving = true;
    updatePermission();
    try {
      updateBootstrap(await json('/api/permissions', { method: 'POST', body: { mode: mode } }));
      toast('访问模式已更新为' + byId('permission-label').textContent);
    } catch (error) { toast(error.message, true); }
    finally { state.permissionSaving = false; updatePermission(); byId('permission-button').focus(); }
  }
  function showApproval(request) {
    if (!request || !request.id || state.approvals.has(request.id)) return;
    ui.welcome.hidden = true;
    setEmpty(false);
    const card = make('section', 'approval-card');
    card.setAttribute('aria-label', '工具权限请求');
    const heading = make('div', 'approval-heading');
    heading.appendChild(icon('permission-' + permissionMode()));
    heading.appendChild(make('strong', '', '需要你的批准'));
    card.appendChild(heading);
    card.appendChild(make('p', 'approval-reason', request.reason || '此操作需要确认后才能执行。'));
    card.appendChild(make('div', 'tool-label', request.toolName || '工具调用'));
    card.appendChild(make('pre', 'approval-args', stringify(request.args || {})));
    const actions = make('div', 'approval-actions');
    const status = make('span', 'approval-status', '等待批准');
    actions.appendChild(status);
    const deny = make('button', 'dsh-button-button dsh-button-sm dsh-button-outline', '拒绝');
    const allow = make('button', 'dsh-button-button dsh-button-sm dsh-button-primary', '允许这次');
    deny.type = 'button'; allow.type = 'button';
    [deny, allow].forEach(function (button) { actions.appendChild(button); });
    deny.addEventListener('click', function () { resolveApproval(request.id, 'deny'); });
    allow.addEventListener('click', function () { resolveApproval(request.id, 'allow'); });
    card.appendChild(actions);
    ui.messages.appendChild(card);
    state.approvals.set(request.id, { card: card, status: status, allow: allow, deny: deny, toolCallId: request.toolCallId });
    byId('session-status').textContent = '等待你的批准';
    scrollToBottom(true);
  }
  function approvalResolved(id, decision) {
    const item = state.approvals.get(id);
    if (!item) return;
    item.allow.disabled = true; item.deny.disabled = true;
    item.status.textContent = decision === 'allow' ? '已允许这次操作' : decision === 'deny' ? '已拒绝' : '请求已结束';
    item.card.classList.add('resolved');
    const tool = state.toolCards.get(item.toolCallId);
    if (tool) tool.status.textContent = decision === 'allow' ? '执行中' : decision === 'deny' ? '已拒绝' : '已结束';
  }
  async function resolveApproval(id, decision) {
    const item = state.approvals.get(id);
    if (!item) return;
    item.allow.disabled = true; item.deny.disabled = true;
    try {
      await json('/api/approval', { method: 'POST', body: { id: id, decision: decision } });
      approvalResolved(id, decision);
      if (state.busy) byId('session-status').textContent = decision === 'allow' ? 'Pi 正在继续' : '已拒绝该操作';
    } catch (error) { item.allow.disabled = false; item.deny.disabled = false; item.status.textContent = error.message; }
  }
  function tokenLabel(value) { return Number(value || 0).toLocaleString('zh-CN'); }
  function updateContext(stats) {
    if (stats) state.contextStats = stats;
    const current = state.contextStats;
    const config = state.bootstrap || {};
    const windowSize = current ? current.contextWindow : config.contextWindow;
    const text = current ? '约 ' + tokenLabel(current.estimatedTokens) + ' / ' + tokenLabel(windowSize) : tokenLabel(windowSize || 64000) + ' tokens';
    byId('context-usage').textContent = '上下文 ' + text;
    byId('context-usage').title = current ? '估算输入 ' + tokenLabel(current.estimatedTokens) + ' tokens；输入预算 ' + tokenLabel(current.inputBudget) + ' tokens。点击调整上下文设置。' : '点击设置上下文窗口，其他参数自动计算';
    const budget = config.contextBudget;
    const budgetHint = budget ? '输入预算 ' + tokenLabel(budget.inputBudget) + ' tokens' + ((config.compaction || {}).enabled !== false ? ' · 约在 ' + tokenLabel(budget.compactionThreshold) + ' tokens 时自动压缩' : '') : '开始对话后，在这里查看上下文用量。';
    byId('context-details').textContent = current ? '当前估算输入 ' + tokenLabel(current.estimatedTokens) + ' tokens · 输入预算 ' + tokenLabel(current.inputBudget) + ' tokens' : budgetHint;
    const last = state.lastCompaction;
    byId('compaction-state').textContent = last ? '已生成上下文摘要' + (last.summaryTokens ? ' · 约 ' + tokenLabel(last.summaryTokens) + ' tokens' : '') : '';
  }

  function toast(message, error) {
    const element = byId('toast');
    element.textContent = message;
    element.classList.toggle('error', Boolean(error));
    element.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { element.hidden = true; }, error ? 6500 : 3200);
  }

  async function api(path, options) {
    const init = Object.assign({ credentials: 'same-origin' }, options || {});
    init.headers = Object.assign({ 'X-Agent-Token': state.token }, init.headers || {});
    if (init.body && typeof init.body !== 'string') {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(init.body);
    }
    const response = await fetch(path, init);
    if (!response.ok) {
      const data = await response.json().catch(function () { return {}; });
      throw new Error(data.error || data.message || '请求失败（' + response.status + '）');
    }
    return response;
  }

  async function json(path, options) {
    const response = await api(path, options);
    if (response.status === 204) return {};
    return response.json();
  }

  function basename(path) { return (path || '').replace(/[\\/]$/, '').split(/[\\/]/).pop() || path || '本地项目'; }
  function sizeLabel(bytes) {
    if (bytes == null) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' K';
    return (bytes / (1024 * 1024)).toFixed(1) + ' M';
  }
  function icon(name) {
    const element = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    element.setAttribute('class', 'icon');
    element.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-' + name);
    element.appendChild(use);
    return element;
  }
  function make(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = text;
    return element;
  }

  function updateBootstrap(data) {
    const previousSession = (state.bootstrap || {}).sessionId;
    state.bootstrap = data;
    if (previousSession !== data.sessionId) {
      state.statsRequest++; state.sessionStats = null; state.statsError = false; closeSessionStats(false); renderSessionStats();
    }
    if (data.sessionStats) acceptSessionStats(data.sessionStats, true);
    if (data.csrfToken) state.token = data.csrfToken;
    byId('workspace-name').textContent = basename(data.workspace);
    byId('workspace-path').textContent = data.workspace || '请选择工作目录';
    byId('workspace-button').title = data.workspace || '设置工作目录';
    byId('conversation-workspace').textContent = basename(data.workspace);
    byId('model-label').textContent = data.model || '尚未配置模型';
    byId('connection-status').classList.remove('error');
    byId('connection-status').lastElementChild.textContent = '本地服务已连接';
    if (Array.isArray(data.undeliveredMessages)) { state.undelivered = data.undeliveredMessages; renderQueueDrafts(); }
    byId('workspace-missing').hidden = !data.workspaceMissing;
    if (data.storage) renderStorage(data.storage);
    updatePermission();
    state.contextStats = data.contextStats || null;
    state.lastCompaction = data.lastCompaction || null;
    updateContext();
    ui.input.disabled = !state.ready;
    updateSend();
  }

  async function bootstrap() {
    const response = await fetch('/api/bootstrap', { credentials: 'same-origin' });
    if (!response.ok) throw new Error('无法连接本地服务（' + response.status + '）');
    updateBootstrap(await response.json());
  }

  async function loadFiles(directory) {
    const request = ++state.directoryRequest;
    if ((state.bootstrap || {}).workspaceMissing) { state.directory = ''; ui.fileList.replaceChildren(make('p', 'muted empty-small', '原工作文件夹已不存在，请选择新的工作文件夹。')); return; }
    try {
      const result = await json('/api/files?path=' + encodeURIComponent(directory || ''));
      if (request !== state.directoryRequest) return;
      state.directory = result.path && result.path !== '.' ? result.path : '';
      byId('directory-label').textContent = state.directory || '/';
      byId('directory-label').title = state.directory || '/';
      byId('parent-directory').disabled = !state.directory;
      ui.fileList.replaceChildren();
      const entries = (result.entries || []).slice().sort(function (a, b) {
        const aDir = a.type === 'directory';
        const bDir = b.type === 'directory';
        return aDir !== bDir ? (aDir ? -1 : 1) : a.name.localeCompare(b.name, 'zh-CN', { numeric: true });
      });
      if (!entries.length) ui.fileList.appendChild(make('p', 'muted empty-small', '这个文件夹还是空的。'));
      entries.forEach(function (entry) {
        const directoryEntry = entry.type === 'directory';
        const button = make('button', 'file-item' + (directoryEntry ? ' directory' : ''));
        button.title = entry.path;
        button.dataset.path = entry.path;
        button.classList.toggle('active', entry.path === state.file);
        button.appendChild(icon(directoryEntry ? 'folder' : 'file'));
        button.appendChild(make('span', 'filename', entry.name));
        if (!directoryEntry) button.appendChild(make('span', 'file-size', sizeLabel(entry.size)));
        button.addEventListener('click', function () { if (directoryEntry) loadFiles(entry.path); else openFile(entry.path); });
        ui.fileList.appendChild(button);
      });
    } catch (error) {
      if (request !== state.directoryRequest) return;
      ui.fileList.replaceChildren(make('p', 'muted empty-small', error.message));
      toast('读取目录失败：' + error.message, true);
    }
  }

  function hasEdits() { return state.file !== null && ui.editor.value !== state.original; }
  function confirmDiscard() { return !hasEdits() || window.confirm('当前文件有未保存的修改，确定放弃这些修改？'); }
  function markEdited() {
    const changed = hasEdits();
    byId('unsaved-indicator').hidden = !changed;
    byId('save-file').disabled = !changed || state.busy || state.saving;
    byId('show-diff').disabled = !changed && !state.diff;
    const lines = ui.editor.value.split('\n').length;
    byId('editor-status').textContent = 'UTF-8 · ' + lines + ' 行' + (changed ? ' · 尚未保存' : '');
  }
  function setDiff(show) {
    state.diff = show;
    ui.editor.hidden = show;
    byId('diff-view').hidden = !show;
    byId('show-diff').textContent = show ? '返回编辑' : '查看修改';
    if (show) {
      byId('diff-before').textContent = state.original;
      byId('diff-after').textContent = ui.editor.value;
    }
    markEdited();
  }
  async function openFile(path) {
    if (!confirmDiscard()) return;
    const request = ++state.fileRequest;
    try {
      const result = await json('/api/file?path=' + encodeURIComponent(path));
      if (request !== state.fileRequest) return;
      state.file = result.path || path;
      state.rawOriginal = result.content;
      state.lineEnding = result.content.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
      ui.editor.value = result.content;
      state.original = ui.editor.value;
      byId('editor-name').textContent = basename(state.file);
      byId('editor-path').textContent = state.file;
      ui.editorPanel.hidden = false;
      document.querySelector('.workspace-layout').classList.add('editor-open');
      byId('file-sidebar').classList.remove('mobile-open');
      setDiff(false);
      ui.fileList.querySelectorAll('.file-item').forEach(function (button) { button.classList.toggle('active', button.dataset.path === state.file); });
    } catch (error) { toast('打开文件失败：' + error.message, true); }
  }
  function closeEditor() {
    if (!confirmDiscard()) return;
    state.fileRequest++;
    state.file = null;
    state.original = '';
    ui.editor.value = '';
    ui.editorPanel.hidden = true;
    document.querySelector('.workspace-layout').classList.remove('editor-open');
    ui.fileList.querySelectorAll('.file-item.active').forEach(function (button) { button.classList.remove('active'); });
  }
  async function saveFile() {
    if (!state.file || state.busy || state.saving || !hasEdits()) return;
    const path = state.file;
    const displayContent = ui.editor.value;
    const content = state.lineEnding === '\r\n' ? displayContent.replace(/\n/g, '\r\n') : displayContent;
    const originalContent = state.rawOriginal;
    state.saving = true;
    byId('save-file').disabled = true;
    try {
      await json('/api/file', { method: 'PUT', body: { path: path, content: content, originalContent: originalContent } });
      if (state.file === path) { state.original = displayContent; state.rawOriginal = content; setDiff(false); }
      toast('文件已保存');
      loadFiles(state.directory);
    } catch (error) { toast('保存失败：' + error.message, true); }
    finally { state.saving = false; markEdited(); }
  }

  function scrollToBottom(force) {
    if (force || ui.messages.scrollHeight - ui.messages.scrollTop - ui.messages.clientHeight < 160) ui.messages.scrollTop = ui.messages.scrollHeight;
  }

  function inlineText(parent, text) {
    // Render only plain text, bold, and inline code. Model text never becomes HTML.
    const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
    let position = 0;
    let match;
    while ((match = pattern.exec(text))) {
      parent.appendChild(document.createTextNode(text.slice(position, match.index)));
      const code = match[0][0] === '`';
      parent.appendChild(make(code ? 'code' : 'strong', '', match[0].slice(code ? 1 : 2, code ? -1 : -2)));
      position = pattern.lastIndex;
    }
    parent.appendChild(document.createTextNode(text.slice(position)));
  }

  function renderText(element, text) {
    element.replaceChildren();
    if (text.indexOf('```') < 0) { inlineText(element, text); return; }
    // A small, deliberately restricted renderer with support for fenced code blocks.
    const chunks = text.split(/(```[\s\S]*?(?:```|$))/g);
    chunks.forEach(function (chunk) {
      if (!chunk) return;
      if (chunk.indexOf('```') === 0) {
        let code = chunk.slice(3);
        const firstLine = code.indexOf('\n');
        if (firstLine >= 0) code = code.slice(firstLine + 1);
        if (code.endsWith('```')) code = code.slice(0, -3);
        const pre = make('pre');
        pre.appendChild(make('code', '', code.replace(/\n$/, '')));
        element.appendChild(pre);
      } else inlineText(element, chunk);
    });
  }

  function addMessage(role, content) {
    ui.welcome.hidden = true;
    setEmpty(false);
    const article = make('article', 'message ' + role);
    const heading = make('div', 'message-heading');
    heading.appendChild(make('span', 'message-avatar', role === 'user' ? '你' : 'π'));
    heading.appendChild(make('span', '', role === 'user' ? '你' : 'Pi'));
    const body = make('div', 'message-body');
    renderText(body, content || '');
    article.appendChild(heading);
    article.appendChild(body);
    ui.messages.appendChild(article);
    const item = { article: article, body: body, text: content || '' };
    scrollToBottom(true);
    return item;
  }

  function resetMessages() {
    ui.messages.replaceChildren(ui.welcome);
    ui.welcome.hidden = false;
    state.toolCards.clear();
    state.approvals.clear();
    state.activeMessage = null;
    setEmpty(true);
    byId('conversation-title').textContent = '新会话';
  }

  function setEmpty(empty) {
    document.querySelector('.conversation-panel').classList.toggle('empty', empty);
    byId('composer-area').classList.toggle('dsh-input-hero', empty);
  }

  async function loadSession() {
    const result = await json('/api/session');
    if (result.sessionStats) acceptSessionStats(result.sessionStats, true);
    else refreshSessionStats();
    resetMessages();
    (result.messages || []).forEach(function (message) {
      if (message.role !== 'user' && message.role !== 'assistant') return;
      if (typeof message.content === 'string' && message.content) addMessage(message.role, message.content);
      if (message.error) { const item = addMessage('assistant', message.error); item.article.classList.add('error'); }
    });
    const history = (result.events || []).filter(function (event) { return event.type === 'tool_end'; });
    if (history.length) {
      ui.welcome.hidden = true;
      setEmpty(false);
      const archive = make('details', 'tool-card historical-tools');
      archive.appendChild(make('summary', '', '历史工具记录 · ' + history.length + ' 次'));
      history.forEach(function (event) {
        const card = make('details', 'tool-card' + (event.isError ? ' failed' : ''));
        const summary = make('summary');
        summary.appendChild(make('span', 'tool-name', event.name || '工具调用'));
        summary.appendChild(make('span', 'tool-state', event.isError ? '执行失败' : '完成'));
        card.appendChild(summary);
        toolResult({ card: card }, event.result);
        archive.appendChild(card);
      });
      ui.messages.appendChild(archive);
    }
    const lastAssistant = (result.messages || []).slice().reverse().find(function (message) { return message.role === 'assistant'; });
    if (result.lastRunInterrupted && !(lastAssistant && lastAssistant.error)) {
      const notice = make('p', 'history-notice', '上次任务被中断，已保留收到的内容。你可以继续发送消息。');
      notice.setAttribute('role', 'status'); ui.messages.appendChild(notice);
    }
    const first = (result.messages || []).find(function (message) { return message.role === 'user' && typeof message.content === 'string'; });
    if (result.name) byId('conversation-title').textContent = result.name;
    else if (first) byId('conversation-title').textContent = first.content.replace(/\s+/g, ' ').slice(0, 64);
    (result.pendingApprovals || []).forEach(showApproval);
    if (Array.isArray(result.undeliveredMessages)) { state.undelivered = result.undeliveredMessages; renderQueueDrafts(); }
    if (result.contextStats) updateContext(result.contextStats);
  }

  function sessionTime(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    const elapsed = Math.max(0, Date.now() - date.getTime());
    if (elapsed < 60000) return '刚刚';
    if (elapsed < 3600000) return Math.floor(elapsed / 60000) + '分';
    if (elapsed < 86400000) return Math.floor(elapsed / 3600000) + '时';
    return (date.getMonth() + 1) + '/' + date.getDate();
  }
  function sessionRow(session) {
    const button = make('button', 'dsh-rows-sessionRow session-item' + (session.active ? ' dsh-rows-selected' : ''));
    button.type = 'button';
    button.setAttribute('aria-current', session.active ? 'page' : 'false');
    button.title = [session.title || '新会话', session.workspace, session.model, session.baseUrl, session.updatedAt ? new Date(session.updatedAt).toLocaleString() : ''].filter(Boolean).join('\n');
    const seat = make('span', 'dsh-rows-slot'); seat.appendChild(icon('chat')); button.appendChild(seat);
    button.appendChild(make('span', 'dsh-rows-title', session.title || '新会话'));
    const time = make('span', 'dsh-rows-time session-time', sessionTime(session.updatedAt));
    time.setAttribute('aria-hidden', 'true'); button.appendChild(time);
    button.disabled = state.busy;
    button.addEventListener('click', function () {
      if (session.active) return;
      state.groupExpansion[sessionGroups.workspaceInfo(session.workspace).key] = true; saveGroupExpansion();
      openSession(session.id);
    });
    return button;
  }
  function renderSessions() {
    const list = byId('session-list');
    const query = byId('session-query').value.trim();
    if (state.sessionSearch !== query) { state.sessionSearch = query; state.searchGroupExpansion = Object.create(null); }
    const groups = sessionGroups.groupSessions(state.sessions, query);
    list.replaceChildren();
    let preferencesChanged = false;
    groups.forEach(function (group, index) {
      if (group.active && !Object.prototype.hasOwnProperty.call(state.groupExpansion, group.key)) {
        state.groupExpansion[group.key] = true; preferencesChanged = true;
      }
      const section = make('section', 'session-group');
      const header = make('button', 'dsh-rows-projectRow session-group-header');
      header.type = 'button'; header.id = 'session-group-toggle-' + index;
      header.title = (group.path || group.name) + '\n' + group.totalCount + ' 个会话';
      header.setAttribute('aria-label', group.name + '，' + group.totalCount + ' 个会话' + (group.path ? '，' + group.path : ''));
      const folder = make('span', 'dsh-rows-slot dsh-rows-folder' + (group.active ? ' dsh-rows-folderActive' : ''));
      folder.appendChild(icon('folder')); header.appendChild(folder);
      const chevron = make('span', 'dsh-rows-slot dsh-rows-chevron');
      const arrow = icon('chevron'); arrow.classList.add('dsh-rows-arrow'); chevron.appendChild(arrow); header.appendChild(chevron);
      header.appendChild(make('span', 'dsh-rows-title session-group-name', group.name));
      const count = make('span', 'session-group-count', query && group.sessions.length < group.totalCount ? group.sessions.length + '/' + group.totalCount : String(group.totalCount));
      count.setAttribute('aria-hidden', 'true'); header.appendChild(count);
      const children = make('div', 'session-group-sessions');
      children.id = 'session-group-sessions-' + index;
      children.setAttribute('role', 'group'); children.setAttribute('aria-labelledby', header.id);
      header.setAttribute('aria-controls', children.id);
      function setExpanded(expanded, remember) {
        children.hidden = !expanded;
        header.setAttribute('aria-expanded', String(expanded));
        arrow.classList.toggle('dsh-rows-arrowOpen', expanded);
        if (remember) {
          if (query) state.searchGroupExpansion[group.key] = expanded;
          else { state.groupExpansion[group.key] = expanded; saveGroupExpansion(); }
        }
      }
      setExpanded(sessionGroups.isExpanded(group, query, state.groupExpansion, state.searchGroupExpansion), false);
      header.addEventListener('click', function () { setExpanded(children.hidden, true); });
      header.addEventListener('keydown', function (event) {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setExpanded(event.key === 'ArrowRight', true); }
      });
      group.sessions.forEach(function (session) { children.appendChild(sessionRow(session)); });
      section.appendChild(header); section.appendChild(children); list.appendChild(section);
    });
    if (preferencesChanged) saveGroupExpansion();
    if (!groups.length) list.appendChild(make('p', 'empty-small muted', query ? '未找到会话或工作文件夹' : '暂无历史会话'));
  }

  async function loadSessions() {
    const result = await json('/api/sessions');
    state.sessions = result.sessions || [];
    renderSessions();
  }

  async function openSession(id) {
    if (state.busy || !confirmDiscard()) return;
    const oldWorkspace = (state.bootstrap || {}).workspace;
    setBusy(true);
    try {
      updateBootstrap(await json('/api/session/open', { method: 'POST', body: { id: id } }));
      if (oldWorkspace !== state.bootstrap.workspace) { clearWorkspaceEditor(); await loadFiles(''); }
      await loadSession();
      await loadSessions();
      byId('session-status').textContent = '准备就绪';
    } catch (error) { toast(error.message, true); }
    finally { setBusy(false); }
  }

  function stringify(value) {
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value, null, 2) || ''; } catch (_) { return String(value); }
  }

  function toolStart(event) {
    if (state.activeMessage) {
      state.activeMessage.article.classList.remove('running');
      if (!state.activeMessage.text) state.activeMessage.article.remove();
      state.activeMessage = null;
    }
    const card = make('details', 'tool-card running');
    const summary = make('summary');
    summary.appendChild(make('span', 'tool-name', event.name || '工具调用'));
    const waiting = Array.from(state.approvals.values()).some(function (item) { return !item.card.classList.contains('resolved'); });
    const status = make('span', 'tool-state', waiting ? '等待批准' : '执行中');
    summary.appendChild(status);
    card.appendChild(summary);
    card.appendChild(make('div', 'tool-label', '调用参数'));
    card.appendChild(make('pre', '', stringify(event.args || {})));
    ui.messages.appendChild(card);
    state.toolCards.set(event.id, { card: card, status: status });
    byId('session-status').textContent = waiting ? '等待你的批准' : '正在执行 ' + (event.name || '工具');
    scrollToBottom();
  }

  function toolResult(item, result) {
    if (!item.output) {
      item.card.appendChild(make('div', 'tool-label', '执行结果'));
      item.output = make('div', 'tool-output');
      item.card.appendChild(item.output);
    }
    item.output.replaceChildren();
    const details = result && result.details;
    const preview = details && details.preview;
    if (preview && typeof preview.before === 'string' && typeof preview.after === 'string') {
      const diff = make('div', 'tool-diff');
      if (details.path) diff.appendChild(make('div', 'tool-label', details.path + (details.replacements ? ' · ' + details.replacements + ' 处修改' : '')));
      diff.appendChild(make('div', 'tool-label', '修改前'));
      diff.appendChild(make('pre', 'diff-before', preview.before));
      diff.appendChild(make('div', 'tool-label', '修改后'));
      diff.appendChild(make('pre', 'diff-after', preview.after));
      if (preview.truncated) diff.appendChild(make('div', 'tool-label', '预览已截取，完整内容可在文件编辑器中查看。'));
      item.output.appendChild(diff);
    } else {
      const text = result && Array.isArray(result.content)
        ? result.content.filter(function (part) { return part.type === 'text'; }).map(function (part) { return part.text; }).join('\n')
        : stringify(result);
      item.output.appendChild(make('pre', '', text));
    }
  }

  function handleEvent(event) {
    if (!event || typeof event !== 'object') return;
    if (event.type === 'text_delta') {
      if (!state.activeMessage) state.activeMessage = addMessage('assistant', '');
      state.activeMessage.article.classList.add('running');
      state.activeMessage.text += event.delta || '';
      const nearBottom = ui.messages.scrollHeight - ui.messages.scrollTop - ui.messages.clientHeight < 160;
      renderText(state.activeMessage.body, state.activeMessage.text);
      scrollToBottom(nearBottom);
      byId('session-status').textContent = 'Pi 正在回复';
    } else if (event.type === 'queue_cancelled') {
      state.undelivered = event.messages || [];
      renderQueueDrafts();
    } else if (event.type === 'user_message') {
      if (state.activeMessage) {
        state.activeMessage.article.classList.remove('running');
        if (!state.activeMessage.text) state.activeMessage.article.remove();
        state.activeMessage = null;
      }
      if (typeof event.message === 'string') addMessage('user', event.message);
    } else if (event.type === 'approval_request') showApproval(event);
    else if (event.type === 'approval_resolved') approvalResolved(event.id, event.decision);
    else if (event.type === 'context') updateContext(event.stats);
    else if (event.type === 'session_stats') acceptSessionStats(event.stats, true);
    else if (event.type === 'retry') byId('session-status').textContent = event.reason === 'context_overflow' ? '上下文超限，正在压缩后重试…' : event.reason === 'stream_options_unsupported' ? '服务不支持流式用量，将继续请求' : '服务暂时不可用，等待第 ' + event.attempt + ' 次重试…';
    else if (event.type === 'compaction') {
      const message = event.message || (event.status === 'start' ? '正在压缩上下文…' : event.status === 'done' ? '上下文已压缩' : '上下文压缩未完成');
      byId('session-status').textContent = message;
      byId('compaction-state').textContent = message;
      if (event.status === 'error') { state.compactionError = message; toast(message, true); }
      if (event.status === 'done') state.lastCompaction = event;
    }
    else if (event.type === 'mcp_status') {
      if (state.extensions) { state.extensions.mcpStatus = event.servers || []; renderMcpServers(); }
      const failures = (event.servers || []).filter(function (server) { return server.enabled && server.error; });
      if (failures.length) toast('MCP 连接失败：' + failures.map(function (server) { return server.name + '：' + server.error; }).join('；'), true);
    } else if (event.type === 'tool_start') toolStart(event);
    else if (event.type === 'tool_update') {
      const item = state.toolCards.get(event.id);
      if (item) { toolResult(item, event.result); scrollToBottom(); }
    } else if (event.type === 'tool_end') {
      if (!state.toolCards.has(event.id)) toolStart(event);
      const item = state.toolCards.get(event.id);
      item.card.classList.remove('running');
      item.card.classList.toggle('failed', Boolean(event.isError));
      item.status.textContent = event.isError ? '执行失败' : '完成';
      toolResult(item, event.result);
      scrollToBottom();
    } else if (event.type === 'error' && !state.cancelled) throw new Error(event.message || 'Agent 请求失败');
  }

  async function readEvents(response) {
    if (!response.body) throw new Error('浏览器不支持流式响应，请使用 Chrome 102。');
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let complete = false;
    function dispatch(block) {
      const lines = block.split(/\r?\n/).filter(function (line) { return line.indexOf('data:') === 0; });
      if (!lines.length) return;
      const data = lines.map(function (line) { return line.slice(5).replace(/^ /, ''); }).join('\n');
      if (data === '[DONE]') { complete = true; return; }
      const event = JSON.parse(data);
      if (event.type === 'done') complete = true;
      else handleEvent(event);
    }
    try {
      while (true) {
        const chunk = await reader.read();
        buffer += decoder.decode(chunk.value || new Uint8Array(), { stream: !chunk.done });
        let match;
        while ((match = /\r?\n\r?\n/.exec(buffer))) {
          dispatch(buffer.slice(0, match.index));
          buffer = buffer.slice(match.index + match[0].length);
        }
        if (chunk.done) break;
      }
      if (buffer.trim()) dispatch(buffer);
      if (!complete && !state.cancelled) throw new Error('连接提前结束，回复可能不完整。');
    } finally { reader.releaseLock(); }
  }

  function updateSend() {
    const hasMessage = Boolean(ui.input.value.trim());
    ui.send.disabled = state.compacting || state.queueSending || ui.input.disabled || !hasMessage;
    ui.send.hidden = state.busy && (!hasMessage || state.compacting);
    ui.send.setAttribute('aria-label', state.busy ? '提交运行时消息' : '发送消息');
    ui.send.title = state.busy ? (byId('queue-mode').value === 'followUp' ? '排队在当前回复结束后跟进' : '在下一次工具调用间隙插入指令') : '发送消息';
    byId('queue-mode').hidden = !state.busy || state.compacting;
  }
  function setBusy(busy) {
    state.busy = busy;
    scheduleStatsRefresh();
    if (!busy && state.ready) refreshSessionStats();
    ui.cancel.hidden = !busy;
    ui.cancel.disabled = false;
    byId('new-session').disabled = busy;
    byId('settings-button').disabled = busy;
    byId('workspace-button').disabled = busy;
    byId('sidebar-folder-button').disabled = busy;
    byId('model-button').disabled = busy;
    byId('model-button').hidden = busy && !state.compacting;
    byId('brand-home').disabled = busy;
    byId('session-menu-button').disabled = busy;
    byId('context-usage').disabled = busy;
    if (busy) closePermissionMenu();
    if (busy) closeSessionMenu();
    updatePermission();
    renderQueueDrafts();
    byId('session-list').querySelectorAll('.session-item').forEach(function (button) { button.disabled = busy; });
    updateSend();
    markEdited();
  }

  async function sendMessage(event) {
    event.preventDefault();
    const raw = ui.input.value.trim();
    if (!raw || !state.ready || !state.token || state.compacting) return;
    if (state.busy) { await queueMessage(); return; }
    if ((state.bootstrap || {}).workspaceMissing) { openFolderPicker('workspace'); return; }
    const message = state.context ? '参考当前工作目录中的文件：' + state.context + '\n\n' + raw : raw;
    ui.input.value = '';
    ui.input.style.height = '';
    setContext('');
    addMessage('user', message);
    if (byId('conversation-title').textContent === '新会话') byId('conversation-title').textContent = raw.slice(0, 64);
    state.activeMessage = addMessage('assistant', '');
    state.activeMessage.article.classList.add('running');
    state.abort = new AbortController();
    state.cancelled = false;
    state.compactionError = null;
    setBusy(true);
    byId('session-status').textContent = 'Pi 正在思考';
    let runFailed = false;
    try {
      const response = await api('/api/chat', { method: 'POST', body: { message: message }, signal: state.abort.signal });
      await readEvents(response);
      byId('session-status').textContent = state.cancelled ? '已停止' : '准备就绪';
    } catch (error) {
      runFailed = true;
      if (error.name === 'AbortError' && state.cancelled) byId('session-status').textContent = '已停止';
      else {
        if (state.activeMessage && !state.activeMessage.text) state.activeMessage.article.remove();
        const failed = addMessage('assistant', error.message);
        failed.article.classList.add('error');
        byId('session-status').textContent = '请求未完成';
        toast(error.message, true);
      }
    } finally {
      if (state.activeMessage) {
        state.activeMessage.article.classList.remove('running');
        if (!state.activeMessage.text) state.activeMessage.article.remove();
      }
      state.toolCards.forEach(function (item) {
        if (item.card.classList.contains('running')) { item.card.classList.remove('running'); item.status.textContent = state.cancelled ? '已停止' : '未完成'; }
      });
      state.activeMessage = null;
      state.abort = null;
      state.approvals.forEach(function (item, id) { if (!item.card.classList.contains('resolved')) approvalResolved(id, 'cancel'); });
      setBusy(false);
      if (state.cancelled || runFailed) {
        try {
          await bootstrap();
          if (state.bootstrap.busy) { setBusy(true); recoverActiveSession(); }
        } catch (_) { /* A later reconnect reloads persisted queue drafts. */ }
      }
      loadFiles(state.directory);
      loadSessions().catch(function (error) { toast(error.message, true); });
      if (state.file && !ui.editorPanel.hidden && !hasEdits()) openFile(state.file);
      ui.input.focus();
    }
  }

  async function cancelMessage() {
    if (!state.busy) return;
    ui.cancel.disabled = true;
    state.cancelled = true;
    try {
      await json('/api/cancel', { method: 'POST' });
      if (state.abort) state.abort.abort();
    } catch (error) { state.cancelled = false; ui.cancel.disabled = false; toast('停止失败：' + error.message, true); }
  }

  function renderQueueDrafts() {
    const list = byId('queue-drafts');
    list.hidden = !state.undelivered.length;
    list.replaceChildren();
    if (!state.undelivered.length) return;
    list.appendChild(make('strong', 'queue-drafts-title', '未执行的排队指令'));
    state.undelivered.forEach(function (draft) {
      const card = make('div', 'queue-draft');
      card.appendChild(make('pre', '', draft.message || ''));
      const restore = make('button', 'dsh-button-button dsh-button-sm dsh-button-outline', state.restoredQueueIds.has(draft.id) ? '清除已恢复的草稿' : '恢复到输入框');
      restore.type = 'button'; restore.disabled = state.busy;
      restore.addEventListener('click', async function () {
        restore.disabled = true;
        if (!state.restoredQueueIds.has(draft.id)) {
          ui.input.value = ui.input.value.trim() ? ui.input.value + '\n\n' + draft.message : draft.message;
          ui.input.style.height = 'auto';
          ui.input.style.height = Math.min(ui.input.scrollHeight, 190) + 'px';
          state.restoredQueueIds.add(draft.id);
          updateSend(); ui.input.focus();
        }
        try {
          await json('/api/queue/discard', {method: 'POST', body: {id: draft.id}});
          state.undelivered = state.undelivered.filter(function (item) { return item.id !== draft.id; });
          renderQueueDrafts();
          toast('已恢复到输入框，请检查后发送');
        } catch (error) { renderQueueDrafts(); toast('文字已恢复，服务器草稿暂时保留：' + error.message, true); }
      });
      card.appendChild(restore); list.appendChild(card);
    });
  }

  async function queueMessage() {
    if (state.queueSending || !state.busy || state.compacting) return;
    const raw = ui.input.value.trim();
    if (!raw) return;
    const mode = byId('queue-mode').value;
    const message = state.context ? '参考当前工作目录中的文件：' + state.context + '\n\n' + raw : raw;
    state.queueSending = true;
    updateSend();
    try {
      await json('/api/queue', { method: 'POST', body: { message: message, mode: mode } });
      if (ui.input.value.trim() === raw) { ui.input.value = ''; ui.input.style.height = ''; setContext(''); }
      toast(mode === 'followUp' ? '已排队跟进，将在当前回复结束后处理' : '指令已插入，将在下一个处理间隙生效');
    } catch (error) { toast(error.message, true); }
    finally { state.queueSending = false; updateSend(); ui.input.focus(); }
  }

  function closeSessionMenu() {
    byId('session-menu').hidden = true;
    byId('session-menu-button').setAttribute('aria-expanded', 'false');
  }
  function openSessionMenu() {
    if (state.busy) return;
    const menu = byId('session-menu');
    if (!menu.hidden) { closeSessionMenu(); return; }
    closePermissionMenu();
    menu.hidden = false;
    const rect = byId('session-menu-button').getBoundingClientRect();
    menu.style.left = Math.max(12, rect.right - menu.offsetWidth) + 'px';
    menu.style.top = (rect.bottom + 6) + 'px';
    byId('session-menu-button').setAttribute('aria-expanded', 'true');
  }
  function openRenameSession() {
    closeSessionMenu();
    if (state.busy) return;
    byId('session-name').value = byId('conversation-title').textContent;
    byId('rename-error').hidden = true;
    byId('rename-session-dialog').showModal();
    byId('session-name').focus();
    byId('session-name').select();
  }
  async function renameSession(event) {
    event.preventDefault();
    if (state.busy) return;
    byId('save-session-name').disabled = true;
    byId('rename-error').hidden = true;
    try {
      const name = byId('session-name').value.trim();
      if (!name) throw new Error('请输入会话名称。');
      await json('/api/session/name', { method: 'POST', body: { name: name } });
      await loadSessions();
      byId('conversation-title').textContent = name;
      byId('rename-session-dialog').close();
      toast('会话已重命名');
    } catch (error) { byId('rename-error').textContent = error.message; byId('rename-error').hidden = false; }
    finally { byId('save-session-name').disabled = false; }
  }
  async function forkSession() {
    closeSessionMenu();
    if (state.busy) return;
    setBusy(true);
    try {
      await json('/api/session/fork', { method: 'POST', body: {} });
      await bootstrap();
      await loadSession();
      await loadSessions();
      toast('已创建会话分支，可以从这里继续');
    } catch (error) { toast(error.message, true); }
    finally { setBusy(false); }
  }
  async function exportSession(format) {
    closeSessionMenu();
    try {
      const response = await api('/api/session/export?format=' + format);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = make('a');
      link.href = url;
      link.download = 'pi-session-' + ((state.bootstrap || {}).sessionId || 'export') + '.' + format;
      document.body.appendChild(link);
      link.click(); link.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
    } catch (error) { toast(error.message, true); }
  }

  function setContext(path) {
    state.context = path;
    byId('context-file').hidden = !path;
    byId('context-file').querySelector('span').textContent = path;
  }

  function selectSettingsTab(name) {
    state.settingsTab = name;
    ['model', 'mcp', 'skills', 'resources', 'storage'].forEach(function (item) {
      const active = item === name;
      byId('settings-' + item + '-panel').hidden = !active;
      byId('settings-tab-' + item).classList.toggle('active', active);
      byId('settings-tab-' + item).setAttribute('aria-selected', String(active));
      byId('settings-tab-' + item).tabIndex = active ? 0 : -1;
    });
    if ((name === 'mcp' || name === 'skills') && !state.extensions) loadExtensions();
    if (name === 'resources' && !state.piResources) loadPiResources();
    if (name === 'storage') loadStorage();
  }
  function showExtensionError(surface, error) {
    const target = byId(surface + '-error');
    target.textContent = error.message || String(error);
    target.hidden = false;
  }
  function renderMcpServers() {
    const list = byId('mcp-server-list');
    list.replaceChildren();
    const data = state.extensions || {};
    const servers = Array.isArray(data.mcpServers) ? data.mcpServers : [];
    if (!servers.length) { list.appendChild(make('p', 'field-help', '尚未配置 MCP 服务器。')); return; }
    servers.forEach(function (server) {
      const id = server.id || server.name;
      const row = make('div', 'extension-card');
      const heading = make('div', 'extension-heading');
      const info = make('div', 'extension-info');
      info.appendChild(make('strong', '', server.name || id || 'MCP'));
      info.appendChild(make('span', 'extension-detail', server.url || server.command || server.transport || 'stdio'));
      heading.appendChild(info);
      const test = make('button', 'dsh-button-button dsh-button-sm dsh-button-outline', '连接测试');
      test.type = 'button';
      test.disabled = !id || server.enabled === false;
      heading.appendChild(test);
      row.appendChild(heading);
      const detail = make('div', 'mcp-test-result');
      const status = (data.mcpStatus || []).find(function (item) { return item.id === id || item.name === id; });
      if (server.enabled === false) detail.textContent = '已禁用';
      else if (status) detail.textContent = status.error || (status.connected || status.status === 'connected' ? '已连接' : status.status || '');
      row.appendChild(detail);
      test.addEventListener('click', async function () {
        test.disabled = true; detail.textContent = '正在连接并发现工具…'; detail.classList.remove('inline-error');
        try {
          const result = await json('/api/mcp/test', { method: 'POST', body: { id: id } });
          if (result.connected === false) throw new Error(result.error || 'MCP 服务器连接失败');
          detail.replaceChildren(make('p', 'field-help', '已连接 · ' + ((result.serverInfo || {}).name || id) + ' · ' + (result.tools || []).length + ' 个工具'));
          (result.tools || []).forEach(function (tool) {
            const line = make('div', 'mcp-tool');
            line.appendChild(make('code', '', tool.name));
            if (tool.description) line.appendChild(make('span', '', tool.description));
            detail.appendChild(line);
          });
        } catch (error) { detail.textContent = error.message; detail.classList.add('inline-error'); }
        finally { test.disabled = false; }
      });
      list.appendChild(row);
    });
  }
  function renderSkills() {
    const data = state.extensions || {};
    byId('skills-enabled').checked = data.skillsEnabled !== false;
    byId('skill-directories').value = (data.skillDirectories || []).join('\n');
    const list = byId('skills-list');
    list.replaceChildren();
    (data.skills || []).forEach(function (skill) {
      const card = make('div', 'extension-card');
      card.appendChild(make('strong', '', skill.name || skill.id));
      if (skill.description) card.appendChild(make('p', 'field-help', skill.description));
      if (skill.path) card.appendChild(make('div', 'skill-path', skill.path));
      list.appendChild(card);
    });
    if (!(data.skills || []).length) list.appendChild(make('p', 'field-help', '没有发现技能。将包含 SKILL.md 的技能文件夹放入工作区 .agents/skills 或 .pi/skills，或添加上方的额外目录。'));
    byId('skills-warnings').textContent = (data.warnings || []).map(function (warning) { return typeof warning === 'string' ? warning : warning.message || stringify(warning); }).join('\n');
  }
  function updateExtensions(data, refreshEditor) {
    state.extensions = data;
    if (refreshEditor) byId('mcp-config').value = JSON.stringify({ mcpServers: data.mcpServers || [] }, null, 2);
    renderMcpServers();
    renderSkills();
  }
  async function loadExtensions() {
    if (state.extensionsLoading) return;
    state.extensionsLoading = true;
    byId('save-mcp').disabled = true; byId('save-skills').disabled = true; byId('refresh-skills').disabled = true;
    byId('mcp-error').hidden = true; byId('skills-error').hidden = true;
    try { updateExtensions(await json('/api/extensions'), true); }
    catch (error) { showExtensionError('mcp', error); showExtensionError('skills', error); }
    finally { state.extensionsLoading = false; byId('save-mcp').disabled = false; byId('save-skills').disabled = false; byId('refresh-skills').disabled = false; }
  }
  async function saveExtensions(surface) {
    if (state.extensionsLoading || !state.extensions) return;
    const data = state.extensions;
    const body = { mcpServers: data.mcpServers || [], skillsEnabled: data.skillsEnabled !== false, skillDirectories: data.skillDirectories || [] };
    byId(surface + '-error').hidden = true;
    try {
      if (surface === 'mcp') {
        const parsed = JSON.parse(byId('mcp-config').value);
        const servers = parsed && parsed.mcpServers !== undefined ? parsed.mcpServers : parsed;
        if (!servers || typeof servers !== 'object') throw new Error('MCP 配置必须是服务器对象或数组。');
        body.mcpServers = Array.isArray(servers) ? servers : { mcpServers: servers };
      } else {
        body.skillsEnabled = byId('skills-enabled').checked;
        body.skillDirectories = byId('skill-directories').value.split(/\r?\n/).map(function (line) { return line.trim(); }).filter(Boolean);
      }
      state.extensionsLoading = true;
      byId('save-mcp').disabled = true; byId('save-skills').disabled = true; byId('refresh-skills').disabled = true;
      updateExtensions(await json('/api/extensions', { method: 'POST', body: body }), surface === 'mcp');
      toast(surface === 'mcp' ? 'MCP 配置已保存，可进行连接测试' : 'Skills 设置已保存');
    } catch (error) { showExtensionError(surface, error); }
    finally { state.extensionsLoading = false; byId('save-mcp').disabled = false; byId('save-skills').disabled = false; byId('refresh-skills').disabled = false; }
  }
  function fillMcpExample() {
    const bundled = (state.extensions || {}).exampleMcpConfig || (state.bootstrap || {}).mcpExample;
    const example = bundled || { mcpServers: { demo: { command: 'D:\\PiHarness\\runtime\\node.exe', args: ['D:\\PiHarness\\examples\\mcp-demo.cjs'] } } };
    byId('mcp-config').value = JSON.stringify(example, null, 2);
    byId('mcp-save-status').textContent = bundled ? '已填写随包示例，保存后连接测试。' : '请将 D:\\PiHarness 改为解压目录，再保存。';
  }

  function renderBuiltinPresets(data) {
    const presets = data.builtinPresets || [];
    byId('builtin-agent-section').hidden = !presets.length;
    const list = byId('builtin-agent-presets');
    list.replaceChildren();
    presets.forEach(function (preset) {
      const label = make('label', 'builtin-preset' + (preset.available === false ? ' unavailable' : ''));
      const input = make('input');
      input.type = 'radio'; input.name = 'builtin-agent-preset'; input.value = preset.value;
      input.checked = preset.value === data.preset; input.disabled = preset.available === false;
      const copy = make('span', 'builtin-preset-copy');
      copy.appendChild(make('strong', '', preset.name));
      copy.appendChild(make('span', '', preset.available === false ? preset.reason || '当前适配版暂不可用' : preset.description || ''));
      label.appendChild(input); label.appendChild(copy);
      input.addEventListener('change', async function () {
        list.querySelectorAll('input').forEach(function (radio) { radio.disabled = true; });
        byId('resources-error').hidden = true;
        try {
          const result = await json('/api/pi/resources', {method: 'POST', body: {settings: data.settings, preset: preset.value}});
          renderPiResources(result);
          toast('内置 Agent 预设已切换为' + preset.name);
        } catch (error) { renderBuiltinPresets(data); showExtensionError('resources', error); }
      });
      list.appendChild(label);
    });
    byId('builtin-prompt-text').textContent = data.builtinPrompt || '';
  }

  function renderPiResources(data) {
    state.piResources = data;
    renderBuiltinPresets(data);
    const settings = data.settings || {};
    byId('pi-resources-enabled').checked = settings.enabled !== false;
    byId('pi-resources-ancestors').checked = settings.includeAncestors !== false;
    byId('pi-agent-dir').value = settings.agentDir || '';
    byId('pi-prompt-paths').value = (settings.promptPaths || []).join('\n');
    const templates = byId('prompt-template-list');
    templates.replaceChildren();
    (data.prompts || []).forEach(function (prompt) {
      const card = make('div', 'extension-card');
      const heading = make('div', 'extension-heading');
      const info = make('div', 'extension-info');
      info.appendChild(make('strong', '', prompt.name));
      if (prompt.description) info.appendChild(make('span', 'prompt-description', prompt.description));
      heading.appendChild(info);
      const use = make('button', 'dsh-button-button dsh-button-sm dsh-button-outline', '使用');
      use.type = 'button';
      use.setAttribute('aria-label', '使用模板 ' + prompt.name);
      use.addEventListener('click', async function () {
        use.disabled = true;
        try {
          const result = await json('/api/pi/template', { method: 'POST', body: { name: prompt.name, args: ui.input.value.trim() } });
          ui.input.value = result.text || '';
          ui.input.style.height = 'auto';
          ui.input.style.height = Math.min(ui.input.scrollHeight, 190) + 'px';
          updateSend();
          ui.settings.close();
          ui.input.focus();
          toast('已填入模板，可补充任务后发送');
        } catch (error) { showExtensionError('resources', error); }
        finally { use.disabled = false; }
      });
      heading.appendChild(use); card.appendChild(heading);
      if (prompt.filePath) { const source = make('div', 'skill-path', prompt.filePath); source.title = prompt.source || ''; card.appendChild(source); }
      templates.appendChild(card);
    });
    if (!(data.prompts || []).length) templates.appendChild(make('p', 'field-help', '暂无提示词模板。可在项目 .pi/prompts 添加 Markdown 模板，或配置额外提示词路径。'));
    const files = byId('pi-resource-files');
    files.replaceChildren(make('div', 'field-label', '已发现的上下文文件'));
    const entries = (data.contextFiles || []).map(function (file) { return {path: file.path, label: '项目指引', bytes: file.bytes}; });
    if (data.systemPromptPath) entries.push({path: data.systemPromptPath, label: '系统提示词'});
    if (data.appendSystemPromptPath) entries.push({path: data.appendSystemPromptPath, label: '追加系统提示词'});
    entries.forEach(function (file) {
      const row = make('div', 'extension-card');
      row.appendChild(make('strong', '', file.label + (file.bytes ? ' · ' + sizeLabel(file.bytes) : '')));
      row.appendChild(make('div', 'skill-path', file.path));
      files.appendChild(row);
    });
    if (!entries.length) files.appendChild(make('p', 'field-help', '尚未发现 AGENTS.md、SYSTEM.md 或 APPEND_SYSTEM.md。'));
    byId('pi-resource-warnings').textContent = (data.warnings || []).map(function (warning) { return typeof warning === 'string' ? warning : warning.message || stringify(warning); }).join('\n');
  }
  async function loadPiResources() {
    if (state.resourcesLoading) return;
    state.resourcesLoading = true;
    byId('refresh-resources').disabled = true; byId('save-resources').disabled = true;
    byId('resources-error').hidden = true;
    try { renderPiResources(await json('/api/pi/resources')); }
    catch (error) { showExtensionError('resources', error); }
    finally { state.resourcesLoading = false; byId('refresh-resources').disabled = false; byId('save-resources').disabled = false; }
  }
  async function savePiResources() {
    if (state.resourcesLoading) return;
    state.resourcesLoading = true;
    byId('save-resources').disabled = true; byId('resources-error').hidden = true;
    try {
      const settings = {enabled: byId('pi-resources-enabled').checked, includeAncestors: byId('pi-resources-ancestors').checked, agentDir: byId('pi-agent-dir').value.trim(), promptPaths: byId('pi-prompt-paths').value.split(/\r?\n/).map(function (line) { return line.trim(); }).filter(Boolean)};
      renderPiResources(await json('/api/pi/resources', {method: 'POST', body: {settings: settings, preset: (state.piResources || {}).preset || 'standard'}}));
      toast('提示词与项目资源设置已保存');
    } catch (error) { showExtensionError('resources', error); }
    finally { state.resourcesLoading = false; byId('save-resources').disabled = false; }
  }


  function clearWorkspaceEditor() {
    state.fileRequest++; state.directoryRequest++; state.file = null; state.original = ''; state.rawOriginal = ''; state.directory = '';
    ui.editor.value = ''; ui.editorPanel.hidden = true;
    document.querySelector('.workspace-layout').classList.remove('editor-open'); setContext('');
  }
  function updateKeyStatus() {
    const data = state.bootstrap || {};
    const sameAddress = byId('settings-base-url').value.trim().replace(/\/$/, '') === (data.baseUrl || '').replace(/\/$/, '');
    byId('key-status').textContent = sameAddress ? (data.hasApiKey ? '已保存在本机' : '尚未设置') : '按服务地址分别保存';
    byId('settings-api-key').placeholder = sameAddress && data.hasApiKey ? '已保存在本机；留空保留' : !sameAddress ? '留空使用此地址已保存的密钥' : '输入服务商 API 密钥';
  }
  function renderStorage(data) {
    state.storage = data;
    byId('storage-directory').textContent = data.directory || '尚未指定';
    const migration = data.migration || {};
    byId('storage-migration').textContent = migration.importedSessions ? '已从旧版本导入 ' + migration.importedSessions + ' 个会话。' : '不同工作文件夹和模型的历史都显示在左侧会话列表中。';
    byId('storage-warnings').textContent = (data.warnings || []).concat(migration.warnings || []).filter(function (value, index, all) {return all.indexOf(value) === index;}).join('\n');
  }
  async function loadStorage() {
    byId('storage-error').hidden = true;
    try { renderStorage(await json('/api/storage')); }
    catch (error) { byId('storage-error').textContent = error.message; byId('storage-error').hidden = false; }
  }
  async function importStorage() {
    if (state.storageImporting || state.busy) return;
    const path = byId('storage-import-path').value.trim();
    if (!path) { byId('storage-error').textContent = '请选择旧版本所在的文件夹。'; byId('storage-error').hidden = false; return; }
    state.storageImporting = true; byId('import-storage').disabled = true; byId('storage-error').hidden = true;
    byId('storage-import-status').textContent = '正在查找旧版本的历史…';
    try {
      const data = await json('/api/storage/import', {method: 'POST', body: {path: path}});
      renderStorage(data); await bootstrap(); updateKeyStatus(); await loadSessions();
      const result = data.importResult || {};
      byId('storage-import-status').textContent = '导入完成：新增 ' + Number(result.importedSessions || 0) + ' 个会话。';
      toast('旧版本历史已检查，可在左侧打开会话');
    } catch (error) { byId('storage-error').textContent = error.message; byId('storage-error').hidden = false; byId('storage-import-status').textContent = ''; }
    finally { state.storageImporting = false; byId('import-storage').disabled = false; }
  }

  function openSettings() {
    if (state.busy) return;
    const data = state.bootstrap || {};
    byId('settings-workspace').value = data.workspace || '';
    byId('settings-base-url').value = data.baseUrl || '';
    byId('settings-model').value = data.model || '';
    byId('settings-context-window').value = data.contextWindow || 64000;
    byId('settings-max-output').textContent = tokenLabel(data.maxOutputTokens) + ' tokens';
    byId('context-allocation-note').textContent = '按已保存的上下文窗口计算';
    const compaction = data.compaction || {};
    byId('settings-auto-compact').checked = compaction.enabled !== false;
    byId('settings-reserve-tokens').textContent = tokenLabel(compaction.reserveTokens) + ' tokens';
    byId('settings-keep-recent-tokens').textContent = tokenLabel(compaction.keepRecentTokens) + ' tokens';
    byId('settings-api-key').value = '';
    updateKeyStatus();
    byId('settings-error').hidden = true;
    state.extensions = null;
    state.piResources = null;
    byId('mcp-save-status').textContent = '';
    selectSettingsTab('model');
    ui.settings.showModal();
    ui.settings.querySelector('.settings-body').scrollTop = 0;
  }

  async function saveSettings(event) {
    event.preventDefault();
    const values = { workspace: byId('settings-workspace').value.trim(), baseUrl: byId('settings-base-url').value.trim(), model: byId('settings-model').value.trim(), contextWindow: Number(byId('settings-context-window').value), compaction: { enabled: byId('settings-auto-compact').checked } };
    const key = byId('settings-api-key').value.trim();
    if (key) values.apiKey = key;
    const workspaceChanged = values.workspace !== (state.bootstrap || {}).workspace;
    if (workspaceChanged && !confirmDiscard()) return;
    byId('save-settings').disabled = true;
    byId('settings-error').hidden = true;
    try {
      await json('/api/settings', { method: 'POST', body: values });
      byId('settings-api-key').value = '';
      await bootstrap();
      if (workspaceChanged) {
        state.fileRequest++;
        state.file = null;
        state.original = '';
        ui.editor.value = '';
        ui.editorPanel.hidden = true;
        document.querySelector('.workspace-layout').classList.remove('editor-open');
        setContext('');
      }
      await loadSession();
      await loadFiles(workspaceChanged ? '' : state.directory);
      await loadSessions();
      ui.settings.close();
      toast('工作环境已更新');
    } catch (error) {
      byId('settings-error').textContent = error.message;
      byId('settings-error').hidden = false;
    } finally { byId('save-settings').disabled = false; }
  }

  async function newSession() {
    if (state.busy) return;
    try {
      await json('/api/session/new', { method: 'POST' });
      await bootstrap();
      resetMessages();
      await loadSessions();
      setContext('');
      byId('session-status').textContent = '准备就绪';
      ui.input.focus();
      toast('已开始新会话');
    } catch (error) { toast(error.message, true); }
  }

  async function compactContext() {
    if (state.busy || !state.ready) return;
    ui.settings.close();
    state.abort = new AbortController();
    state.cancelled = false;
    state.compactionError = null;
    state.compacting = true;
    setBusy(true);
    byId('session-status').textContent = '正在压缩上下文…';
    try {
      const response = await api('/api/compact', { method: 'POST', body: {}, signal: state.abort.signal });
      await readEvents(response);
      if (state.compactionError) throw new Error(state.compactionError);
      if (!state.cancelled) { await bootstrap(); await loadSession(); toast('上下文压缩完成'); }
      byId('session-status').textContent = state.cancelled ? '已停止压缩' : '准备就绪';
    } catch (error) {
      if (state.cancelled) byId('session-status').textContent = '已停止压缩';
      else { byId('session-status').textContent = '压缩未完成'; toast(error.message, true); }
    } finally {
      state.abort = null;
      state.compacting = false;
      setBusy(false);
    }
  }

  function setSidebarCollapsed(collapsed) {
    document.querySelector('.app-shell').classList.toggle('sidebar-collapsed', collapsed);
    byId('expand-sidebar').hidden = !collapsed;
  }

  function toggleFiles(force) {
    const panel = byId('file-sidebar');
    if (!ui.editorPanel.hidden) {
      closeEditor();
      if (!ui.editorPanel.hidden) return;
      force = true;
    }
    panel.hidden = typeof force === 'boolean' ? !force : !panel.hidden;
    byId('toggle-files').setAttribute('aria-expanded', String(!panel.hidden));
    if (!panel.hidden) loadFiles(state.directory);
  }

  function folderRow(entry, selected) {
    const button = make('button', 'dsh-browser-row' + (selected ? ' dsh-browser-rowSelected' : ''));
    button.type = 'button';
    button.title = entry.path;
    button.setAttribute('aria-label', '打开文件夹 ' + entry.name);
    button.appendChild(icon('folder'));
    button.appendChild(make('span', 'dsh-browser-rowName', entry.name));
    button.appendChild(icon('chevron'));
    button.addEventListener('click', function () { loadFolders(entry.path); });
    return button;
  }

  async function loadFolders(path) {
    const request = ++state.folderRequest;
    state.folderLoading = true;
    byId('select-folder').disabled = true;
    byId('folder-error').hidden = true;
    byId('folder-status').textContent = '正在读取文件夹…';
    try {
      const result = await json('/api/folders' + (path ? '?path=' + encodeURIComponent(path) : ''));
      if (request !== state.folderRequest) return;
      state.folderPath = result.path;
      byId('folder-path-input').value = result.path;
      byId('folder-selection').textContent = basename(result.path);
      byId('folder-selection').title = result.path;
      const roots = byId('folder-roots');
      const entries = byId('folder-entries');
      roots.replaceChildren(make('div', 'root-label', '此电脑'));
      (result.roots || []).forEach(function (root) { roots.appendChild(folderRow(root, root.path.toLowerCase() === result.path.toLowerCase())); });
      if (result.parent) {
        roots.appendChild(make('div', 'root-divider'));
        const parent = folderRow({ name: '上一级', path: result.parent }, false);
        parent.setAttribute('aria-label', '上一级文件夹');
        roots.appendChild(parent);
      }
      entries.replaceChildren();
      (result.entries || []).forEach(function (entry) { entries.appendChild(folderRow(entry, false)); });
      if (!result.entries || !result.entries.length) entries.appendChild(make('p', 'empty-small muted', '没有子文件夹，可直接打开当前文件夹。'));
      byId('folder-status').textContent = result.truncated ? '仅显示部分子文件夹，可输入完整路径前往。' : '选择子文件夹，或点击“打开”使用当前文件夹。';
      byId('select-folder').disabled = false;
    } catch (error) {
      if (request !== state.folderRequest) return;
      byId('folder-error').textContent = error.message;
      byId('folder-error').hidden = false;
      byId('folder-status').textContent = '';
      // A failed path is never selectable; previous rows remain available to recover.
      byId('select-folder').disabled = true;
    } finally { if (request === state.folderRequest) state.folderLoading = false; }
  }

  function openFolderPicker(target) {
    if (state.busy) return;
    state.folderTarget = target || 'workspace';
    state.folderPath = '';
    const config = state.bootstrap || {};
    const fallback = config.workspaceMissing ? (config.storage || {}).directory : config.workspace;
    let initial = state.folderTarget === 'settings' ? byId('settings-workspace').value.trim() : state.folderTarget === 'storage' ? byId('storage-import-path').value.trim() || fallback : fallback;
    if (config.workspaceMissing && initial === config.workspace) initial = fallback;
    byId('folder-title').textContent = state.folderTarget === 'storage' ? '选择旧版本文件夹' : '打开文件夹';
    byId('select-folder').textContent = state.folderTarget === 'storage' ? '选择此文件夹' : '打开';
    byId('folder-roots').replaceChildren();
    byId('folder-entries').replaceChildren();
    byId('folder-selection').textContent = '';
    byId('folder-path-input').value = initial || '';
    byId('folder-dialog').showModal();
    loadFolders(initial);
  }

  function closeFolderPicker() {
    state.folderRequest++;
    state.folderLoading = false;
    byId('folder-dialog').close();
  }

  async function selectFolder() {
    if (!state.folderPath || state.folderLoading || byId('select-folder').disabled) return;
    if (state.folderTarget === 'storage') { byId('storage-import-path').value = state.folderPath; closeFolderPicker(); return; }
    if (state.folderTarget === 'settings') {
      byId('settings-workspace').value = state.folderPath;
      closeFolderPicker();
      return;
    }
    if (!confirmDiscard()) return;
    byId('select-folder').disabled = true;
    setBusy(true);
    try {
      updateBootstrap(await json('/api/workspace', { method: 'POST', body: { workspace: state.folderPath } }));
      state.fileRequest++;
      state.file = null;
      state.original = '';
      ui.editor.value = '';
      ui.editorPanel.hidden = true;
      document.querySelector('.workspace-layout').classList.remove('editor-open');
      setContext('');
      await Promise.all([loadFiles(''), loadSession(), loadSessions()]);
      closeFolderPicker();
      toast('已打开 ' + basename(state.bootstrap.workspace));
      if (window.innerWidth <= 600) setSidebarCollapsed(true);
    } catch (error) {
      byId('folder-error').textContent = error.message;
      byId('folder-error').hidden = false;
      byId('select-folder').disabled = false;
    } finally { setBusy(false); }
  }

  byId('browse-storage-import').addEventListener('click', function () { openFolderPicker('storage'); });
  byId('import-storage').addEventListener('click', importStorage);
  byId('storage-import-path').addEventListener('keydown', function (event) { if (event.key === 'Enter') { event.preventDefault(); importStorage(); } });
  byId('choose-missing-workspace').addEventListener('click', function () { openFolderPicker('workspace'); });
  byId('settings-base-url').addEventListener('input', updateKeyStatus);
  byId('settings-context-window').addEventListener('input', function () { byId('context-allocation-note').textContent = Number(this.value) === (state.bootstrap || {}).contextWindow ? '按已保存的上下文窗口计算' : '保存后按新窗口重新计算'; });
  byId('session-stats-time').addEventListener('click', function () { openSessionStats('time'); });
  byId('session-stats-usage').addEventListener('click', function () { openSessionStats('usage'); });
  document.addEventListener('pointerdown', function (event) {
    if (state.statsPanel && !byId('session-stats').contains(event.target) && !byId('session-stats-panel').contains(event.target)) closeSessionStats(false);
  });
  document.addEventListener('keydown', function (event) {
    if (!state.statsPanel) return;
    if (event.key === 'Escape') { event.preventDefault(); closeSessionStats(true); }
    else if (event.key === 'Tab' && event.target === byId('session-stats-panel')) closeSessionStats(true);
  });
  window.addEventListener('resize', positionSessionStats);
  document.addEventListener('scroll', positionSessionStats, true);
  document.addEventListener('visibilitychange', function () { if (!document.hidden && state.ready) refreshSessionStats(); scheduleStatsRefresh(); });
  byId('chat-form').addEventListener('submit', sendMessage);
  ui.input.addEventListener('input', function () {
    ui.input.style.height = 'auto';
    ui.input.style.height = Math.min(ui.input.scrollHeight, 190) + 'px';
    updateSend();
  });
  ui.input.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); byId('chat-form').requestSubmit(); }
  });
  ui.cancel.addEventListener('click', cancelMessage);
  byId('new-session').addEventListener('click', newSession);
  byId('brand-home').addEventListener('click', newSession);
  byId('settings-button').addEventListener('click', openSettings);
  byId('model-button').addEventListener('click', openSettings);
  byId('context-usage').addEventListener('click', function () { openSettings(); byId('settings-context-window').focus(); });
  byId('compact-context').addEventListener('click', compactContext);
  byId('queue-mode').addEventListener('change', updateSend);
  byId('session-menu-button').addEventListener('click', openSessionMenu);
  byId('rename-session').addEventListener('click', openRenameSession);
  byId('fork-session').addEventListener('click', forkSession);
  byId('export-session-jsonl').addEventListener('click', function () { exportSession('jsonl'); });
  byId('export-session-html').addEventListener('click', function () { exportSession('html'); });
  byId('rename-session-form').addEventListener('submit', renameSession);
  ['close-rename-session', 'cancel-rename-session'].forEach(function (id) { byId(id).addEventListener('click', function () { byId('rename-session-dialog').close(); }); });
  document.addEventListener('click', function (event) { if (!byId('session-menu-button').contains(event.target) && !byId('session-menu').contains(event.target)) closeSessionMenu(); });
  window.addEventListener('resize', closeSessionMenu);
  byId('session-menu').addEventListener('keydown', function (event) { if (event.key === 'Escape') { closeSessionMenu(); byId('session-menu-button').focus(); } });
  byId('permission-button').addEventListener('click', openPermissionMenu);
  byId('permission-menu').addEventListener('keydown', function (event) {
    const items = Array.from(byId('permission-menu').querySelectorAll('button'));
    const current = items.indexOf(document.activeElement);
    if (event.key === 'Escape') { event.preventDefault(); closePermissionMenu(); byId('permission-button').focus(); }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); items[(current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus(); }
    if (event.key === 'Tab') closePermissionMenu();
  });
  document.addEventListener('click', function (event) { if (!byId('permission-button').contains(event.target) && !byId('permission-menu').contains(event.target)) closePermissionMenu(); });
  window.addEventListener('resize', closePermissionMenu);
  ['close-full-access', 'cancel-full-access'].forEach(function (id) { byId(id).addEventListener('click', function () { byId('full-access-dialog').close(); }); });
  byId('acknowledge-full-access').addEventListener('change', function () { byId('enable-full-access').disabled = !byId('acknowledge-full-access').checked; });
  byId('enable-full-access').addEventListener('click', function () {
    if (!byId('acknowledge-full-access').checked) return;
    byId('full-access-dialog').close();
    selectPermission('danger-full-access');
  });
  ['model', 'mcp', 'skills', 'resources', 'storage'].forEach(function (name) {
    byId('settings-tab-' + name).addEventListener('click', function () { selectSettingsTab(name); });
    byId('settings-tab-' + name).addEventListener('keydown', function (event) {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      const names = ['model', 'mcp', 'skills', 'resources', 'storage'];
      const next = names[(names.indexOf(name) + (event.key === 'ArrowRight' ? 1 : names.length - 1)) % names.length];
      selectSettingsTab(next); byId('settings-tab-' + next).focus();
    });
  });
  byId('refresh-resources').addEventListener('click', loadPiResources);
  byId('save-resources').addEventListener('click', savePiResources);
  byId('save-mcp').addEventListener('click', function () { saveExtensions('mcp'); });
  byId('save-skills').addEventListener('click', function () { saveExtensions('skills'); });
  byId('refresh-skills').addEventListener('click', loadExtensions);
  byId('mcp-example').addEventListener('click', fillMcpExample);
  byId('workspace-button').addEventListener('click', function () { openFolderPicker('workspace'); });
  byId('sidebar-folder-button').addEventListener('click', function () { openFolderPicker('workspace'); });
  byId('browse-workspace').addEventListener('click', function () { openFolderPicker('settings'); });
  byId('close-folder-picker').addEventListener('click', closeFolderPicker);
  byId('cancel-folder-picker').addEventListener('click', closeFolderPicker);
  byId('select-folder').addEventListener('click', selectFolder);
  byId('folder-path-form').addEventListener('submit', function (event) { event.preventDefault(); loadFolders(byId('folder-path-input').value.trim()); });
  byId('folder-path-input').addEventListener('input', function () { byId('select-folder').disabled = byId('folder-path-input').value.trim() !== state.folderPath; });
  byId('folder-dialog').addEventListener('cancel', function () { state.folderRequest++; state.folderLoading = false; });
  byId('toggle-sidebar').addEventListener('click', function () { setSidebarCollapsed(true); });
  byId('expand-sidebar').addEventListener('click', function () { setSidebarCollapsed(false); });
  byId('search-sessions-button').addEventListener('click', function () {
    byId('session-search').hidden = !byId('session-search').hidden;
    if (!byId('session-search').hidden) byId('session-query').focus();
    else { byId('session-query').value = ''; renderSessions(); }
  });
  byId('session-query').addEventListener('keydown', function (event) { if (event.key === 'Escape') { event.preventDefault(); this.value = ''; byId('session-search').hidden = true; renderSessions(); byId('search-sessions-button').focus(); } });
  byId('session-query').addEventListener('input', renderSessions);
  byId('settings-form').addEventListener('submit', saveSettings);
  byId('close-settings').addEventListener('click', function () { ui.settings.close(); });
  byId('dismiss-settings').addEventListener('click', function () { ui.settings.close(); });
  ui.settings.addEventListener('close', function () { byId('settings-api-key').value = ''; });
  byId('refresh-files').addEventListener('click', function () { loadFiles(state.directory); });
  byId('parent-directory').addEventListener('click', function () { const parts = state.directory.split(/[\\/]/); parts.pop(); loadFiles(parts.join('/')); });
  byId('toggle-files').addEventListener('click', function () { toggleFiles(); });
  byId('composer-files').addEventListener('click', function () { toggleFiles(true); });
  byId('close-files').addEventListener('click', function () { toggleFiles(false); });
  byId('close-editor').addEventListener('click', closeEditor);
  byId('save-file').addEventListener('click', saveFile);
  byId('show-diff').addEventListener('click', function () { setDiff(!state.diff); });
  byId('reference-file').addEventListener('click', function () { setContext(state.file || ''); ui.input.focus(); if (window.innerWidth <= 720) { ui.editorPanel.hidden = true; document.querySelector('.workspace-layout').classList.remove('editor-open'); } });
  byId('remove-context').addEventListener('click', function () { setContext(''); });
  ui.editor.addEventListener('input', markEdited);
  ui.editor.addEventListener('keydown', function (event) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); saveFile(); }
    if (event.key === 'Tab') {
      event.preventDefault();
      const start = ui.editor.selectionStart;
      ui.editor.setRangeText('  ', start, ui.editor.selectionEnd, 'end');
      markEdited();
    }
  });
  document.querySelectorAll('.suggestion').forEach(function (button) { button.addEventListener('click', function () { ui.input.value = button.dataset.prompt; updateSend(); ui.input.focus(); }); });
  window.addEventListener('beforeunload', function (event) { if (hasEdits() || state.busy) { event.preventDefault(); event.returnValue = ''; } });

  (async function init() {
    try {
      await bootstrap();
      const results = await Promise.allSettled([loadFiles(''), loadSession(), loadSessions()]);
      results.forEach(function (result) { if (result.status === 'rejected') toast(result.reason.message, true); });
      state.ready = true;
      ui.input.disabled = false;
      if (state.bootstrap.busy) {
        setBusy(true);
        (state.bootstrap.pendingApprovals || []).forEach(showApproval);
        recoverActiveSession();
      }
      updateSend();
      if (window.innerWidth <= 600) setSidebarCollapsed(true);
      if (!state.bootstrap.model || !state.bootstrap.baseUrl) openSettings();
    } catch (error) {
      byId('connection-status').classList.add('error');
      byId('connection-status').lastElementChild.textContent = '服务未连接';
      byId('session-status').textContent = '连接失败，请刷新重试';
      ui.fileList.replaceChildren(make('p', 'muted empty-small', '本地服务尚未连接。'));
      toast(error.message, true);
    }
  })();

  async function recoverActiveSession() {
    if (!state.busy || state.abort) return;
    try {
      const result = await json('/api/session');
      if (result.sessionStats) acceptSessionStats(result.sessionStats, true);
      (result.pendingApprovals || []).forEach(showApproval);
      if (result.contextStats) updateContext(result.contextStats);
      if (!result.busy) {
        await bootstrap();
        await loadSession();
        await loadSessions();
        setBusy(false);
        byId('session-status').textContent = '准备就绪';
        return;
      }
      const pending = new Set((result.pendingApprovals || []).map(function (item) { return item.id; }));
      state.approvals.forEach(function (item, id) { if (!pending.has(id) && !item.card.classList.contains('resolved')) approvalResolved(id, 'cancel'); });
    } catch (error) { byId('session-status').textContent = '等待恢复连接'; }
    setTimeout(recoverActiveSession, 1500);
  }
})();
