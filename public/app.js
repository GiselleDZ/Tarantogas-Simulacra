'use strict';

// ── State ──────────────────────────────────────────────────────────────────────
const approvals = new Map(); // id → ApprovalRecord
let selectedId = null;
let ws = null;
let contextOpen = false;

const activityEvents = []; // client-side ring buffer (max 500)
let activeRoleFilter = 'all';
let autoscroll = true;
let activeTab = 'approvals';

// System health state
let systemAgents = [];
let systemDriftEvents = [];
let systemEvents = [];
let systemCosts = { global_total_usd: 0, per_project: [] };
let systemLoaded = false;

const PANE_DISPLAY = { approvals: 'grid', activity: 'flex', projects: 'flex', system: 'flex' };

// ── DOM helpers ────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function formatTimestamp(isoString) {
  const d = new Date(isoString);
  const mon = MONTHS[d.getMonth()];
  const dd = String(d.getDate()).padStart(2, '0');
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${mon} ${dd}, ${yyyy} ${hh}:${mm}`;
}

function statusBadgeClass(record) {
  const { status, decision } = record.frontmatter;
  if (status === 'decided' && decision) return `badge badge-decided-${decision}`;
  if (status === 'in_conversation') return 'badge badge-in_conversation';
  if (status === 'needs_research') return 'badge badge-needs_research';
  return 'badge badge-pending';
}

function statusBadgeLabel(record) {
  const { status, decision } = record.frontmatter;
  if (status === 'decided' && decision) return decision;
  return status.replace(/_/g, '\u00A0');
}

// ── Tab navigation ─────────────────────────────────────────────────────────────

// Ensure initial pane is visible (belt-and-suspenders over CSS specificity)
document.getElementById(`tab-${activeTab}`).style.display = PANE_DISPLAY[activeTab];

function switchTab(name) {
  document.querySelector('.tab.active').classList.remove('active');
  document.getElementById(`tab-${activeTab}`).style.display = 'none';
  activeTab = name;
  document.querySelector(`[data-tab="${name}"]`).classList.add('active');
  const pane = document.getElementById(`tab-${name}`);
  pane.removeAttribute('hidden');
  pane.style.display = PANE_DISPLAY[name] ?? 'flex';
  if (name === 'activity') {
    renderActivityFeed();
    // If WS snapshot arrived before chokidar's initial scan, fall back to REST
    if (activityEvents.length === 0) {
      fetch('/api/activity')
        .then((r) => r.json())
        .then((events) => {
          if (events.length > 0 && activityEvents.length === 0) {
            activityEvents.push(...events);
            renderActivityFeed();
          }
        })
        .catch(() => { /* silent — WS will bring events when available */ });
    }
  }
  if (name === 'projects' && !projectsLoaded) loadProjects();
  if (name === 'system') {
    renderSystemHealth();
    if (!systemLoaded) loadSystemHealth();
  }
}

for (const btn of document.querySelectorAll('.tab')) {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
}

// ── Queue rendering ────────────────────────────────────────────────────────────
function renderQueue() {
  const queue = $('queue');
  const emptyEl = $('queue-empty');

  const sorted = [...approvals.values()].sort((a, b) => {
    const aS = a.frontmatter.status === 'pending' ? 0 : 1;
    const bS = b.frontmatter.status === 'pending' ? 0 : 1;
    if (aS !== bS) return aS - bS;
    return b.frontmatter.created_at.localeCompare(a.frontmatter.created_at);
  });

  const pendingCount = sorted.filter(r => r.frontmatter.status === 'pending').length;
  $('tab-count-approvals').textContent = pendingCount > 0 ? String(pendingCount) : '';
  document.title = pendingCount > 0 ? `(${pendingCount}) Simulacra` : 'Simulacra';

  for (const el of [...queue.querySelectorAll('.approval-card')]) el.remove();

  if (sorted.length === 0) { emptyEl.hidden = false; return; }
  emptyEl.hidden = true;

  for (const record of sorted) {
    const fm = record.frontmatter;
    const card = document.createElement('div');
    card.className = `approval-card status-${fm.status}`;
    if (fm.id === selectedId) card.classList.add('selected');
    card.dataset.id = fm.id;
    card.innerHTML = `
      <div class="card-top">
        <span class="${statusBadgeClass(record)}">${statusBadgeLabel(record)}</span>
        <span class="card-type">${escapeHtml(fm.type.replace(/_/g, ' '))}</span>
      </div>
      <div class="card-meta">
        <span>${escapeHtml(fm.project ?? '—')}</span>
        <span>${escapeHtml(fm.created_by)}</span>
      </div>
      <div class="card-time">${formatTimestamp(fm.created_at)}</div>
    `;
    card.addEventListener('click', () => selectApproval(fm.id));
    queue.appendChild(card);
  }
}

// ── Detail rendering ───────────────────────────────────────────────────────────
function renderDetail(id) {
  const record = approvals.get(id);
  const emptyEl = $('detail-empty');
  const contentEl = $('detail-content');

  if (!record) { emptyEl.hidden = false; contentEl.hidden = true; return; }
  emptyEl.hidden = true;
  contentEl.hidden = false;

  const fm = record.frontmatter;

  $('detail-meta').innerHTML = `
    <div class="meta-row">
      <span class="meta-label">Type</span>
      <span class="meta-value">${escapeHtml(fm.type)}</span>
      <span class="${statusBadgeClass(record)}" style="margin-left:auto">${statusBadgeLabel(record)}</span>
    </div>
    <div class="meta-row">
      <span class="meta-label">Project</span>
      <span class="meta-value">${escapeHtml(fm.project ?? '—')}</span>
    </div>
    <div class="meta-row">
      <span class="meta-label">From</span>
      <span class="meta-value">${escapeHtml(fm.created_by)}</span>
    </div>
    <div class="meta-row">
      <span class="meta-label">Council</span>
      <span class="meta-value rec-${escapeHtml(fm.council_recommendation)}">${escapeHtml(fm.council_recommendation)}</span>
    </div>
    <div class="meta-row">
      <span class="meta-label">Created</span>
      <span class="meta-value" style="color:var(--text-muted)">${new Date(fm.created_at).toLocaleString()}</span>
    </div>
    ${fm.decision ? `<div class="meta-row">
      <span class="meta-label">Decision</span>
      <span class="meta-value">${escapeHtml(fm.decision)}</span>
    </div>` : ''}
    ${fm.decision_rationale ? `<div class="meta-row">
      <span class="meta-label">Rationale</span>
      <span class="meta-value" style="color:var(--text-muted)">${escapeHtml(fm.decision_rationale)}</span>
    </div>` : ''}
  `;

  $('detail-body-text').textContent = record.body.trim();

  contextOpen = false;
  $('ctx-toggle').textContent = '▸ Show research context';
  $('ctx-toggle').disabled = false;
  $('ctx-content').hidden = true;
  $('ctx-content').innerHTML = '';

  renderActions(fm.status, id);
}

function renderActions(status, id) {
  const container = $('detail-actions');
  container.innerHTML = '';

  if (status === 'decided') {
    container.innerHTML = `<span style="color:var(--text-faint);font-size:11px;letter-spacing:0.06em">DECISION RECORDED</span>`;
    return;
  }

  // Response textarea — the primary interaction for substantive answers
  const textarea = document.createElement('textarea');
  textarea.id = 'action-rationale';
  textarea.className = 'action-rationale';
  textarea.placeholder = 'Your response...';
  textarea.rows = 3;
  container.appendChild(textarea);

  const btnRow = document.createElement('div');
  btnRow.className = 'action-btn-row';

  const buttons = [
    { label: 'Approve', cls: 'btn btn-approve', action: 'approved' },
    { label: 'Decline', cls: 'btn btn-decline', action: 'declined' },
    { label: 'Defer',   cls: 'btn btn-defer',   action: 'deferred' },
    { label: 'Snooze',  cls: 'btn btn-snooze',  action: 'snooze' },
  ];

  for (const { label, cls, action } of buttons) {
    const btn = document.createElement('button');
    btn.className = cls;
    btn.textContent = label;
    btn.addEventListener('click', () => handleAction(id, action, btn));
    btnRow.appendChild(btn);
  }

  container.appendChild(btnRow);
}

// ── Actions ────────────────────────────────────────────────────────────────────
async function handleAction(id, action, btn) {
  btn.disabled = true;

  try {
    if (action === 'snooze') {
      await apiPost(`/api/approvals/${id}/snooze`, {});
      return;
    }

    const rationale = ($('action-rationale')?.value ?? '').trim();

    await apiPost(`/api/approvals/${id}/decide`, {
      decision: action,
      ...(rationale ? { rationale } : {}),
    });
  } finally {
    btn.disabled = false;
  }
}

async function apiPost(url, body) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (networkErr) {
    const msg = `Network error on POST ${url}: ${networkErr.message}`;
    console.error(msg, networkErr);
    alert(msg);
    throw networkErr;
  }

  if (!res.ok) {
    let detail = res.statusText;
    let stack = '';
    try {
      const data = await res.json();
      detail = data.error ?? JSON.stringify(data);
      stack = data.stack ?? '';
    } catch {
      detail = await res.text().catch(() => res.statusText);
    }
    const msg = `${res.status} ${res.statusText} — POST ${url}\n\n${detail}`;
    console.error('[API Error]', { status: res.status, url, detail, stack });
    if (stack) console.error('[Stack]', stack);
    alert(msg);
    throw new Error(msg);
  }

  return res;
}

// ── Context toggle ─────────────────────────────────────────────────────────────
$('ctx-toggle').addEventListener('click', async () => {
  if (!selectedId) return;

  if (contextOpen) {
    contextOpen = false;
    $('ctx-toggle').textContent = '▸ Show research context';
    $('ctx-content').hidden = true;
    return;
  }

  $('ctx-toggle').textContent = '⟳ Loading…';
  $('ctx-toggle').disabled = true;

  try {
    const res = await fetch(`/api/approvals/${selectedId}/context`);
    const ctx = await res.json();
    renderContext(ctx);
    contextOpen = true;
    $('ctx-toggle').textContent = '▾ Hide research context';
  } catch {
    $('ctx-toggle').textContent = '▸ Show research context (failed to load)';
  } finally {
    $('ctx-toggle').disabled = false;
  }
});

function renderContext(ctx) {
  const container = $('ctx-content');
  container.innerHTML = '';

  const hasContent = ctx.researchApprovalBody || (ctx.taskSections && ctx.taskSections.length > 0);
  if (!hasContent) {
    container.innerHTML = '<div style="color:var(--text-faint);font-size:11px;padding:4px 0">No linked research context available for this approval.</div>';
    container.hidden = false;
    return;
  }

  if (ctx.researchApprovalBody) {
    const block = document.createElement('div');
    block.className = 'ctx-block';
    block.innerHTML = '<div class="ctx-block-label">Research Findings</div>';
    const pre = document.createElement('pre');
    pre.textContent = ctx.researchApprovalBody;
    block.appendChild(pre);
    container.appendChild(block);
  }

  for (const section of (ctx.taskSections || [])) {
    const block = document.createElement('div');
    block.className = 'ctx-block';
    block.innerHTML = `<div class="ctx-block-label">Task Research — ${escapeHtml(section.taskId)}</div>`;
    const pre = document.createElement('pre');
    pre.textContent = section.content;
    block.appendChild(pre);
    container.appendChild(block);
  }

  container.hidden = false;
}

// ── Selection ──────────────────────────────────────────────────────────────────
function selectApproval(id) {
  selectedId = id;
  renderQueue();
  renderDetail(id);
}

// ── Activity Feed ──────────────────────────────────────────────────────────────
function formatTime(isoString) {
  return formatTimestamp(isoString);
}

function createEventRow(evt) {
  const row = document.createElement('div');
  row.className = `activity-row role-${evt.role}`;

  const time = document.createElement('span');
  time.className = 'act-time';
  time.textContent = formatTime(evt.timestamp);

  const role = document.createElement('span');
  role.className = 'act-role';
  role.textContent = evt.role;

  const agent = document.createElement('span');
  agent.className = 'act-agent';
  agent.textContent = evt.agentId;
  agent.title = evt.agentId;

  const task = document.createElement('span');
  task.className = 'act-task';
  task.textContent = evt.taskId;
  task.title = evt.taskId;

  const type = document.createElement('span');
  type.className = 'act-type';
  type.textContent = evt.type;

  const sep = document.createElement('span');
  sep.className = 'act-sep';
  sep.textContent = '│';

  const msg = document.createElement('span');
  msg.className = 'act-msg';
  msg.textContent = evt.message;
  msg.title = evt.message;

  row.append(time, role, agent, task, type, sep, msg);
  return row;
}

function renderActivityFeed() {
  const feed = $('activity-feed');
  feed.innerHTML = '';
  const filtered = activeRoleFilter === 'all'
    ? activityEvents
    : activityEvents.filter(e => e.role === activeRoleFilter);
  const fragment = document.createDocumentFragment();
  for (const evt of filtered) fragment.appendChild(createEventRow(evt));
  feed.appendChild(fragment);
  if (autoscroll) feed.scrollTop = feed.scrollHeight;
}

function renderNewRows(events) {
  const feed = $('activity-feed');
  const filtered = activeRoleFilter === 'all'
    ? events
    : events.filter(e => e.role === activeRoleFilter);
  for (const evt of filtered) feed.appendChild(createEventRow(evt));
  if (autoscroll) feed.scrollTop = feed.scrollHeight;
}

function appendActivityEvents(events) {
  activityEvents.push(...events);
  if (activityEvents.length > 500) activityEvents.splice(0, activityEvents.length - 500);
  if (activeTab === 'activity') renderNewRows(events);
}

// Role filter buttons
for (const btn of document.querySelectorAll('.role-filter')) {
  btn.addEventListener('click', () => {
    document.querySelector('.role-filter.active').classList.remove('active');
    btn.classList.add('active');
    activeRoleFilter = btn.dataset.role;
    renderActivityFeed();
  });
}

// Auto-scroll: pause when user manually scrolls up
$('activity-feed').addEventListener('scroll', () => {
  const feed = $('activity-feed');
  const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
  if (!atBottom && autoscroll) {
    autoscroll = false;
    $('autoscroll').checked = false;
  }
});

$('autoscroll').addEventListener('change', (e) => {
  autoscroll = e.target.checked;
  if (autoscroll) $('activity-feed').scrollTop = $('activity-feed').scrollHeight;
});

// ── Projects Tab ──────────────────────────────────────────────────────────────
const projects = new Map();      // slug → ProjectRegistry
const projectTasks = new Map();  // taskId → TaskRecord (selected project)
const projectCosts = new Map();  // slug → { total_cost_usd, entries }
let selectedProjectSlug = null;
let selectedTaskId = null;
let projectsLoaded = false;

const LANES = [
  { id: 'queued',      label: 'Queued',      statuses: ['pending', 'blocked'] },
  { id: 'research',    label: 'Research',    statuses: ['research_pending', 'research_review'] },
  { id: 'in_progress', label: 'In Progress', statuses: ['assigned', 'in_progress', 'crafter_revision'] },
  { id: 'review',      label: 'Review',      statuses: ['steward_review', 'steward_final', 'compound', 'council_review', 'council_peer_review', 'drift_detected', 'drift_cleared'] },
  { id: 'done',        label: 'Done',        statuses: ['done', 'cancelled'] },
];

async function loadProjects() {
  const res = await fetch('/api/projects');
  const list = await res.json();
  projects.clear();
  for (const p of list) projects.set(p.slug, p);
  projectsLoaded = true;
  renderProjectList();
}

function renderProjectList() {
  const container = $('projects-list');
  const emptyEl = $('projects-empty-sidebar');
  for (const el of [...container.querySelectorAll('.project-card')]) el.remove();

  if (projects.size === 0) { emptyEl.hidden = false; return; }
  emptyEl.hidden = true;

  for (const p of projects.values()) {
    const card = document.createElement('div');
    card.className = 'project-card' + (p.slug === selectedProjectSlug ? ' selected' : '');
    card.innerHTML = `
      <div class="project-card-name">${escapeHtml(p.name)}</div>
      <div class="project-card-meta">
        <span class="proj-status-${p.status}">${escapeHtml(p.status.replace(/_/g, ' '))}</span>
        <span>${escapeHtml(p.crafter_types.join(', '))}</span>
      </div>
    `;
    card.addEventListener('click', () => selectProject(p.slug));
    container.appendChild(card);
  }
}

async function selectProject(slug) {
  selectedProjectSlug = slug;
  selectedTaskId = null;
  renderProjectList();

  $('projects-empty-main').hidden = true;
  const view = $('project-view');
  view.removeAttribute('hidden');
  view.style.display = 'flex';

  const [tasksRes, costsRes] = await Promise.all([
    fetch(`/api/projects/${slug}/tasks`),
    fetch(`/api/projects/${slug}/costs`),
  ]);
  const list = await tasksRes.json();
  const costs = await costsRes.json();
  projectTasks.clear();
  for (const t of list) projectTasks.set(t.frontmatter.id, t);
  projectCosts.set(slug, costs);

  renderProjectHeader();
  renderPipeline();
  $('task-detail').hidden = true;
}

function renderProjectHeader() {
  const p = projects.get(selectedProjectSlug);
  if (!p) return;
  const costs = projectCosts.get(selectedProjectSlug);
  const costStr = costs && costs.total_cost_usd > 0
    ? `&nbsp;·&nbsp; $${costs.total_cost_usd.toFixed(4)} spent`
    : '';
  $('project-header').innerHTML = `
    <div class="project-title">${escapeHtml(p.name)}</div>
    <div class="project-subtitle">
      <span class="proj-status-${p.status}">${escapeHtml(p.status.replace(/_/g, ' '))}</span>
      &nbsp;·&nbsp; ${escapeHtml(p.crafter_types.join(', '))}
      &nbsp;·&nbsp; ${projectTasks.size} task${projectTasks.size !== 1 ? 's' : ''}${costStr}
    </div>
  `;
}

function renderPipeline() {
  const pipeline = $('task-pipeline');
  pipeline.innerHTML = '';

  for (const lane of LANES) {
    const tasks = [...projectTasks.values()].filter(t => lane.statuses.includes(t.frontmatter.status));

    const laneEl = document.createElement('div');
    laneEl.className = 'pipeline-lane';

    const header = document.createElement('div');
    header.className = 'pipeline-lane-header';
    header.textContent = lane.label;
    if (tasks.length > 0) {
      const badge = document.createElement('span');
      badge.className = 'pipeline-lane-count';
      badge.textContent = String(tasks.length);
      header.appendChild(badge);
    }
    laneEl.appendChild(header);

    for (const task of tasks) {
      laneEl.appendChild(createTaskCard(task));
    }

    pipeline.appendChild(laneEl);
  }
}

function createTaskCard(task) {
  const fm = task.frontmatter;
  const card = document.createElement('div');
  card.className = 'task-card' + (fm.id === selectedTaskId ? ' selected' : '');

  const title = document.createElement('div');
  title.className = 'task-card-title';
  title.textContent = fm.title;

  const meta = document.createElement('div');
  meta.className = 'task-card-meta';

  const badge = document.createElement('span');
  badge.className = `task-status-badge status-${fm.status}`;
  badge.textContent = fm.status.replace(/_/g, ' ');

  const type = document.createElement('span');
  type.className = 'task-crafter-type';
  type.textContent = fm.crafter_type;

  meta.append(badge, type);
  card.append(title, meta);
  card.addEventListener('click', () => selectTask(fm.id));
  return card;
}

function selectTask(id) {
  selectedTaskId = id;
  renderPipeline(); // update selected state on cards

  const task = projectTasks.get(id);
  if (!task) return;
  const fm = task.frontmatter;

  // Header
  $('task-detail-header').innerHTML = `
    <span class="task-detail-title">${escapeHtml(fm.title)}</span>
    <button class="task-detail-close" id="task-detail-close-btn">×</button>
  `;
  $('task-detail-close-btn').addEventListener('click', () => {
    selectedTaskId = null;
    $('task-detail').hidden = true;
    renderPipeline();
  });

  // Meta
  const metaItems = [
    { label: 'Status',   value: fm.status.replace(/_/g, ' ') },
    { label: 'Priority', value: fm.priority },
    { label: 'Type',     value: fm.crafter_type },
    { label: 'Crafter',  value: fm.assigned_crafter ?? '—' },
    { label: 'Updated',  value: new Date(fm.updated_at).toLocaleString() },
  ];
  $('task-detail-meta').innerHTML = metaItems.map(({ label, value }) => `
    <div class="task-meta-item">
      <span class="task-meta-label">${label}</span>
      <span class="task-meta-value">${escapeHtml(value)}</span>
    </div>
  `).join('');

  // Body
  $('task-detail-body').textContent = task.body.trim() || '(no content)';

  // Actions
  renderTaskDetailActions(task);

  const detail = $('task-detail');
  detail.removeAttribute('hidden');
  detail.style.display = 'flex';
}

function renderTaskDetailActions(task) {
  const container = $('task-detail-actions');
  container.innerHTML = '';
  const fm = task.frontmatter;
  const slug = selectedProjectSlug;

  if (fm.status === 'blocked') {
    const btn = document.createElement('button');
    btn.className = 'btn btn-approve';
    btn.style.cssText = 'font-size:11px;padding:5px 14px';
    btn.textContent = 'Unblock';
    btn.addEventListener('click', () => taskAction(slug, fm.id, 'unblock', btn));
    container.appendChild(btn);
  } else if (!['done', 'cancelled'].includes(fm.status)) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-decline';
    btn.style.cssText = 'font-size:11px;padding:5px 14px';
    btn.textContent = 'Block';
    btn.addEventListener('click', () => taskAction(slug, fm.id, 'block', btn));
    container.appendChild(btn);
  }
}

async function taskAction(slug, taskId, action, btn) {
  btn.disabled = true;
  try {
    await apiPost(`/api/projects/${slug}/tasks/${taskId}/${action}`, {});
  } finally {
    btn.disabled = false;
  }
}

// Add-project form
$('add-project-btn').addEventListener('click', () => {
  const form = $('add-project-form');
  if (form.hidden) {
    form.removeAttribute('hidden');
    form.style.display = 'flex';
  } else {
    form.hidden = true;
  }
});

$('add-project-cancel').addEventListener('click', () => {
  $('add-project-form').hidden = true;
  $('add-project-form').reset();
});

$('add-project-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('proj-name').value.trim();
  const projPath = $('proj-path').value.trim();
  const crafterTypes = $('proj-crafters').value.split(',').map(s => s.trim()).filter(Boolean);
  await apiPost('/api/projects', { name, path: projPath, crafterTypes });
  $('add-project-form').hidden = true;
  $('add-project-form').reset();
  await loadProjects();
});

// ── System Health Tab ─────────────────────────────────────────────────────────
function formatUptime(ms) {
  if (ms < 1000) return '0s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

async function loadSystemHealth() {
  try {
    const res = await fetch('/api/system');
    const data = await res.json();
    systemAgents = data.agents || [];
    systemDriftEvents = data.drift_events || [];
    systemEvents = data.system_events || [];
    systemCosts = data.costs || { global_total_usd: 0, per_project: [] };
    systemLoaded = true;
    if (activeTab === 'system') renderSystemHealth();
  } catch {
    // Silent — WS will bring data when available
  }
}

function renderSystemHealth() {
  renderAgentsTable();
  renderDriftEvents();
  renderCostSummary();
  renderSystemEvents();
}

function renderAgentsTable() {
  const tbody = $('agents-tbody');
  const emptyEl = $('agents-empty');
  tbody.innerHTML = '';

  if (systemAgents.length === 0) {
    $('agents-table').hidden = true;
    emptyEl.hidden = false;
    return;
  }
  $('agents-table').hidden = false;
  emptyEl.hidden = true;

  for (const agent of systemAgents) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(agent.id)}</td>
      <td><span class="agent-role-${agent.role}">${escapeHtml(agent.role)}${agent.crafter_type ? ' (' + escapeHtml(agent.crafter_type) + ')' : ''}</span></td>
      <td>${agent.pid}</td>
      <td>${escapeHtml(agent.task_id || '—')}</td>
      <td>${escapeHtml(agent.project_slug || '—')}</td>
      <td>${formatUptime(agent.uptime_ms)}</td>
    `;
    tbody.appendChild(tr);
  }
}

function renderDriftEvents() {
  const list = $('drift-list');
  const emptyEl = $('drift-empty');
  list.innerHTML = '';

  if (systemDriftEvents.length === 0) {
    emptyEl.hidden = false;
    return;
  }
  emptyEl.hidden = true;

  // Show newest first
  const reversed = [...systemDriftEvents].reverse();
  for (const evt of reversed) {
    const row = document.createElement('div');
    row.className = 'drift-row';
    row.innerHTML = `
      <span class="drift-time">${formatTimestamp(evt.timestamp)}</span>
      <span class="drift-agent" title="${escapeHtml(evt.agent_id)}">${escapeHtml(evt.agent_id)}</span>
      <span class="drift-severity drift-severity-${evt.severity}">${escapeHtml(evt.severity)}</span>
      <span class="drift-score">${evt.score.toFixed(2)}</span>
      <span class="drift-action">${escapeHtml(evt.action_taken.replace(/_/g, ' '))}</span>
    `;
    list.appendChild(row);
  }
}

function renderCostSummary() {
  const container = $('cost-summary');
  const emptyEl = $('costs-empty');
  container.innerHTML = '';

  if (systemCosts.global_total_usd === 0 && systemCosts.per_project.length === 0) {
    emptyEl.hidden = false;
    return;
  }
  emptyEl.hidden = true;

  container.innerHTML = `
    <div class="cost-global">$${systemCosts.global_total_usd.toFixed(4)}</div>
    <div class="cost-global-label">Total spend across all projects</div>
  `;

  for (const p of systemCosts.per_project) {
    const card = document.createElement('div');
    card.className = 'cost-project-card';
    card.innerHTML = `
      <div class="cost-project-name">${escapeHtml(p.slug)}</div>
      <div class="cost-project-amount">$${p.total_usd.toFixed(4)}</div>
      <div class="cost-project-count">${p.entry_count} entr${p.entry_count === 1 ? 'y' : 'ies'}</div>
    `;
    container.appendChild(card);
  }
}

function renderSystemEvents() {
  const feed = $('system-event-feed');
  const emptyEl = $('events-empty');
  feed.innerHTML = '';

  if (systemEvents.length === 0) {
    emptyEl.hidden = false;
    return;
  }
  emptyEl.hidden = true;

  // Show newest first
  const reversed = [...systemEvents].reverse();
  for (const evt of reversed) {
    feed.appendChild(createSystemEventRow(evt));
  }
}

function createSystemEventRow(evt) {
  const row = document.createElement('div');
  row.className = 'system-event-row';

  row.innerHTML = `
    <span class="sev-time">${formatTimestamp(evt.t)}</span>
    <span class="sev-event sev-event-${evt.ev}">${escapeHtml(evt.ev.replace(/_/g, ' '))}</span>
    <span class="sev-agent" title="${escapeHtml(evt.agent_id || '')}">${escapeHtml(evt.agent_id || '—')}</span>
    <span class="sev-project">${escapeHtml(evt.project || '—')}</span>
    <span class="sev-cost">${evt.cost_usd != null ? '$' + evt.cost_usd.toFixed(4) : ''}</span>
    <span class="sev-duration">${evt.duration_ms != null ? formatUptime(evt.duration_ms) : ''}</span>
    <span class="sev-msg">${escapeHtml(evt.msg || '')}</span>
  `;

  return row;
}

function appendSystemEvents(newEvents) {
  systemEvents.push(...newEvents);
  if (systemEvents.length > 200) systemEvents.splice(0, systemEvents.length - 200);
  if (activeTab === 'system') renderSystemEvents();
}

function appendDriftEvents(newEvents) {
  systemDriftEvents.push(...newEvents);
  if (systemDriftEvents.length > 100) systemDriftEvents.splice(0, systemDriftEvents.length - 100);
  if (activeTab === 'system') renderDriftEvents();
}

// ── WebSocket ──────────────────────────────────────────────────────────────────
function connectWs() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}`);

  ws.addEventListener('open', () => {
    $('ws-status').classList.add('connected');
  });

  ws.addEventListener('close', () => {
    $('ws-status').classList.remove('connected');
    setTimeout(connectWs, 3000);
  });

  ws.addEventListener('error', () => {
    $('ws-status').classList.remove('connected');
  });

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'snapshot') {
      approvals.clear();
      for (const record of msg.approvals) approvals.set(record.frontmatter.id, record);
      renderQueue();
      if (selectedId && approvals.has(selectedId)) renderDetail(selectedId);
    } else if (msg.type === 'approval_update') {
      approvals.set(msg.approval.frontmatter.id, msg.approval);
      renderQueue();
      if (selectedId === msg.approval.frontmatter.id) renderDetail(selectedId);
    } else if (msg.type === 'activity_snapshot') {
      activityEvents.length = 0;
      activityEvents.push(...msg.events);
      if (activeTab === 'activity') renderActivityFeed();
    } else if (msg.type === 'activity_lines') {
      appendActivityEvents(msg.events);
    } else if (msg.type === 'task_update') {
      const t = msg.task;
      if (t.frontmatter.project === selectedProjectSlug) {
        projectTasks.set(t.frontmatter.id, t);
        renderPipeline();
        if (selectedTaskId === t.frontmatter.id) selectTask(t.frontmatter.id);
      }
    } else if (msg.type === 'projects_update') {
      projects.clear();
      for (const p of msg.projects) projects.set(p.slug, p);
      if (projectsLoaded) renderProjectList();
      if (selectedProjectSlug) renderProjectHeader();
    } else if (msg.type === 'system_snapshot') {
      systemAgents = msg.data.agents || [];
      systemDriftEvents = msg.data.drift_events || [];
      systemEvents = msg.data.system_events || [];
      systemCosts = msg.data.costs || { global_total_usd: 0, per_project: [] };
      systemLoaded = true;
      if (activeTab === 'system') renderSystemHealth();
    } else if (msg.type === 'system_update') {
      const u = msg.update;
      if (u.section === 'agents') {
        systemAgents = u.agents;
        if (activeTab === 'system') renderAgentsTable();
      } else if (u.section === 'drift_events') {
        appendDriftEvents(u.events);
      } else if (u.section === 'system_events') {
        appendSystemEvents(u.events);
      } else if (u.section === 'costs') {
        systemCosts = u.costs;
        if (activeTab === 'system') renderCostSummary();
      }
    }
  });
}

connectWs();
