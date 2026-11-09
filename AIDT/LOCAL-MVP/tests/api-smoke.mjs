import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const base = "http://127.0.0.1:4173";
const artifactDir = join(process.cwd(), "docs", "test-artifacts");

function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
}

async function request(path, options = {}) {
  const response = await fetch(base + path, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    method: options.method || "GET",
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const data = await response.json();
  return { status: response.status, data };
}

async function expectStatus(path, status, options = {}) {
  const result = await request(path, options);
  assert(result.status === status, `${path} 期望 HTTP ${status}，实际 ${result.status}: ${JSON.stringify(result.data)}`);
  return result.data;
}

async function createInstance(body, idempotencyKey = `api-${crypto.randomUUID()}`) {
  const result = await request("/api/instances", {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body
  });
  assert([200, 201].includes(result.status), `发起流程失败：${JSON.stringify(result.data)}`);
  return result;
}

async function pendingTasks(instanceId) {
  const tasks = await expectStatus("/api/tasks", 200);
  return tasks.filter(task => task.instance_id === instanceId && task.status === "pending");
}

async function act(taskId, action = "approve", comment = "自动化闭环测试", actor = "自动测试") {
  return expectStatus(`/api/tasks/${encodeURIComponent(taskId)}/action`, 200, {
    method: "POST",
    body: { action, comment, actor }
  });
}

async function advanceUntilEnd(instanceId, max = 12) {
  const seen = [];
  for (let i = 0; i < max; i++) {
    const [task] = await pendingTasks(instanceId);
    if (!task) return seen;
    seen.push(task.step_name);
    await act(task.id, task.step_name.includes("审批") ? "approve" : "complete");
  }
  throw new Error("流程推进超过最大节点数");
}

await expectStatus("/api/reset-demo", 200, { method: "POST", body: {} });
const baseline = await expectStatus("/api/summary", 200);

const validationMissing = await expectStatus("/api/instances", 422, {
  method: "POST",
  body: {
    workflowCode: "SAMPLE_TO_TRIAL",
    title: "缺字段测试",
    initiator: "自动测试",
    priority: "normal",
    payload: { customer: "虚构客户" }
  }
});
assert(validationMissing.code === "REQUIRED_FIELD", "缺必填字段应返回 REQUIRED_FIELD");

const validationUnknown = await expectStatus("/api/instances", 422, {
  method: "POST",
  body: {
    workflowCode: "PURCHASE_TO_PAY",
    title: "未知字段测试",
    initiator: "自动测试",
    priority: "normal",
    payload: {
      material: "虚构测试物料",
      quantity: 1,
      amount: 100,
      requiredDate: "2026-11-10",
      secretFormula: "不应被接受"
    }
  }
});
assert(validationUnknown.code === "UNKNOWN_FIELDS", "未定义字段必须拒绝");

const validationNumber = await expectStatus("/api/instances", 422, {
  method: "POST",
  body: {
    workflowCode: "PURCHASE_TO_PAY",
    title: "错误类型测试",
    initiator: "自动测试",
    priority: "normal",
    payload: {
      material: "虚构测试物料",
      quantity: 1,
      amount: "68000",
      requiredDate: "2026-11-10"
    }
  }
});
assert(validationNumber.code === "INVALID_FIELD_TYPE", "数值字段必须执行服务端类型校验");

const validationDate = await expectStatus("/api/instances", 422, {
  method: "POST",
  body: {
    workflowCode: "PURCHASE_TO_PAY",
    title: "非法日期测试",
    initiator: "自动测试",
    priority: "normal",
    payload: {
      material: "虚构测试物料",
      quantity: 1,
      amount: 100,
      requiredDate: "2026-02-31"
    }
  }
});
assert(validationDate.code === "INVALID_FIELD_TYPE", "非法日历日期必须拒绝");

const sampleBody = {
  workflowCode: "SAMPLE_TO_TRIAL",
  title: "API测试 · 虚构样品到转产",
  initiator: "自动测试",
  priority: "high",
  payload: {
    customer: "虚构测试客户",
    productRequirement: "虚构耐候测试要求",
    quantity: 3,
    targetDate: "2026-11-10",
    confidentiality: "机密"
  }
};
const sampleKey = `api-sample-${crypto.randomUUID()}`;
const sampleFirst = await createInstance(sampleBody, sampleKey);
assert(sampleFirst.status === 201 && sampleFirst.data.idempotent_replay === false, "首次发起应返回 201");
const sampleReplay = await createInstance(sampleBody, sampleKey);
assert(sampleReplay.status === 200 && sampleReplay.data.idempotent_replay === true, "同键同内容应幂等重放");
assert(sampleReplay.data.instance.id === sampleFirst.data.instance.id, "幂等重放必须返回同一实例");

const idempotencyConflict = await request("/api/instances", {
  method: "POST",
  headers: { "Idempotency-Key": sampleKey },
  body: { ...sampleBody, title: "同键不同内容" }
});
assert(idempotencyConflict.status === 409 && idempotencyConflict.data.code === "IDEMPOTENCY_CONFLICT", "同键不同内容必须返回冲突");

const sampleId = sampleFirst.data.instance.id;
const sampleObjectId = sampleFirst.data.instance.object_id;
const sampleStartDetail = await expectStatus(`/api/instances/${encodeURIComponent(sampleId)}`, 200);
assert(sampleStartDetail.object.id === sampleObjectId, "流程实例必须通过 object_id 引用独立对象");
assert(sampleStartDetail.fields.customer === "虚构测试客户", "对象字段应从对象记录读取");
assert(sampleStartDetail.pendingTask?.step_name === "销售登记样品需求", "发起后必须自动生成首个待办");
assert(sampleStartDetail.audit.some(event => event.action === "object.created"), "对象创建必须写审计");

const sampleSteps = await advanceUntilEnd(sampleId);
assert(sampleSteps.length === 6, "样品链路应处理 6 个节点");
const sampleFinalDetail = await expectStatus(`/api/instances/${encodeURIComponent(sampleId)}`, 200);
assert(sampleFinalDetail.instance.status === "completed", "样品链路应走到 completed");
assert(sampleFinalDetail.object.status === "已转产", "样品对象应随流程更新为已转产");
assert(sampleFinalDetail.tasks.length === 6, "样品链路应有 6 条任务证据");
assert(sampleFinalDetail.object.version >= 7, "对象版本应随状态变更增长");
assert(sampleFinalDetail.audit.some(event => event.action === "instance.completed"), "完成审计必须存在");
const sampleObjectDetail = await expectStatus(`/api/objects/${encodeURIComponent(sampleObjectId)}`, 200);
assert(sampleObjectDetail.instances.some(instance => instance.id === sampleId), "对象详情必须能反查关联流程");

const complaintCreated = (await createInstance({
  workflowCode: "COMPLAINT_TO_CAPA",
  title: "API测试 · 客诉退回后终止",
  initiator: "自动测试",
  priority: "normal",
  payload: {
    customer: "虚构测试客户",
    batch: "TEST-BATCH-001",
    complaint: "虚构粘度波动",
    severity: "一般",
    responseDue: "2026-11-12"
  }
})).data.instance;
const [complaintFirstTask] = await pendingTasks(complaintCreated.id);
await act(complaintFirstTask.id, "approve", "首节点已完成");
const [complaintSecondTask] = await pendingTasks(complaintCreated.id);
const returned = await act(complaintSecondTask.id, "return", "测试退回：补齐批次追溯证据", "质量测试员");
assert(returned.instance.status === "in_progress", "退回后流程必须仍在运行");
assert(returned.pendingTask?.step_name === "客诉受理与分级", "退回必须生成上一节点新待办");
const [complaintReturnedTask] = await pendingTasks(complaintCreated.id);
const rejected = await act(complaintReturnedTask.id, "reject", "测试终止：业务决定不再继续", "部门负责人");
assert(rejected.instance.status === "rejected", "终止后流程必须为 rejected");
assert(rejected.object.status === "已终止", "终止后对象状态必须同步");
assert(rejected.audit.some(event => event.action === "instance.returned"), "退回审计必须存在");
assert(rejected.audit.some(event => event.action === "instance.rejected"), "终止审计必须存在");

const lowPurchase = (await createInstance({
  workflowCode: "PURCHASE_TO_PAY",
  title: "API测试 · 低金额条件跳过",
  initiator: "自动测试",
  priority: "normal",
  payload: {
    material: "虚构常用物料",
    quantity: 10,
    amount: 1200,
    supplier: "虚构测试供应商",
    requiredDate: "2026-11-10"
  }
})).data.instance;
const lowSteps = await advanceUntilEnd(lowPurchase.id);
assert(!lowSteps.includes("重大采购总经理审批"), "低金额采购不得进入重大审批");
const lowDetail = await expectStatus(`/api/instances/${encodeURIComponent(lowPurchase.id)}`, 200);
assert(lowDetail.instance.status === "completed", "低金额采购应完成");
assert(lowDetail.skippedSteps.includes("重大采购总经理审批"), "跳过节点必须写入完成审计");

const highPurchase = (await createInstance({
  workflowCode: "PURCHASE_TO_PAY",
  title: "API测试 · 高金额条件进入",
  initiator: "自动测试",
  priority: "critical",
  payload: {
    material: "虚构中试物料",
    quantity: 100,
    amount: 68000,
    supplier: "虚构测试供应商",
    requiredDate: "2026-11-11"
  }
})).data.instance;
const highSteps = await advanceUntilEnd(highPurchase.id);
assert(highSteps.includes("重大采购总经理审批"), "高金额采购必须进入重大审批");
const highDetail = await expectStatus(`/api/instances/${encodeURIComponent(highPurchase.id)}`, 200);
assert(highDetail.instance.status === "completed", "高金额采购应完成");
assert(highDetail.object.status === "已完成", "采购对象应随流程完成");

const concurrentPurchase = (await createInstance({
  workflowCode: "PURCHASE_TO_PAY",
  title: "API测试 · 并发推进保护",
  initiator: "自动测试",
  priority: "normal",
  payload: {
    material: "虚构并发测试物料",
    quantity: 2,
    amount: 200,
    requiredDate: "2026-11-13"
  }
})).data.instance;
const [concurrentTask] = await pendingTasks(concurrentPurchase.id);
const concurrentResults = await Promise.all([
  request(`/api/tasks/${encodeURIComponent(concurrentTask.id)}/action`, {
    method: "POST",
    body: { action: "approve", actor: "并发测试A", comment: "并发请求A" }
  }),
  request(`/api/tasks/${encodeURIComponent(concurrentTask.id)}/action`, {
    method: "POST",
    body: { action: "approve", actor: "并发测试B", comment: "并发请求B" }
  })
]);
assert(concurrentResults.filter(result => result.status === 200).length === 1, "并发处理同一任务只能成功一次");
assert(concurrentResults.filter(result => result.status === 409).length === 1, "并发失败请求必须返回 409");
assert((await pendingTasks(concurrentPurchase.id)).length === 1, "并发保护后只能保留一个新待办");

const batch = (await createInstance({
  workflowCode: "BATCH_DEVIATION",
  title: "API测试 · 模拟DCS报警",
  initiator: "模拟DCS事件",
  priority: "critical",
  payload: {
    batch: "TEST-BATCH-002",
    severity: "重大",
    description: "虚构温度越限报警",
    disposition: "",
    capa: ""
  }
})).data.instance;
const agentRun = await expectStatus("/api/agents/agent-batch/run", 200, {
  method: "POST",
  body: { instanceId: batch.id }
});
assert(agentRun.runStatus === "pending_confirmation", "A2数字员工输出必须等待人工确认");
assert(agentRun.requiresApproval === true, "A2运行必须标记人工确认");
assert(agentRun.agent.permissions.length > 0 && agentRun.agent.blockedActions.includes("控制DCS/PLC"), "数字员工必须有允许与禁止权限");
const confirmed = await expectStatus(`/api/agent-runs/${encodeURIComponent(agentRun.id)}/confirm`, 200, {
  method: "POST",
  body: { actor: "赵质量", comment: "确认仅采用分析建议，不执行DCS控制" }
});
assert(confirmed.status === "confirmed" && confirmed.confirmedBy === "赵质量", "人工确认必须记录确认人与状态");
const doubleConfirm = await request(`/api/agent-runs/${encodeURIComponent(agentRun.id)}/confirm`, {
  method: "POST",
  body: { actor: "赵质量", comment: "重复确认" }
});
assert(doubleConfirm.status === 409, "重复人工确认必须拒绝");
const crossScope = await request("/api/agents/agent-batch/run", {
  method: "POST",
  body: { instanceId: highPurchase.id }
});
assert(crossScope.status === 403 && crossScope.data.code === "AGENT_SCOPE_DENIED", "数字员工必须拒绝跨流程范围访问");
const agentRuns = await expectStatus(`/api/agent-runs?instanceId=${encodeURIComponent(batch.id)}`, 200);
assert(agentRuns.some(run => run.id === agentRun.id && run.status === "confirmed"), "运行记录应可追溯");

const finalSummary = await expectStatus("/api/summary", 200);
const audit = await expectStatus("/api/audit", 200);
assert(finalSummary.counts.auditEvents > baseline.counts.auditEvents, "审计事件必须真实增长");
assert(audit.some(event => event.action === "agent.confirmed"), "人工确认必须写审计");
assert(audit.some(event => event.action === "object.status_changed"), "对象状态变化必须写审计");

const report = {
  generatedAt: new Date().toISOString(),
  status: "PASS",
  baseline: baseline.counts,
  final: finalSummary.counts,
  validations: {
    missingRequired: validationMissing.code,
    unknownFields: validationUnknown.code,
    invalidNumberType: validationNumber.code,
    invalidCalendarDate: validationDate.code
  },
  objectFirst: {
    instanceId: sampleId,
    objectId: sampleObjectId,
    objectStatus: sampleFinalDetail.object.status,
    objectVersion: sampleFinalDetail.object.version,
    fieldSource: "business_objects.fields_json",
    linkedInstances: sampleObjectDetail.instances.map(item => item.id)
  },
  idempotency: {
    firstStatus: sampleFirst.status,
    replayStatus: sampleReplay.status,
    sameInstance: sampleReplay.data.instance.id === sampleFirst.data.instance.id,
    conflictStatus: idempotencyConflict.status
  },
  completedChains: [
    { name: "客户样品到研发转产", instanceId: sampleId, steps: sampleSteps },
    { name: "低金额采购到付款", instanceId: lowPurchase.id, steps: lowSteps },
    { name: "高金额采购到付款", instanceId: highPurchase.id, steps: highSteps }
  ],
  conditions: {
    lowAmountTriggered: lowSteps.includes("重大采购总经理审批"),
    lowAmountSkipped: lowDetail.skippedSteps,
    highAmountTriggered: highSteps.includes("重大采购总经理审批")
  },
  returnAndReject: {
    instanceId: complaintCreated.id,
    returnTarget: returned.pendingTask.step_name,
    finalInstanceStatus: rejected.instance.status,
    finalObjectStatus: rejected.object.status,
    auditActions: rejected.audit.map(event => event.action)
  },
  concurrency: concurrentResults.map(result => ({
    status: result.status,
    code: result.data.code || null
  })),
  agent: {
    runId: agentRun.id,
    level: agentRun.agent.level,
    requiresApproval: agentRun.requiresApproval,
    runStatus: agentRun.runStatus,
    confirmedBy: confirmed.confirmedBy,
    blockedActions: agentRun.agent.blockedActions,
    crossScopeStatus: crossScope.status,
    disclaimer: agentRun.disclaimer
  },
  auditGrowth: {
    before: baseline.counts.auditEvents,
    after: finalSummary.counts.auditEvents
  }
};

mkdirSync(artifactDir, { recursive: true });
writeFileSync(join(artifactDir, "api-smoke-result.json"), JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify(report, null, 2));

await expectStatus("/api/reset-demo", 200, { method: "POST", body: {} });
