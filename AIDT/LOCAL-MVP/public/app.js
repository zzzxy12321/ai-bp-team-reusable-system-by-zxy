const state = {
  summary: null,
  tasks: [],
  instances: [],
  workflows: [],
  objectDefs: [],
  objects: [],
  agents: [],
  connectors: [],
  audit: [],
  currentView: "dashboard",
  taskFilter: "pending"
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

function relativeTime(value) {
  if (!value) return "—";
  const diff = new Date(value).getTime() - Date.now();
  const minutes = Math.round(diff / 60000);
  const formatter = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" });
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

function isOverdue(task) {
  return task.status === "pending" && task.due_at && new Date(task.due_at).getTime() < Date.now();
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}

function toast(message, type = "") {
  const item = document.createElement("div");
  item.className = `toast ${type}`;
  item.textContent = message;
  $("#toastStack").appendChild(item);
  setTimeout(() => item.remove(), 3600);
}

function setView(view) {
  state.currentView = view;
  $$(".view").forEach(panel => panel.classList.toggle("active", panel.dataset.viewPanel === view));
  $$(".nav-item").forEach(item => item.classList.toggle("active", item.dataset.view === view));
  $("#mainContent").scrollTo({ top: 0, behavior: "auto" });
  if (window.innerWidth <= 940) document.body.classList.add("side-collapsed");
}

function openModal(html, options = {}) {
  $("#modalContent").innerHTML = html;
  $("#modal").classList.toggle("modal-wide", Boolean(options.wide));
  $("#modalBackdrop").hidden = false;
  document.body.style.overflow = "hidden";
}

function closeModal() {
  $("#modalBackdrop").hidden = true;
  $("#modalContent").innerHTML = "";
  $("#modal").classList.remove("modal-wide");
  document.body.style.overflow = "";
}

function actionLabel(action) {
  const map = {
    "instance.created": "发起流程",
    "instance.advanced": "流程推进",
    "instance.completed": "流程完成",
    "instance.rejected": "流程终止",
    "instance.returned": "流程退回",
    "object.created": "对象创建",
    "object.status_changed": "对象状态变更",
    "object.migrated": "对象引用迁移",
    "task.approve": "审批通过",
    "task.complete": "任务完成",
    "task.return": "任务退回",
    "task.reject": "任务终止",
    "agent.run": "数字员工运行",
    "agent.confirmed": "人工确认数字员工",
    "demo.reset": "重置演示数据"
  };
  return map[action] || action;
}

function priorityLabel(priority) {
  return { critical: "紧急", high: "高优", normal: "普通" }[priority] || "普通";
}

async function loadAll(showLoading = false) {
  if (showLoading) $("#loadingScreen").classList.remove("hidden");
  try {
    const [health, summary, tasks, instances, workflows, objectDefs, objects, agents, connectors, audit] = await Promise.all([
      api("/api/health"),
      api("/api/summary"),
      api("/api/tasks"),
      api("/api/instances"),
      api("/api/workflows"),
      api("/api/object-defs"),
      api("/api/objects"),
      api("/api/agents"),
      api("/api/connectors"),
      api("/api/audit")
    ]);
    Object.assign(state, { summary, tasks, instances, workflows, objectDefs, objects, agents, connectors, audit });
    $("#serviceTime").textContent = `本地时间 ${formatTime(health.time)}`;
    renderAll();
  } catch (error) {
    toast(`加载失败：${error.message}`, "error");
  } finally {
    setTimeout(() => $("#loadingScreen").classList.add("hidden"), showLoading ? 250 : 0);
  }
}

function renderAll() {
  renderNav();
  renderDashboard();
  renderTasks();
  renderProcesses();
  renderObjects();
  renderAgents();
  renderConnectors();
  renderAudit();
}

function renderNav() {
  const pending = state.tasks.filter(task => task.status === "pending").length;
  const overdue = state.tasks.filter(isOverdue).length;
  $("#navTaskCount").textContent = pending || "";
  $("#navOverdue").textContent = overdue || "";
}

function renderDashboard() {
  const counts = state.summary?.counts || {};
  const kpis = [
    ["业务对象", counts.objects, `${counts.objectTypes || 0} 类对象定义`, "var(--navy)", "#1f5b95"],
    ["流程实例", counts.activeInstances, "当前运行中", "var(--teal)", "#087f8c"],
    ["待办任务", counts.pendingTasks, counts.overdueTasks ? `${counts.overdueTasks} 项已逾期` : "暂无逾期", "var(--orange)", "#dd7b12"],
    ["数字员工", counts.agents, "独立身份与权限", "var(--purple)", "#7150ad"],
    ["连接器", counts.connectors, "全部为本地模拟", "var(--green)", "#12805f"],
    ["审计事件", counts.auditEvents, "可追溯操作证据", "var(--red)", "#c43f3f"]
  ];
  $("#kpiGrid").innerHTML = kpis.map(([label, value, note, color, raw]) => `
    <div class="kpi-card" style="--kc:${color}">
      <div class="kpi-label">${escapeHtml(label)}</div>
      <div class="kpi-value">${Number(value || 0)}</div>
      <div class="kpi-note">${escapeHtml(note)}</div>
      <div class="kpi-spark"><i style="width:${Math.min(100, 28 + Number(value || 0) * 8)}%;background:${raw}"></i></div>
    </div>
  `).join("");

  const pendingTasks = state.tasks.filter(task => task.status === "pending").slice(0, 4);
  $("#dashboardTasks").innerHTML = pendingTasks.length ? pendingTasks.map(task => `
    <div class="task-mini">
      <div class="task-priority ${task.priority}">${task.priority === "critical" ? "!" : task.priority === "high" ? "↑" : "✓"}</div>
      <div class="task-mini-main">
        <strong>${escapeHtml(task.step_name)}</strong>
        <span>${escapeHtml(task.instance_title)} · ${escapeHtml(task.assignee_name || "待分配")}</span>
      </div>
      <span class="task-status">${isOverdue(task) ? "已逾期" : formatTime(task.due_at)}</span>
    </div>
  `).join("") : `<div class="empty-state">当前没有待处理任务。可发起一个流程验证闭环。</div>`;

  const domains = state.summary?.domains || [];
  const maxDomain = Math.max(1, ...domains.map(item => item.count));
  $("#domainBars").innerHTML = domains.length ? domains.map(item => `
    <div class="bar-row">
      <span class="bar-label" title="${escapeHtml(item.domain)}">${escapeHtml(item.domain)}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${Math.max(6, item.count / maxDomain * 100)}%"></div></div>
      <span class="bar-val">${item.count}</span>
    </div>
  `).join("") : `<div class="empty-state">暂无运行中的流程。</div>`;

  $("#agentSnapshot").innerHTML = state.agents.slice(0, 4).map(agent => `
    <div class="agent-mini">
      <div class="agent-orb">${escapeHtml(agent.level)}</div>
      <div><strong>${escapeHtml(agent.name)}</strong><span>${escapeHtml(agent.department)} · ${escapeHtml(agent.mode)}</span></div>
      <span class="level-chip">${escapeHtml(agent.level)}</span>
    </div>
  `).join("");

  const recentAudit = state.summary?.recentAudit || [];
  $("#recentAudit").innerHTML = recentAudit.length ? recentAudit.slice(0, 6).map(event => `
    <div class="audit-mini">
      <time>${formatTime(event.created_at)}</time>
      <strong>${escapeHtml(actionLabel(event.action))}</strong>
      <span>${escapeHtml(event.actor)}</span>
    </div>
  `).join("") : `<div class="empty-state">暂无审计事件。</div>`;
}

function renderTasks() {
  const filter = state.taskFilter;
  const tasks = state.tasks.filter(task => {
    if (filter === "all") return true;
    if (filter === "completed") return task.status !== "pending";
    return task.status === "pending";
  });
  $("#taskList").innerHTML = tasks.length ? tasks.map(task => `
    <article class="task-card" style="--priority:${task.priority === "critical" ? "var(--red)" : task.priority === "high" ? "var(--orange)" : "var(--teal)"}">
      <div class="task-edge"></div>
      <div>
        <h3>${escapeHtml(task.step_name)}</h3>
        <p>${escapeHtml(task.instance_title)}</p>
        <div class="task-meta">
          <span class="meta-chip">${escapeHtml(task.workflow_name)}</span>
          <span class="meta-chip">${escapeHtml(priorityLabel(task.priority))}优先级</span>
          ${isOverdue(task) ? `<span class="meta-chip" style="color:var(--red)">已逾期</span>` : ""}
        </div>
      </div>
      <div class="task-info">
        <span>处理人：<strong>${escapeHtml(task.assignee_name || "待分配")}</strong></span>
        <span>截止：${formatTime(task.due_at)}（${relativeTime(task.due_at)}）</span>
        <span>实例：${escapeHtml(task.instance_id.slice(0, 18))}</span>
      </div>
      <div class="task-actions">
        ${task.status === "pending"
          ? `<button class="btn btn-primary btn-sm" data-handle-task="${task.id}">处理</button>`
          : `<span class="status-badge completed">${escapeHtml(task.decision || "已处理")}</span>`}
      </div>
    </article>
  `).join("") : `<div class="empty-state">没有符合条件的任务。</div>`;
}

function renderProcesses() {
  const workflowMap = Object.fromEntries(state.workflows.map(workflow => [workflow.code, workflow]));
  const pendingByInstance = Object.fromEntries(
    state.tasks.filter(task => task.status === "pending").map(task => [task.instance_id, task])
  );
  $("#instanceGrid").innerHTML = state.instances.map(instance => {
    const workflow = workflowMap[instance.workflow_code];
    const totalSteps = workflow?.steps?.length || 1;
    const currentStep = workflow?.steps?.[instance.current_step];
    const pendingTask = pendingByInstance[instance.id];
    const progress = instance.status === "completed"
      ? 100
      : Math.min(96, Math.max(8, ((instance.completed_steps + 1) / totalSteps) * 100));
    return `
      <article class="instance-card">
        <div class="instance-top">
          <div class="instance-icon">${instance.priority === "critical" ? "⚠" : instance.domain.includes("研发") ? "⚗" : instance.domain.includes("供应") ? "▤" : "⇄"}</div>
          <div class="instance-main">
            <h3>${escapeHtml(instance.title)}</h3>
            <p>${escapeHtml(instance.workflow_name)} · 发起人 ${escapeHtml(instance.created_by)}</p>
          </div>
          <span class="priority-badge ${instance.priority}">${escapeHtml(priorityLabel(instance.priority))}</span>
        </div>
        <div class="progress-row">
          <div class="progress-track"><div class="progress-fill" style="width:${progress}%"></div></div>
          <span class="progress-label">${instance.completed_steps}/${totalSteps} 节点</span>
        </div>
        <div class="instance-foot">
          <span>${pendingTask ? `当前：${escapeHtml(pendingTask.step_name)}` : currentStep ? `当前：${escapeHtml(currentStep.name)}` : "流程已结束"}</span>
          <span class="instance-foot-actions">
            <span class="status-badge ${instance.status}">${instance.status === "in_progress" ? "运行中" : instance.status === "completed" ? "已完成" : "已终止"}</span>
            <button class="text-btn" data-view-instance="${instance.id}">查看证据 →</button>
          </span>
        </div>
        <div class="instance-object-ref">对象 ${escapeHtml(instance.object?.businessKey || instance.object_id || "未关联")} · 当前状态 ${escapeHtml(instance.object?.status || "未知")}</div>
      </article>
    `;
  }).join("") || `<div class="empty-state">暂无流程实例。</div>`;

  $("#workflowGrid").innerHTML = state.workflows.map(workflow => `
    <article class="workflow-card">
      <div class="workflow-card-head">
        <div>
          <h3>${escapeHtml(workflow.name)}</h3>
          <p>${escapeHtml(workflow.description)}</p>
        </div>
        <span class="domain-badge">${escapeHtml(workflow.domain)}</span>
      </div>
      <div class="step-flow">
        ${workflow.steps.map((step, index) => `
          ${index ? `<span class="step-arrow">→</span>` : ""}
          <span class="step-chip" title="${escapeHtml(step.name)}">${index + 1}</span>
          ${step.condition ? `<span class="condition-chip" title="${escapeHtml(JSON.stringify(step.condition))}">条件</span>` : ""}
        `).join("")}
      </div>
      <div class="workflow-card-foot">
        <span class="workflow-meta">${workflow.steps.length} 个节点 · v${workflow.version} · 标准模板</span>
        <button class="btn btn-ghost btn-sm" data-start-workflow="${workflow.code}">发起</button>
      </div>
    </article>
  `).join("");
}

function renderObjects() {
  $("#objectGrid").innerHTML = state.objectDefs.map(object => {
    const records = state.objects.filter(record => record.object_code === object.code);
    return `
    <article class="object-card">
      <div class="object-head">
        <div class="object-icon">${escapeHtml(object.icon || "◇")}</div>
        <div>
          <h3>${escapeHtml(object.name)}</h3>
          <p>${escapeHtml(object.description)}</p>
        </div>
        <span class="domain-badge">${records.length} 条记录</span>
      </div>
      <div class="field-list">
        ${object.fields.map(field => `<div class="field-item"><b>${escapeHtml(field.label)}</b> · ${escapeHtml(field.type)}</div>`).join("")}
      </div>
      <div class="state-track">
        ${object.states.map((status, index) => `${index ? `<span class="step-arrow">→</span>` : ""}<span class="state-chip">${escapeHtml(status)}</span>`).join("")}
      </div>
      <div class="object-records">
        <div class="object-records-head"><span>业务对象实例</span><small>${escapeHtml(object.domain)}</small></div>
        ${records.length ? records.slice(0, 3).map(record => `
          <button class="object-record" data-view-object="${record.id}">
            <span><b>${escapeHtml(record.title)}</b><small>${escapeHtml(record.business_key)} · v${record.version}</small></span>
            <span class="status-badge record-status">${escapeHtml(record.status)}</span>
          </button>
        `).join("") : `<div class="object-empty">暂无实例，可由流程发起创建。</div>`}
      </div>
    </article>
  `;
  }).join("");
}

function renderAgents() {
  $("#agentGrid").innerHTML = state.agents.map(agent => `
    <article class="agent-card">
      <div class="agent-head">
        <div class="agent-avatar">${escapeHtml(agent.name.slice(0, 1))}</div>
        <div>
          <h3>${escapeHtml(agent.name)}</h3>
          <p>${escapeHtml(agent.department)} · 负责人 ${escapeHtml(agent.owner)}</p>
        </div>
        <span class="agent-level">${escapeHtml(agent.level)}</span>
      </div>
      <div class="scope-list">
        ${agent.scopes.map(scope => `<span class="scope-chip">${escapeHtml(scope)}</span>`).join("")}
      </div>
      <div class="agent-permission-line">
        <span>权限：${agent.permissions.map(escapeHtml).join("、")}</span>
        <span class="blocked-permission">禁止：${agent.blockedActions.map(escapeHtml).join("、")}</span>
      </div>
      <div class="agent-policy">
        <span>${escapeHtml(agent.mode)} · 最近运行 ${agent.last_run ? relativeTime(agent.last_run) : "尚未运行"}</span>
        <span class="${agent.requiresApproval ? "approval-required" : ""}">${agent.requiresApproval ? "写入需人工确认" : "只读/建议"}</span>
      </div>
      <div class="agent-foot">
        <span class="agent-run-note">累计 ${agent.run_count} 次 · ${escapeHtml(agent.recentRuns?.[0]?.status || "暂无运行")} · 本地模拟</span>
        <button class="btn btn-ghost btn-sm" data-run-agent="${agent.id}">模拟运行</button>
      </div>
    </article>
  `).join("");
}

function renderConnectors() {
  $("#connectorGrid").innerHTML = state.connectors.map(connector => `
    <article class="connector-card">
      <div class="connector-head">
        <div class="connector-logo">${escapeHtml(connector.name)}</div>
        <div>
          <h3>${escapeHtml(connector.system_type)}</h3>
          <p>${escapeHtml(connector.direction)} · provider ${escapeHtml(connector.mode)}</p>
        </div>
        <span class="mock-badge">MOCK</span>
      </div>
      <div class="capability-list">
        ${connector.capabilities.map(item => `<span class="capability-chip">${escapeHtml(item)}</span>`).join("")}
      </div>
      <div class="connector-note">${escapeHtml(connector.notes)}</div>
    </article>
  `).join("");
}

function renderAudit() {
  const entities = new Set(state.audit.map(item => `${item.entity_type}:${item.entity_id}`));
  $("#auditCount").textContent = state.audit.length;
  $("#auditEntityCount").textContent = entities.size;
  $("#auditList").innerHTML = state.audit.map(event => `
    <div class="audit-row">
      <time>${formatTime(event.created_at)}</time>
      <span class="audit-action">${escapeHtml(actionLabel(event.action))}</span>
      <span class="audit-details" title="${escapeHtml(JSON.stringify(event.details))}">
        ${escapeHtml(event.entity_type)} · ${escapeHtml(event.entity_id.slice(0, 20))} · ${escapeHtml(JSON.stringify(event.details))}
      </span>
      <span class="audit-actor">${escapeHtml(event.actor)}</span>
    </div>
  `).join("") || `<div class="empty-state">暂无审计事件。</div>`;
}

function objectFieldRows(objectCode, values) {
  const definition = state.objectDefs.find(item => item.code === objectCode);
  if (!definition) return `<div class="empty-state">对象字段定义不可用。</div>`;
  return definition.fields.map(field => `
    <div class="detail-kv">
      <span>${escapeHtml(field.label)}</span>
      <b>${escapeHtml(values?.[field.code] ?? "—")}</b>
    </div>
  `).join("");
}

async function openInstanceDetail(instanceId) {
  try {
    const detail = await api(`/api/instances/${encodeURIComponent(instanceId)}`);
    const instance = detail.instance;
    const latestTaskByStep = {};
    for (const task of detail.tasks) latestTaskByStep[task.step_index] = task;
    const skipped = new Set(detail.skippedSteps || []);
    const timeline = detail.workflow.steps.map((step, index) => {
      const task = latestTaskByStep[index];
      let state = "upcoming";
      let stateLabel = "未到达";
      if (task?.status === "pending") {
        state = "active";
        stateLabel = "待处理";
      } else if (task?.decision === "退回") {
        state = "returned";
        stateLabel = "已退回";
      } else if (task?.status === "completed") {
        state = "completed";
        stateLabel = task.decision || "已完成";
      } else if (task?.status === "rejected") {
        state = "rejected";
        stateLabel = "已终止";
      } else if (skipped.has(step.name)) {
        state = "skipped";
        stateLabel = "条件不满足·已跳过";
      }
      return `
        <div class="timeline-item ${state}">
          <div class="timeline-marker">${index + 1}</div>
          <div class="timeline-content">
            <div class="timeline-head">
              <strong>${escapeHtml(step.name)}</strong>
              <span class="timeline-state">${escapeHtml(stateLabel)}</span>
            </div>
            <div class="timeline-meta">
              <span>${escapeHtml(task?.assignee_name || "待分配")}</span>
              ${step.condition ? `<span class="condition-chip">条件节点</span>` : ""}
              ${step.objectState ? `<span>对象状态：${escapeHtml(step.objectState)}</span>` : ""}
            </div>
            ${task?.comment ? `<p class="timeline-comment">${escapeHtml(task.comment)}</p>` : ""}
            <small>${task ? `${formatTime(task.completed_at || task.created_at)} · ${task.status}` : "尚未生成任务"}</small>
          </div>
        </div>
      `;
    }).join("");
    const auditRows = detail.audit.slice(-10).reverse().map(event => `
      <div class="evidence-row">
        <time>${formatTime(event.created_at)}</time>
        <b>${escapeHtml(actionLabel(event.action))}</b>
        <span>${escapeHtml(event.actor)} · ${escapeHtml(JSON.stringify(event.details))}</span>
      </div>
    `).join("") || `<div class="object-empty">暂无审计记录。</div>`;
    const agentRows = detail.agentRuns.length ? detail.agentRuns.map(run => `
      <div class="evidence-row">
        <time>${formatTime(run.created_at)}</time>
        <b>${escapeHtml(run.agent_name)} · ${escapeHtml(run.agent_level)}</b>
        <span>${escapeHtml(run.status)}${run.confirmed_by ? ` · 确认人 ${escapeHtml(run.confirmed_by)}` : ""}</span>
      </div>
    `).join("") : `<div class="object-empty">暂无数字员工运行。</div>`;
    openModal(`
      <span class="eyebrow">PROCESS EVIDENCE</span>
      <h2 id="modalTitle">${escapeHtml(instance.title)}</h2>
      <p class="modal-sub">${escapeHtml(instance.workflow_name)} · ${escapeHtml(instance.id)}</p>
      <div class="record-meta-grid">
        <div><span>流程状态</span><b>${instance.status === "in_progress" ? "运行中" : instance.status === "completed" ? "已完成" : "已终止"}</b></div>
        <div><span>业务对象</span><b>${escapeHtml(instance.object?.businessKey || "未关联")}</b></div>
        <div><span>对象状态</span><b>${escapeHtml(instance.object?.status || "未知")}</b></div>
        <div><span>对象版本</span><b>v${Number(instance.object?.version || 0)}</b></div>
      </div>
      <div class="detail-section">
        <div class="detail-section-title"><b>业务对象字段</b><button class="text-btn" data-view-object="${instance.object_id}">查看对象详情 →</button></div>
        <div class="detail-kv-grid">${objectFieldRows(instance.object_code, detail.fields)}</div>
      </div>
      <div class="detail-section">
        <div class="detail-section-title"><b>步骤时间线</b><span>${detail.tasks.length} 条任务记录</span></div>
        <div class="workflow-timeline">${timeline}</div>
      </div>
      <div class="detail-section">
        <div class="detail-section-title"><b>最近审计证据</b><span>只读 · 本地 SQLite</span></div>
        <div class="evidence-list">${auditRows}</div>
      </div>
      <div class="detail-section">
        <div class="detail-section-title"><b>数字员工辅助记录</b><span>模拟运行 · 人工确认</span></div>
        <div class="evidence-list">${agentRows}</div>
      </div>
      <div class="modal-actions">
        ${detail.pendingTask ? `<button class="btn btn-primary" data-handle-task="${detail.pendingTask.id}">处理当前待办</button>` : ""}
        <button class="btn btn-ghost" id="closeInstanceDetail">关闭</button>
      </div>
    `, { wide: true });
    $("#closeInstanceDetail")?.addEventListener("click", closeModal);
  } catch (error) {
    toast(`加载流程详情失败：${error.message}`, "error");
  }
}

async function openObjectDetail(objectId) {
  try {
    const detail = await api(`/api/objects/${encodeURIComponent(objectId)}`);
    const object = detail.object;
    const instances = detail.instances.map(instance => `
      <button class="linked-instance" data-view-instance="${instance.id}">
        <span><b>${escapeHtml(instance.title)}</b><small>${escapeHtml(instance.workflow_name)} · ${formatTime(instance.updated_at)}</small></span>
        <span class="status-badge ${instance.status}">${instance.status === "in_progress" ? "运行中" : instance.status === "completed" ? "已完成" : "已终止"}</span>
      </button>
    `).join("") || `<div class="object-empty">该对象暂无关联流程。</div>`;
    const auditRows = detail.audit.slice(-12).reverse().map(event => `
      <div class="evidence-row">
        <time>${formatTime(event.created_at)}</time>
        <b>${escapeHtml(actionLabel(event.action))}</b>
        <span>${escapeHtml(event.actor)} · ${escapeHtml(event.entity_type)}</span>
      </div>
    `).join("") || `<div class="object-empty">暂无对象审计。</div>`;
    openModal(`
      <span class="eyebrow">BUSINESS OBJECT</span>
      <h2 id="modalTitle">${escapeHtml(object.title)}</h2>
      <p class="modal-sub">${escapeHtml(detail.definition?.name || object.object_code)} · ${escapeHtml(object.business_key)}</p>
      <div class="record-meta-grid">
        <div><span>当前状态</span><b>${escapeHtml(object.status)}</b></div>
        <div><span>数据来源</span><b>${escapeHtml(object.source_system)}</b></div>
        <div><span>版本</span><b>v${object.version}</b></div>
        <div><span>关联流程</span><b>${object.instanceCount}</b></div>
      </div>
      ${object.source_system.includes("MOCK") ? `<div class="modal-callout" style="border-left-color:var(--orange);margin-top:12px">该对象来源于明确标识的模拟系统事件，不代表真实 DCS 集成。</div>` : ""}
      <div class="detail-section">
        <div class="detail-section-title"><b>对象字段</b><span>由对象定义统一约束</span></div>
        <div class="detail-kv-grid">${objectFieldRows(object.object_code, object.fields)}</div>
      </div>
      <div class="detail-section">
        <div class="detail-section-title"><b>关联流程实例</b><span>流程引用对象，不复制对象</span></div>
        <div class="linked-instance-list">${instances}</div>
      </div>
      <div class="detail-section">
        <div class="detail-section-title"><b>对象审计</b><span>状态与版本变更可追溯</span></div>
        <div class="evidence-list">${auditRows}</div>
      </div>
      <div class="modal-actions"><button class="btn btn-ghost" id="closeObjectDetail">关闭</button></div>
    `, { wide: true });
    $("#closeObjectDetail")?.addEventListener("click", closeModal);
  } catch (error) {
    toast(`加载对象详情失败：${error.message}`, "error");
  }
}

function openLaunchModal(preselectCode = "") {
  const options = state.workflows.map(workflow => `
    <option value="${workflow.code}" ${workflow.code === preselectCode ? "selected" : ""}>${escapeHtml(workflow.name)} · ${escapeHtml(workflow.domain)}</option>
  `).join("");
  openModal(`
    <span class="eyebrow">NEW PROCESS INSTANCE</span>
    <h2 id="modalTitle">发起新流程</h2>
    <p class="modal-sub">选择一个标准流程模板。对象字段由元数据自动生成，不由每个部门新写后端。</p>
    <form id="launchForm">
      <div class="form-grid">
        <div class="form-field full">
          <label for="workflowCode">流程模板</label>
          <select id="workflowCode" name="workflowCode">${options}</select>
        </div>
        <div class="form-field full">
          <label for="instanceTitle">流程标题</label>
          <input id="instanceTitle" name="title" required placeholder="例如：C客户耐候型样品开发">
        </div>
        <div class="form-field">
          <label for="priority">优先级</label>
          <select id="priority" name="priority">
            <option value="normal">普通</option>
            <option value="high">高优</option>
            <option value="critical">紧急</option>
          </select>
        </div>
        <div class="form-field">
          <label for="initiator">发起人</label>
          <input id="initiator" name="initiator" value="系统管理员">
        </div>
        <div class="form-field full">
          <label>业务对象字段</label>
          <div class="form-grid" id="dynamicFields"></div>
        </div>
      </div>
      <div class="modal-callout" style="margin-top:14px">
        流程会在本地 SQLite 中创建实例，自动生成第一个待办节点并写入审计；不会调用真实外部系统。
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="cancelLaunch">取消</button>
        <button type="submit" class="btn btn-primary">创建并进入第一个节点</button>
      </div>
    </form>
  `);
  renderDynamicFields();
  $("#workflowCode").addEventListener("change", renderDynamicFields);
  $("#cancelLaunch").addEventListener("click", closeModal);
  $("#launchForm").addEventListener("submit", submitLaunch);
}

function renderDynamicFields() {
  const workflowCode = $("#workflowCode")?.value;
  const workflow = state.workflows.find(item => item.code === workflowCode);
  const object = state.objectDefs.find(item => item.code === workflow?.object_code);
  const container = $("#dynamicFields");
  if (!container) return;
  if (!object) {
    container.innerHTML = `<div class="empty-state">当前流程没有关联对象字段。</div>`;
    return;
  }
  container.innerHTML = object.fields.map(field => {
    const required = field.required ? "required" : "";
    const id = `field-${field.code}`;
    if (field.type === "textarea") {
      return `<div class="form-field full"><label for="${id}">${escapeHtml(field.label)}${field.required ? " *" : ""}</label><textarea id="${id}" data-payload="${field.code}" ${required}></textarea></div>`;
    }
    if (field.type === "select") {
      const options = field.options?.length ? field.options : ["选项A", "选项B", "选项C"];
      return `<div class="form-field"><label for="${id}">${escapeHtml(field.label)}${field.required ? " *" : ""}</label><select id="${id}" data-payload="${field.code}" ${required}>${options.map(item => `<option>${escapeHtml(item)}</option>`).join("")}</select></div>`;
    }
    const type = field.type === "number" ? "number" : field.type === "date" ? "date" : "text";
    return `<div class="form-field"><label for="${id}">${escapeHtml(field.label)}${field.required ? " *" : ""}</label><input id="${id}" type="${type}" data-payload="${field.code}" ${required}></div>`;
  }).join("");
}

async function submitLaunch(event) {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  const payload = {};
  $$("[data-payload]", formElement).forEach(input => {
    const key = input.dataset.payload;
    const value = input.value;
    payload[key] = input.type === "number" ? Number(value) : value;
  });
  const body = {
    workflowCode: form.get("workflowCode"),
    title: form.get("title"),
    initiator: form.get("initiator"),
    priority: form.get("priority"),
    idempotencyKey: formElement.dataset.idempotencyKey || crypto.randomUUID(),
    payload
  };
  formElement.dataset.idempotencyKey = body.idempotencyKey;
  const submitButton = formElement.querySelector('button[type="submit"]');
  try {
    submitButton.disabled = true;
    await api("/api/instances", { method: "POST", body: JSON.stringify(body) });
    closeModal();
    toast("流程已创建，并生成第一个待办。", "success");
    await loadAll();
    setView("processes");
  } catch (error) {
    toast(`发起失败：${error.message}`, "error");
    submitButton.disabled = false;
  }
}

function openTaskModal(taskId) {
  const task = state.tasks.find(item => item.id === taskId);
  if (!task) return;
  openModal(`
    <span class="eyebrow">TASK ACTION</span>
    <h2 id="modalTitle">${escapeHtml(task.step_name)}</h2>
    <p class="modal-sub">${escapeHtml(task.instance_title)} · ${escapeHtml(task.workflow_name)}</p>
    <div class="detail-list">
      <div class="detail-line"><span>当前处理人</span><b>${escapeHtml(task.assignee_name || "待分配")}</b></div>
      <div class="detail-line"><span>任务截止</span><b>${formatTime(task.due_at)} · ${relativeTime(task.due_at)}</b></div>
      <div class="detail-line"><span>优先级</span><b>${escapeHtml(priorityLabel(task.priority))}</b></div>
      <div class="detail-line"><span>流程实例</span><b>${escapeHtml(task.instance_id)}</b></div>
      <div class="detail-line"><span>业务对象状态</span><b>${escapeHtml(task.object_status || "未知")}</b></div>
    </div>
    <div class="form-field">
      <label for="taskComment">处理意见</label>
      <textarea id="taskComment" placeholder="填写审批依据、退回原因或完成说明"></textarea>
    </div>
    <div class="modal-callout" style="margin-top:12px">
      通过/完成会推进到下一节点；退回会回到上一节点；终止会结束整个流程。所有动作都会写入审计。
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" data-view-instance="${task.instance_id}">查看流程证据</button>
      <button class="btn btn-ghost" data-task-action="return" data-task-id="${task.id}" ${task.step_index === 0 ? "disabled title=\"首节点没有上一节点\"" : ""}>退回上一节点</button>
      <button class="btn btn-danger" data-task-action="reject" data-task-id="${task.id}">终止流程</button>
      <button class="btn btn-success" data-task-action="approve" data-task-id="${task.id}">通过 / 完成</button>
    </div>
  `);
}

async function handleTaskAction(taskId, action) {
  const comment = $("#taskComment")?.value || "";
  try {
    await api(`/api/tasks/${encodeURIComponent(taskId)}/action`, {
      method: "POST",
      body: JSON.stringify({ action, comment, actor: "系统管理员" })
    });
    closeModal();
    toast(action === "return" ? "任务已退回上一节点。" : action === "reject" ? "流程已终止。" : "任务已处理并推进流程。", "success");
    await loadAll();
  } catch (error) {
    toast(`处理失败：${error.message}`, "error");
  }
}

async function runAgent(agentId) {
  try {
    const result = await api(`/api/agents/${encodeURIComponent(agentId)}/run`, {
      method: "POST",
      body: JSON.stringify({})
    });
    openModal(`
      <span class="eyebrow">SIMULATED AGENT RUN</span>
      <h2 id="modalTitle">${escapeHtml(result.agent.name)} · 运行结果</h2>
      <p class="modal-sub">${escapeHtml(result.result.summary)}</p>
      <div class="detail-list">
        <div class="detail-line"><span>执行等级</span><b>${escapeHtml(result.agent.level)} · ${escapeHtml(result.agent.mode)}</b></div>
        <div class="detail-line"><span>关联对象</span><b>${escapeHtml(result.instance?.title || "最近一个流程实例")}</b></div>
        <div class="detail-line"><span>人工确认</span><b>${result.requiresApproval ? "需要" : "不需要"}</b></div>
        <div class="detail-line"><span>运行状态</span><b>${escapeHtml(result.runStatus === "pending_confirmation" ? "等待人工确认" : "已完成")}</b></div>
      </div>
      <div class="result-findings">
        ${result.result.findings.map(item => `<div>• ${escapeHtml(item)}</div>`).join("")}
      </div>
      <div class="agent-permission-line modal-permissions">
        <span>允许：${result.agent.permissions.map(escapeHtml).join("、")}</span>
        <span class="blocked-permission">禁止：${result.agent.blockedActions.map(escapeHtml).join("、")}</span>
      </div>
      <div class="modal-callout"><b>建议：</b>${escapeHtml(result.result.recommendation)}<br>${escapeHtml(result.result.mode)}</div>
      <div class="modal-callout" style="margin-top:9px;border-left-color:var(--orange)">${escapeHtml(result.disclaimer)}</div>
      <div class="modal-actions">
        ${result.requiresApproval ? `<button class="btn btn-primary" data-confirm-agent-run="${result.id}">人工确认运行结果</button>` : ""}
        <button class="btn btn-ghost" id="closeAgentResult">关闭</button>
      </div>
    `);
    $("#closeAgentResult").addEventListener("click", closeModal);
    await loadAll();
  } catch (error) {
    toast(`模拟运行失败：${error.message}`, "error");
  }
}

async function confirmAgentRun(runId) {
  try {
    const result = await api(`/api/agent-runs/${encodeURIComponent(runId)}/confirm`, {
      method: "POST",
      body: JSON.stringify({ actor: "系统管理员", comment: "演示人工确认：仅确认模拟分析结果，不产生外部副作用" })
    });
    closeModal();
    toast(`已由 ${result.confirmedBy} 人工确认，业务副作用：无。`, "success");
    await loadAll();
  } catch (error) {
    toast(`人工确认失败：${error.message}`, "error");
  }
}

document.addEventListener("click", event => {
  const viewButton = event.target.closest("[data-view]");
  if (viewButton) {
    setView(viewButton.dataset.view);
    return;
  }
  const goButton = event.target.closest("[data-go]");
  if (goButton) {
    setView(goButton.dataset.go);
    return;
  }
  const viewLink = event.target.closest("[data-view-link]");
  if (viewLink) {
    event.preventDefault();
    setView(viewLink.dataset.viewLink);
    return;
  }
  const instanceDetail = event.target.closest("[data-view-instance]");
  if (instanceDetail) {
    openInstanceDetail(instanceDetail.dataset.viewInstance);
    return;
  }
  const objectDetail = event.target.closest("[data-view-object]");
  if (objectDetail) {
    openObjectDetail(objectDetail.dataset.viewObject);
    return;
  }
  const confirmRun = event.target.closest("[data-confirm-agent-run]");
  if (confirmRun) {
    confirmAgentRun(confirmRun.dataset.confirmAgentRun);
    return;
  }
  const launch = event.target.closest("[data-launch-process]");
  if (launch) {
    openLaunchModal();
    return;
  }
  const startWorkflow = event.target.closest("[data-start-workflow]");
  if (startWorkflow) {
    openLaunchModal(startWorkflow.dataset.startWorkflow);
    return;
  }
  const handleTask = event.target.closest("[data-handle-task]");
  if (handleTask) {
    openTaskModal(handleTask.dataset.handleTask);
    return;
  }
  const taskAction = event.target.closest("[data-task-action]");
  if (taskAction) {
    handleTaskAction(taskAction.dataset.taskId, taskAction.dataset.taskAction);
    return;
  }
  const agentRun = event.target.closest("[data-run-agent]");
  if (agentRun) {
    runAgent(agentRun.dataset.runAgent);
  }
});

$("#taskFilters").addEventListener("click", event => {
  const button = event.target.closest("[data-task-filter]");
  if (!button) return;
  state.taskFilter = button.dataset.taskFilter;
  $$("#taskFilters button").forEach(item => item.classList.toggle("active", item === button));
  renderTasks();
});

$("#sidebarToggle").addEventListener("click", () => document.body.classList.toggle("side-collapsed"));
$("#scrim").addEventListener("click", () => document.body.classList.add("side-collapsed"));
$("#modalClose").addEventListener("click", closeModal);
$("#modalBackdrop").addEventListener("click", event => {
  if (event.target === $("#modalBackdrop")) closeModal();
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && !$("#modalBackdrop").hidden) closeModal();
});

$("#refreshDashboard").addEventListener("click", () => loadAll());
$("#refreshTasks").addEventListener("click", () => loadAll());
$("#refreshAudit").addEventListener("click", () => loadAll());

$("#btnResetDemo").addEventListener("click", async () => {
  if (!confirm("确认重置全部演示数据？当前本地操作记录会被清除。")) return;
  try {
    await api("/api/reset-demo", { method: "POST", body: "{}" });
    toast("演示数据已重置。", "success");
    await loadAll();
    setView("dashboard");
  } catch (error) {
    toast(`重置失败：${error.message}`, "error");
  }
});

if (window.innerWidth <= 940) document.body.classList.add("side-collapsed");
loadAll(true);
