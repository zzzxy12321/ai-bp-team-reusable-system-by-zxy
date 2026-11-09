import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const edgePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const port = 9531;
const profile = mkdtempSync(join(tmpdir(), "aidt-local-browser-"));
const artifactDir = join(process.cwd(), "docs", "test-artifacts");
mkdirSync(artifactDir, { recursive: true });

function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
}

await fetch("http://127.0.0.1:4173/api/reset-demo", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{}"
});

const browser = spawn(edgePath, [
  "--headless=new",
  "--disable-gpu",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  "http://127.0.0.1:4173/"
], { stdio: "ignore" });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let page;
for (let i = 0; i < 40; i++) {
  try {
    const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json());
    page = pages.find(item => item.type === "page");
    if (page) break;
  } catch {}
  await sleep(150);
}
if (!page) {
  browser.kill();
  throw new Error("无法连接浏览器调试端口");
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});

let nextId = 1;
const pending = new Map();
const exceptions = [];
const consoleErrors = [];
ws.addEventListener("message", event => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  }
  if (message.method === "Runtime.exceptionThrown") {
    exceptions.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
  }
  if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
    consoleErrors.push(message.params.args.map(argument => argument.value || argument.description).join(" "));
  }
});

function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result.value;
}

async function waitFor(expression, timeout = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await evaluate(expression)) return true;
    await sleep(100);
  }
  throw new Error(`等待条件超时：${expression}`);
}

async function screenshot(name) {
  const result = await send("Page.captureScreenshot", { format: "png", fromSurface: true });
  writeFileSync(join(artifactDir, name), Buffer.from(result.data, "base64"));
}

await send("Runtime.enable");
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: 1440,
  height: 1000,
  deviceScaleFactor: 1,
  mobile: false
});
await send("Page.reload", { ignoreCache: true });
await waitFor("document.readyState === 'complete'");
await waitFor("document.querySelector('#loadingScreen')?.classList.contains('hidden')", 10000);
await sleep(300);

const report = {};
report.loading = await evaluate(`({
  hidden: document.querySelector('#loadingScreen')?.classList.contains('hidden'),
  text: document.querySelector('#loadingScreen')?.innerText,
  banner: document.querySelector('.global-banner')?.innerText
})`);
report.layout = await evaluate(`(() => {
  const main = document.querySelector('.main');
  return {
    innerWidth,
    docScrollWidth: document.documentElement.scrollWidth,
    mainClientWidth: main.clientWidth,
    mainScrollWidth: main.scrollWidth,
    activeView: document.querySelector('.view.active')?.dataset.viewPanel,
    kpis: document.querySelectorAll('.kpi-card').length,
    taskCards: document.querySelectorAll('.task-card').length,
    objectDefinitions: state.objectDefs.length,
    objectRecords: state.objects.length
  };
})()`);
assert(report.loading.hidden, "加载层应隐藏");
assert(report.layout.docScrollWidth <= report.layout.innerWidth, "桌面不得横向溢出");
assert(report.layout.kpis === 6, "驾驶舱应显示 6 个 KPI");
assert(report.layout.objectDefinitions === 6 && report.layout.objectRecords >= 4, "对象定义和独立对象记录都应加载");
await screenshot("browser-desktop-dashboard.png");

report.navigation = await evaluate(`(async () => {
  const results = [];
  for (const item of [...document.querySelectorAll('.nav-item')]) {
    item.click();
    await new Promise(resolve => setTimeout(resolve, 25));
    results.push({
      expected: item.dataset.view,
      actual: document.querySelector('.view.active')?.dataset.viewPanel
    });
  }
  return { total: results.length, failures: results.filter(item => item.expected !== item.actual) };
})()`);
assert(report.navigation.total === 7 && report.navigation.failures.length === 0, "7 个导航页必须全部可切换");

report.taskModal = await evaluate(`(async () => {
  document.querySelector('.nav-item[data-view="workbench"]').click();
  await new Promise(resolve => setTimeout(resolve, 50));
  const trigger = document.querySelector('[data-handle-task]');
  trigger?.click();
  await new Promise(resolve => setTimeout(resolve, 80));
  const buttonTexts = [...document.querySelectorAll('[data-task-action]')].map(button => button.textContent.trim());
  const stateValue = {
    triggerFound: Boolean(trigger),
    open: !document.querySelector('#modalBackdrop').hidden,
    actionButtons: buttonTexts,
    hasEvidenceLink: Boolean(document.querySelector('[data-view-instance]')),
    objectStatusShown: (document.querySelector('#modalContent')?.innerText || '').includes('业务对象状态')
  };
  document.querySelector('#modalClose')?.click();
  return stateValue;
})()`);
assert(report.taskModal.open && report.taskModal.actionButtons.length === 3, "任务弹窗必须提供通过、退回、终止");
assert(report.taskModal.hasEvidenceLink && report.taskModal.objectStatusShown, "任务弹窗应衔接对象状态和流程证据");

report.launchModal = await evaluate(`(async () => {
  document.querySelector('[data-launch-process]').click();
  await new Promise(resolve => setTimeout(resolve, 50));
  const result = {
    open: !document.querySelector('#modalBackdrop').hidden,
    workflowOptions: document.querySelectorAll('#workflowCode option').length,
    dynamicFields: document.querySelectorAll('#dynamicFields [data-payload]').length
  };
  document.querySelector('#modalClose')?.click();
  return result;
})()`);
assert(report.launchModal.open && report.launchModal.workflowOptions === 4 && report.launchModal.dynamicFields >= 5, "发起弹窗必须动态生成对象字段");

report.objectDetail = await evaluate(`(async () => {
  document.querySelector('.nav-item[data-view="objects"]').click();
  await new Promise(resolve => setTimeout(resolve, 50));
  const batchObjectCard = [...document.querySelectorAll('.object-card')]
    .find(card => card.innerText.includes('质量偏差'));
  const trigger = batchObjectCard?.querySelector('[data-view-object]');
  trigger?.click();
  await new Promise(resolve => setTimeout(resolve, 180));
  const text = document.querySelector('#modalContent')?.innerText || '';
  const result = {
    triggerFound: Boolean(trigger),
    open: !document.querySelector('#modalBackdrop').hidden,
    hasFields: text.includes('对象字段'),
    hasLinkedInstances: text.includes('关联流程实例'),
    hasAudit: text.includes('对象审计'),
    mockBoundaryShown: text.includes('模拟系统事件')
  };
  return result;
})()`);
assert(report.objectDetail.open && report.objectDetail.hasFields && report.objectDetail.hasLinkedInstances && report.objectDetail.hasAudit, "对象详情必须展示字段、关联流程和审计");
assert(report.objectDetail.mockBoundaryShown, "模拟DCS来源必须在对象详情明确标识");
await screenshot("browser-object-detail.png");
await evaluate(`document.querySelector('#modalClose')?.click()`);

report.instanceDetail = await evaluate(`(async () => {
  document.querySelector('.nav-item[data-view="processes"]').click();
  await new Promise(resolve => setTimeout(resolve, 50));
  const trigger = document.querySelector('[data-view-instance]');
  trigger?.click();
  await new Promise(resolve => setTimeout(resolve, 180));
  const text = document.querySelector('#modalContent')?.innerText || '';
  const result = {
    triggerFound: Boolean(trigger),
    open: !document.querySelector('#modalBackdrop').hidden,
    timelineItems: document.querySelectorAll('.timeline-item').length,
    hasObjectFields: text.includes('业务对象字段'),
    hasAudit: text.includes('最近审计证据'),
    hasAgentEvidence: text.includes('数字员工辅助记录')
  };
  return result;
})()`);
assert(report.instanceDetail.open && report.instanceDetail.timelineItems >= 6, "流程详情必须展示完整步骤时间线");
assert(report.instanceDetail.hasObjectFields && report.instanceDetail.hasAudit && report.instanceDetail.hasAgentEvidence, "流程详情必须包含对象、审计和数字员工证据");
await screenshot("browser-process-evidence.png");
await evaluate(`document.querySelector('#modalClose')?.click()`);

report.taskAdvance = await evaluate(`(async () => {
  document.querySelector('.nav-item[data-view="workbench"]').click();
  await new Promise(resolve => setTimeout(resolve, 60));
  const trigger = document.querySelector('[data-handle-task]');
  const task = state.tasks.find(item => item.id === trigger?.dataset.handleTask);
  const instanceId = task?.instance_id;
  const auditBefore = (await fetch('/api/audit').then(response => response.json())).length;
  trigger.click();
  await new Promise(resolve => setTimeout(resolve, 60));
  document.querySelector('#taskComment').value = '浏览器自动化：通过并推进';
  document.querySelector('[data-task-action="approve"]').click();
  await new Promise(resolve => setTimeout(resolve, 500));
  const detail = await fetch('/api/instances/' + encodeURIComponent(instanceId)).then(response => response.json());
  const auditAfter = (await fetch('/api/audit').then(response => response.json())).length;
  return {
    taskId: task?.id,
    instanceId,
    taskActionRecorded: detail.tasks.some(item => item.id === task.id && item.status === 'completed'),
    taskCount: detail.tasks.length,
    pendingTaskCount: detail.tasks.filter(item => item.status === 'pending').length,
    auditGrowth: auditAfter - auditBefore,
    currentStepAdvanced: detail.instance.current_step > task.step_index
  };
})()`);
assert(report.taskAdvance.taskActionRecorded && report.taskAdvance.taskCount >= 2, "浏览器任务处理必须留下任务记录并生成下一任务");
assert(report.taskAdvance.pendingTaskCount === 1 && report.taskAdvance.currentStepAdvanced, "任务处理必须推进实例并保持一个待办");
assert(report.taskAdvance.auditGrowth >= 2, "任务处理后审计必须增长");

report.agentRun = await evaluate(`(async () => {
  document.querySelector('.nav-item[data-view="agents"]').click();
  await new Promise(resolve => setTimeout(resolve, 60));
  document.querySelector('[data-run-agent="agent-batch"]').click();
  await new Promise(resolve => setTimeout(resolve, 220));
  const beforeConfirm = {
    open: !document.querySelector('#modalBackdrop').hidden,
    hasResult: (document.querySelector('#modalContent')?.innerText || '').includes('运行结果'),
    hasPermissions: (document.querySelector('#modalContent')?.innerText || '').includes('控制DCS/PLC'),
    hasConfirmButton: Boolean(document.querySelector('[data-confirm-agent-run]'))
  };
  document.querySelector('[data-confirm-agent-run]')?.click();
  await new Promise(resolve => setTimeout(resolve, 420));
  const runs = await fetch('/api/agent-runs?instanceId=' + encodeURIComponent('inst-batch-001')).then(response => response.json());
  const latest = runs[0];
  return {
    ...beforeConfirm,
    modalClosedAfterConfirm: document.querySelector('#modalBackdrop').hidden,
    runStatus: latest?.status,
    confirmedBy: latest?.confirmed_by,
    hasConfirmationAudit: (await fetch('/api/audit').then(response => response.json()))
      .some(event => event.action === 'agent.confirmed')
  };
})()`);
assert(report.agentRun.hasResult && report.agentRun.hasPermissions && report.agentRun.hasConfirmButton, "数字员工结果必须显示权限边界和人工确认");
assert(report.agentRun.runStatus === "confirmed" && report.agentRun.confirmedBy, "人工确认必须更新运行记录");
assert(report.agentRun.hasConfirmationAudit, "人工确认必须写入审计");
await screenshot("browser-agent-confirmation.png");

await send("Emulation.setDeviceMetricsOverride", {
  width: 390,
  height: 844,
  deviceScaleFactor: 1,
  mobile: true
});
await send("Page.reload", { ignoreCache: true });
await waitFor("document.readyState === 'complete'");
await waitFor("document.querySelector('#loadingScreen')?.classList.contains('hidden')", 10000);
await sleep(300);
report.mobile = await evaluate(`(async () => {
  const main = document.querySelector('.main');
  const initial = {
    innerWidth,
    docScrollWidth: document.documentElement.scrollWidth,
    mainClientWidth: main.clientWidth,
    mainScrollWidth: main.scrollWidth,
    sidebarCollapsed: document.body.classList.contains('side-collapsed'),
    kpiColumns: getComputedStyle(document.querySelector('.kpi-grid')).gridTemplateColumns
  };
  document.querySelector('#sidebarToggle').click();
  await new Promise(resolve => setTimeout(resolve, 80));
  const open = {
    sidebarCollapsed: document.body.classList.contains('side-collapsed'),
    scrimVisible: getComputedStyle(document.querySelector('#scrim')).display !== 'none'
  };
  document.querySelector('#scrim').click();
  await new Promise(resolve => setTimeout(resolve, 80));
  const closed = document.body.classList.contains('side-collapsed');
  document.querySelector('.nav-item[data-view="workbench"]').click();
  await new Promise(resolve => setTimeout(resolve, 80));
  document.querySelector('[data-handle-task]')?.click();
  await new Promise(resolve => setTimeout(resolve, 100));
  const modalWidth = document.querySelector('#modal')?.getBoundingClientRect().width || 0;
  const finalWidth = document.documentElement.scrollWidth;
  document.querySelector('#modalClose')?.click();
  return { initial, open, closed, modalWidth, finalWidth };
})()`);
assert(report.mobile.initial.innerWidth === 390 && report.mobile.initial.docScrollWidth <= 390, "390px 移动端不得横向溢出");
assert(report.mobile.initial.sidebarCollapsed, "移动端首次加载侧栏应默认收起");
assert(!report.mobile.open.sidebarCollapsed && report.mobile.open.scrimVisible, "移动菜单必须可打开并显示遮罩");
assert(report.mobile.closed, "移动菜单必须可关闭");
assert(report.mobile.modalWidth > 0 && report.mobile.modalWidth <= 390, "移动任务弹窗必须适配视口");
assert(report.mobile.finalWidth <= 390, "移动端任务弹窗关闭后不得横向溢出");
await screenshot("browser-mobile-390.png");

report.exceptions = exceptions;
report.consoleErrors = consoleErrors;
assert(exceptions.length === 0, `浏览器必须无未捕获异常：${exceptions.join(" | ")}`);
assert(consoleErrors.length === 0, `浏览器必须无 console.error：${consoleErrors.join(" | ")}`);
report.status = "PASS";
report.generatedAt = new Date().toISOString();

writeFileSync(join(artifactDir, "browser-smoke-result.json"), JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify(report, null, 2));

ws.close();
browser.kill();
await sleep(200);
await fetch("http://127.0.0.1:4173/api/reset-demo", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{}"
});
rmSync(profile, { recursive: true, force: true });
