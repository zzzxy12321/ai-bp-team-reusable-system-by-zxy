import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const dataDir = path.join(__dirname, "data");
const dbPath = path.join(dataDir, "aidt.db");
const host = process.env.AIDT_HOST || "127.0.0.1";
const port = Number(process.env.AIDT_PORT || 4173);

fs.mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");

function now() {
  return new Date().toISOString();
}

function addHours(hours) {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

function json(value) {
  return JSON.stringify(value == null ? null : value);
}

function parseJson(value, fallback = null) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      department TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS object_defs (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      domain TEXT NOT NULL,
      description TEXT,
      icon TEXT,
      fields_json TEXT NOT NULL,
      states_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      domain TEXT NOT NULL,
      object_code TEXT NOT NULL,
      description TEXT,
      steps_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'published',
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS business_objects (
      id TEXT PRIMARY KEY,
      object_code TEXT NOT NULL,
      business_key TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      source_system TEXT NOT NULL DEFAULT 'AIDT',
      source_ref TEXT,
      fields_json TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(object_code, business_key)
    );

    CREATE TABLE IF NOT EXISTS workflow_instances (
      id TEXT PRIMARY KEY,
      workflow_code TEXT NOT NULL,
      object_code TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      current_step INTEGER NOT NULL DEFAULT 0,
      payload_json TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'normal',
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      object_id TEXT,
      idempotency_key TEXT,
      request_hash TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (workflow_code) REFERENCES workflows(code)
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      step_index INTEGER NOT NULL,
      step_name TEXT NOT NULL,
      assignee_role TEXT NOT NULL,
      assignee_name TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      due_at TEXT,
      decision TEXT,
      comment TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      FOREIGN KEY (instance_id) REFERENCES workflow_instances(id)
    );

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      owner TEXT NOT NULL,
      department TEXT NOT NULL,
      level TEXT NOT NULL,
      mode TEXT NOT NULL,
      scopes_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      requires_approval INTEGER NOT NULL DEFAULT 1,
      last_run TEXT,
      run_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      instance_id TEXT,
      action TEXT NOT NULL,
      result_json TEXT NOT NULL,
      status TEXT NOT NULL,
      requires_approval INTEGER NOT NULL DEFAULT 0,
      confirmed_by TEXT,
      confirmed_at TEXT,
      confirmation_comment TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (agent_id) REFERENCES agents(id)
    );

    CREATE TABLE IF NOT EXISTS connectors (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      system_type TEXT NOT NULL,
      direction TEXT NOT NULL,
      status TEXT NOT NULL,
      mode TEXT NOT NULL,
      endpoint TEXT,
      capabilities_json TEXT NOT NULL,
      last_check TEXT NOT NULL,
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      action TEXT NOT NULL,
      actor TEXT NOT NULL,
      details_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_instances_status ON workflow_instances(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_events(entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS idx_business_objects_status ON business_objects(status);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_instance ON agent_runs(instance_id);
  `);

  // CREATE TABLE IF NOT EXISTS does not add columns to an existing prototype database.
  ensureColumn("workflow_instances", "object_id", "TEXT");
  ensureColumn("workflow_instances", "idempotency_key", "TEXT");
  ensureColumn("workflow_instances", "request_hash", "TEXT");
  ensureColumn("workflow_instances", "version", "INTEGER NOT NULL DEFAULT 1");
  ensureColumn("agents", "allowed_workflows_json", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn("agents", "permissions_json", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn("agents", "blocked_actions_json", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn("agent_runs", "confirmed_by", "TEXT");
  ensureColumn("agent_runs", "confirmed_at", "TEXT");
  ensureColumn("agent_runs", "confirmation_comment", "TEXT");
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_instances_object ON workflow_instances(object_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_instances_idempotency
      ON workflow_instances(idempotency_key) WHERE idempotency_key IS NOT NULL;
  `);
}

function tableColumns(table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
}

function ensureColumn(table, column, definition) {
  if (!tableColumns(table).has(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function seedDatabase(force = false) {
  const existing = db.prepare("SELECT COUNT(*) AS count FROM workflows").get().count;
  if (existing > 0 && !force) return false;

  db.exec("BEGIN");
  try {
    if (force) {
      db.exec(`
        DELETE FROM audit_events;
        DELETE FROM agent_runs;
        DELETE FROM agents;
        DELETE FROM connectors;
        DELETE FROM tasks;
        DELETE FROM workflow_instances;
        DELETE FROM business_objects;
        DELETE FROM workflows;
        DELETE FROM object_defs;
        DELETE FROM users;
      `);
    }

    const createdAt = now();
    const insertUser = db.prepare("INSERT INTO users(id,name,role,department) VALUES(?,?,?,?)");
    [
      ["u-admin", "系统管理员", "platform_admin", "平台团队"],
      ["u-ceo", "总经理", "general_manager", "管理层"],
      ["u-sales", "张销售", "sales", "客户中心"],
      ["u-rd", "李研发", "rd_manager", "研发中心"],
      ["u-lab", "王实验", "lab_engineer", "实验室"],
      ["u-prod", "陈生产", "production_manager", "生产部"],
      ["u-quality", "赵质量", "quality_manager", "品质部"],
      ["u-proc", "刘采购", "procurement", "供应链"],
      ["u-fin", "孙财务", "finance_manager", "财务部"],
      ["u-delivery", "周交付", "delivery_manager", "交付中心"]
    ].forEach(row => insertUser.run(...row));

    const selectOptions = {
      confidentiality: ["公开", "内部", "机密"],
      severity: ["一般", "重大", "特别重大"]
    };
    const objects = [
      {
        code: "CUSTOMER_SAMPLE",
        name: "客户样品需求",
        domain: "研发与实验室",
        icon: "🧪",
        description: "客户样品指标、数量和交期进入研发实验链路。",
        fields: [
          ["customer", "客户", "lookup", true],
          ["productRequirement", "目标产品/技术要求", "textarea", true],
          ["quantity", "样品数量", "number", true],
          ["targetDate", "期望日期", "date", true],
          ["confidentiality", "保密等级", "select", true]
        ],
        states: ["草稿", "研发评审", "实验中", "待测试", "待试产", "已转产", "已退回"]
      },
      {
        code: "LAB_EXPERIMENT",
        name: "研发实验",
        domain: "研发与实验室",
        icon: "⚗️",
        description: "实验目的、配方版本、原料、条件和测试结果。",
        fields: [
          ["project", "研发项目", "lookup", true],
          ["formulaVersion", "配方版本", "text", true],
          ["materials", "原料批次", "textarea", true],
          ["condition", "工艺条件", "textarea", false],
          ["result", "实验结果", "textarea", false]
        ],
        states: ["计划", "执行中", "待复核", "通过", "不通过", "关闭"]
      },
      {
        code: "PRODUCTION_BATCH",
        name: "生产批次",
        domain: "生产与质量",
        icon: "🏭",
        description: "工单、配方、原料、设备和检验的统一批次对象。",
        fields: [
          ["workOrder", "工单号", "text", true],
          ["product", "产品", "lookup", true],
          ["formulaVersion", "配方版本", "text", true],
          ["equipment", "设备", "lookup", true],
          ["batchNo", "批次号", "text", true]
        ],
        states: ["待生产", "生产中", "待检", "待放行", "已放行", "异常"]
      },
      {
        code: "QUALITY_DEVIATION",
        name: "质量偏差",
        domain: "生产与质量",
        icon: "⚠️",
        description: "批次异常、调查、处置、CAPA 和关闭证据。",
        fields: [
          ["batch", "批次", "lookup", true],
          ["severity", "风险等级", "select", true],
          ["description", "问题描述", "textarea", true],
          ["disposition", "处置意见", "textarea", false],
          ["capa", "CAPA措施", "textarea", false]
        ],
        states: ["待确认", "调查中", "待处置", "CAPA中", "待验证", "已关闭"]
      },
      {
        code: "PURCHASE_REQUEST",
        name: "采购申请",
        domain: "供应链与财务",
        icon: "🧾",
        description: "请购、预算、采购、到货、发票和付款主链路。",
        fields: [
          ["material", "物料", "lookup", true],
          ["quantity", "数量", "number", true],
          ["amount", "预算金额", "number", true],
          ["supplier", "建议供应商", "lookup", false],
          ["requiredDate", "需求日期", "date", true]
        ],
        states: ["待预算", "采购中", "待到货", "待检验", "付款中", "已完成", "已退回"]
      },
      {
        code: "CUSTOMER_COMPLAINT",
        name: "客户客诉",
        domain: "客户与交付",
        icon: "📣",
        description: "客户问题、批次追溯、调查、客户方案、CAPA 和回访。",
        fields: [
          ["customer", "客户", "lookup", true],
          ["batch", "涉及批次", "lookup", true],
          ["complaint", "客诉描述", "textarea", true],
          ["severity", "影响等级", "select", true],
          ["responseDue", "回复期限", "date", true]
        ],
        states: ["已受理", "追溯中", "调查中", "待回复", "CAPA中", "已关闭"]
      }
    ];
    objects.forEach(obj => {
      if (!obj.states.includes("已终止")) obj.states.push("已终止");
    });
    const insertObject = db.prepare(`
      INSERT INTO object_defs(id,code,name,domain,description,icon,fields_json,states_json,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)
    `);
    objects.forEach(obj => {
      insertObject.run(
        `obj-${obj.code.toLowerCase()}`,
        obj.code,
        obj.name,
        obj.domain,
        obj.description,
        obj.icon,
        json(obj.fields.map(([code, label, type, required]) => ({
          code,
          label,
          type,
          required,
          ...(selectOptions[code] ? { options: selectOptions[code] } : {})
        }))),
        json(obj.states),
        createdAt
      );
    });

    const workflows = [
      {
        code: "SAMPLE_TO_TRIAL",
        name: "客户样品到研发转产",
        domain: "研发与实验室",
        objectCode: "CUSTOMER_SAMPLE",
        description: "销售需求、研发评审、实验执行、测试判定、试产评审与转产发布。",
        completionStatus: "已转产",
        steps: [
          { name: "销售登记样品需求", role: "sales", hours: 8, objectState: "草稿" },
          { name: "研发立项评审", role: "rd_manager", hours: 24, objectState: "研发评审" },
          { name: "实验执行与结果登记", role: "lab_engineer", hours: 72, objectState: "实验中" },
          { name: "质量测试判定", role: "quality_manager", hours: 24, objectState: "待测试" },
          { name: "试产联合评审", role: "production_manager", hours: 24, objectState: "待试产" },
          { name: "研发总监批准转产", role: "rd_manager", hours: 24, objectState: "待试产" }
        ]
      },
      {
        code: "BATCH_DEVIATION",
        name: "批次异常到CAPA闭环",
        domain: "生产与质量",
        objectCode: "QUALITY_DEVIATION",
        description: "DCS报警关联批次，现场确认、会审、处置审批、CAPA与验证。",
        completionStatus: "已关闭",
        steps: [
          { name: "系统关联批次并生成异常", role: "platform_admin", hours: 1, objectState: "待确认" },
          { name: "班组长现场确认", role: "production_manager", hours: 2, objectState: "待确认" },
          { name: "工艺与质量联合评审", role: "quality_manager", hours: 8, objectState: "调查中" },
          { name: "处置方案审批", role: "production_manager", hours: 8, objectState: "待处置" },
          { name: "CAPA执行与效果验证", role: "quality_manager", hours: 72, objectState: "CAPA中" },
          { name: "重大异常总经理审批", role: "general_manager", hours: 4, objectState: "待验证", condition: { field: "severity", operator: "in", value: ["重大", "特别重大"] } }
        ]
      },
      {
        code: "PURCHASE_TO_PAY",
        name: "采购到付款",
        domain: "供应链与财务",
        objectCode: "PURCHASE_REQUEST",
        description: "请购、预算、采购、到货检验、三单匹配与付款审批。",
        completionStatus: "已完成",
        steps: [
          { name: "需求部门提交请购", role: "procurement", hours: 8, objectState: "待预算" },
          { name: "财务预算审核", role: "finance_manager", hours: 24, objectState: "待预算" },
          { name: "采购询价与下单", role: "procurement", hours: 48, objectState: "采购中" },
          { name: "到货与检验确认", role: "quality_manager", hours: 24, objectState: "待到货" },
          { name: "订单验收发票三单匹配", role: "finance_manager", hours: 24, objectState: "待检验" },
          { name: "付款审批", role: "finance_manager", hours: 24, objectState: "付款中" },
          { name: "重大采购总经理审批", role: "general_manager", hours: 8, objectState: "付款中", condition: { field: "amount", operator: "gte", value: 50000 } }
        ]
      },
      {
        code: "COMPLAINT_TO_CAPA",
        name: "客诉到CAPA",
        domain: "客户与交付",
        objectCode: "CUSTOMER_COMPLAINT",
        description: "客诉受理、批次追溯、联合调查、客户方案、CAPA和回访关闭。",
        completionStatus: "已关闭",
        steps: [
          { name: "客诉受理与分级", role: "sales", hours: 4, objectState: "已受理" },
          { name: "批次与同批去向追溯", role: "quality_manager", hours: 8, objectState: "追溯中" },
          { name: "研发质量联合调查", role: "rd_manager", hours: 24, objectState: "调查中" },
          { name: "客户处置方案确认", role: "delivery_manager", hours: 8, objectState: "待回复" },
          { name: "CAPA与体系更新", role: "quality_manager", hours: 72, objectState: "CAPA中" },
          { name: "客户回访与关闭", role: "sales", hours: 24, objectState: "CAPA中" }
        ]
      }
    ];
    const insertWorkflow = db.prepare(`
      INSERT INTO workflows(id,code,name,domain,object_code,description,steps_json,status,version,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)
    `);
    workflows.forEach(wf => {
      insertWorkflow.run(
        `wf-${wf.code.toLowerCase()}`,
        wf.code,
        wf.name,
        wf.domain,
        wf.objectCode,
        wf.description,
        json({ steps: wf.steps, completionStatus: wf.completionStatus }),
        "published",
        1,
        createdAt
      );
    });

    const instances = [
      {
        id: "inst-rd-001",
        workflowCode: "SAMPLE_TO_TRIAL",
        objectCode: "CUSTOMER_SAMPLE",
        title: "A客户耐候型苯丙样品开发",
        status: "in_progress",
        currentStep: 0,
        priority: "high",
        createdBy: "张销售",
        payload: { customer: "A客户", confidentiality: "机密", quantity: 5, targetDate: "2026-11-05" }
      },
      {
        id: "inst-batch-001",
        workflowCode: "BATCH_DEVIATION",
        objectCode: "QUALITY_DEVIATION",
        title: "B240817批次温度越限异常",
        status: "in_progress",
        currentStep: 0,
        priority: "critical",
        createdBy: "DCS事件",
        payload: { batch: "B240817", severity: "重大", description: "聚合温度连续12分钟高于控制上限" }
      },
      {
        id: "inst-p2p-001",
        workflowCode: "PURCHASE_TO_PAY",
        objectCode: "PURCHASE_REQUEST",
        title: "研发中试原料紧急采购",
        status: "in_progress",
        currentStep: 0,
        priority: "high",
        createdBy: "刘采购",
        payload: { material: "功能单体FM-21", quantity: 500, amount: 68000, requiredDate: "2026-11-01" }
      },
      {
        id: "inst-complaint-001",
        workflowCode: "COMPLAINT_TO_CAPA",
        objectCode: "CUSTOMER_COMPLAINT",
        title: "客户反馈成品粘度波动",
        status: "in_progress",
        currentStep: 0,
        priority: "normal",
        createdBy: "张销售",
        payload: { customer: "C客户", batch: "B240806", severity: "一般", complaint: "成品放置7天后粘度偏高" }
      }
    ];
    const insertBusinessObject = db.prepare(`
      INSERT INTO business_objects(
        id,object_code,business_key,title,status,version,source_system,source_ref,fields_json,created_by,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    const insertInstance = db.prepare(`
      INSERT INTO workflow_instances(
        id,workflow_code,object_code,title,status,current_step,payload_json,priority,created_by,created_at,updated_at,
        object_id,idempotency_key,request_hash,version
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    const insertTask = db.prepare(`
      INSERT INTO tasks(
        id,instance_id,step_index,step_name,assignee_role,assignee_name,status,due_at,decision,comment,created_at,completed_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    const stepLookup = Object.fromEntries(workflows.map(wf => [wf.code, wf.steps]));
    instances.forEach((inst, index) => {
      const step = stepLookup[inst.workflowCode][inst.currentStep];
      const objectId = `obj-record-${inst.id}`;
      const objectDef = objects.find(item => item.code === inst.objectCode);
      const sourceSystem = inst.workflowCode === "BATCH_DEVIATION" ? "DCS-MOCK" : "AIDT";
      const businessKey = inst.payload.batch || inst.payload.workOrder || `DEMO-${String(index + 1).padStart(3, "0")}`;
      const objectCreatedAt = new Date(Date.now() - (index + 1) * 3600 * 1000).toISOString();
      insertBusinessObject.run(
        objectId,
        inst.objectCode,
        businessKey,
        inst.title,
        step.objectState || objectDef.states[0],
        1,
        sourceSystem,
        sourceSystem === "DCS-MOCK" ? `mock-alarm-${index + 1}` : null,
        json(inst.payload),
        inst.createdBy,
        objectCreatedAt,
        new Date(Date.now() - index * 900 * 1000).toISOString()
      );
      insertInstance.run(
        inst.id,
        inst.workflowCode,
        inst.objectCode,
        inst.title,
        inst.status,
        inst.currentStep,
        "{}",
        inst.priority,
        inst.createdBy,
        objectCreatedAt,
        new Date(Date.now() - index * 900 * 1000).toISOString(),
        objectId,
        null,
        null,
        1
      );
      const roleMap = {
        sales: "张销售",
        rd_manager: "李研发",
        lab_engineer: "王实验",
        production_manager: "陈生产",
        quality_manager: "赵质量",
        procurement: "刘采购",
        finance_manager: "孙财务",
        delivery_manager: "周交付",
        general_manager: "总经理",
        platform_admin: "系统管理员"
      };
      insertTask.run(
        `task-${inst.id}`,
        inst.id,
        inst.currentStep,
        step.name,
        step.role,
        roleMap[step.role] || "待分配",
        "pending",
        index === 1 ? new Date(Date.now() - 45 * 60 * 1000).toISOString() : addHours(step.hours),
        null,
        null,
        now(),
        null
      );
    });

    const agents = [
      {
        id: "agent-rd",
        name: "研发资料助理",
        owner: "李研发",
        department: "研发中心",
        level: "A0",
        mode: "建议",
        scopes: ["研发项目：本项目", "实验记录：只读", "知识库：研发公开库"],
        approval: 0,
        allowedWorkflows: ["SAMPLE_TO_TRIAL"],
        permissions: ["读取本项目", "生成建议", "生成草稿"],
        blockedActions: ["修改已批准配方", "跨项目读取", "调用外部模型"]
      },
      {
        id: "agent-batch",
        name: "批次异常分析员",
        owner: "赵质量",
        department: "品质部",
        level: "A2",
        mode: "执行后通知",
        scopes: ["批次：质量关联范围", "DCS报警：只读", "质量异常：创建任务"],
        approval: 1,
        allowedWorkflows: ["BATCH_DEVIATION"],
        permissions: ["读取批次", "读取DCS报警摘要", "生成分析结论", "创建人工任务"],
        blockedActions: ["控制DCS/PLC", "质量放行", "关闭偏差"]
      },
      {
        id: "agent-p2p",
        name: "采购对账员",
        owner: "孙财务",
        department: "财务部",
        level: "A2",
        mode: "执行后通知",
        scopes: ["采购订单：只读", "验收单：只读", "发票：比对", "付款：禁止执行"],
        approval: 1,
        allowedWorkflows: ["PURCHASE_TO_PAY"],
        permissions: ["读取采购单", "读取验收单", "比对发票", "生成差异清单"],
        blockedActions: ["执行付款", "修改U9凭证", "绕过预算审批"]
      },
      {
        id: "agent-delivery",
        name: "交付资料助理",
        owner: "周交付",
        department: "交付中心",
        level: "A1",
        mode: "生成草稿",
        scopes: ["发货单：只读", "CoA/SDS：只读", "客户回复：生成草稿"],
        approval: 1,
        allowedWorkflows: ["COMPLAINT_TO_CAPA"],
        permissions: ["读取交付资料", "生成随货资料清单", "生成客户回复草稿"],
        blockedActions: ["对外发送", "承诺赔付", "修改质量结论"]
      }
    ];
    const insertAgent = db.prepare(`
      INSERT INTO agents(
        id,name,owner,department,level,mode,scopes_json,status,requires_approval,last_run,run_count,
        allowed_workflows_json,permissions_json,blocked_actions_json
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    agents.forEach(a => insertAgent.run(
      a.id, a.name, a.owner, a.department, a.level, a.mode, json(a.scopes),
      "active", a.approval, null, 0, json(a.allowedWorkflows), json(a.permissions), json(a.blockedActions)
    ));

    const connectors = [
      ["conn-u9", "U9", "财务与库存", "读写（模拟）", "mock", "v1", ["客户", "物料", "库存", "成本", "付款申请"], "尚未配置真实认证与地址"],
      ["conn-erp", "ERP", "订单与生产", "读写（模拟）", "mock", "v1", ["订单", "工单", "采购", "库存", "发货"], "尚未获得真实接口文档"],
      ["conn-dcs", "DCS", "实时过程控制", "只读（模拟）", "mock", "v1", ["报警", "关键参数", "设备状态", "批次摘要"], "禁止通过AIDT下发控制命令"],
      ["conn-dingtalk", "钉钉", "身份与协同", "双向（模拟）", "mock", "v1", ["组织", "单点登录", "待办", "消息"], "正式接入需企业应用授权"]
    ];
    const insertConnector = db.prepare(`
      INSERT INTO connectors(id,code,name,system_type,direction,status,mode,endpoint,capabilities_json,last_check,notes)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)
    `);
    connectors.forEach(([id, code, name, direction, mode, endpoint, capabilities, notes]) => {
      insertConnector.run(id, code, code, direction, "mock", mode, endpoint, json(capabilities), now(), notes);
    });

    const audit = db.prepare(`
      INSERT INTO audit_events(id,entity_type,entity_id,action,actor,details_json,created_at)
      VALUES(?,?,?,?,?,?,?)
    `);
    instances.forEach((inst, index) => {
      const createdAt = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
      const businessKey = inst.payload.batch || inst.payload.workOrder || `DEMO-${String(index + 1).padStart(3, "0")}`;
      audit.run(
        randomUUID(),
        "business_object",
        `obj-record-${inst.id}`,
        "object.created",
        inst.createdBy,
        json({ objectCode: inst.objectCode, businessKey }),
        createdAt
      );
      audit.run(
        randomUUID(),
        "workflow_instance",
        inst.id,
        "instance.created",
        inst.createdBy,
        json({ title: inst.title, workflow: inst.workflowCode, objectId: `obj-record-${inst.id}` }),
        createdAt
      );
    });

    db.exec("COMMIT");
    return true;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrateLegacyObjects() {
  const legacy = db.prepare(`
    SELECT * FROM workflow_instances WHERE object_id IS NULL OR object_id = ''
  `).all();
  if (!legacy.length) return 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    const insertObject = db.prepare(`
      INSERT INTO business_objects(
        id,object_code,business_key,title,status,version,source_system,source_ref,fields_json,created_by,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    let migrated = 0;
    for (const instance of legacy) {
      const objectId = `obj-record-${instance.id}`;
      const existing = db.prepare("SELECT id FROM business_objects WHERE id = ?").get(objectId);
      if (!existing) {
        const workflow = getWorkflow(instance.workflow_code);
        const definition = getObjectDefinition(instance.object_code);
        const step = workflow?.steps?.[instance.current_step];
        const fields = parseJson(instance.payload_json, {});
        insertObject.run(
          objectId,
          instance.object_code,
          `LEGACY-${instance.id}`,
          instance.title,
          step?.objectState || definition?.states?.[0] || "新建",
          1,
          "AIDT-LEGACY-MIGRATION",
          instance.id,
          json(fields),
          instance.created_by,
          instance.created_at,
          instance.updated_at
        );
        audit("business_object", objectId, "object.migrated", "系统管理员", {
          instanceId: instance.id,
          objectCode: instance.object_code
        });
      }
      db.prepare("UPDATE workflow_instances SET object_id = ?, payload_json = '{}' WHERE id = ?")
        .run(objectId, instance.id);
      migrated += 1;
    }
    db.exec("COMMIT");
    return migrated;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}

function audit(entityType, entityId, action, actor, details = {}) {
  db.prepare(`
    INSERT INTO audit_events(id,entity_type,entity_id,action,actor,details_json,created_at)
    VALUES(?,?,?,?,?,?,?)
  `).run(randomUUID(), entityType, entityId, action, actor || "演示用户", json(details), now());
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

class HttpError extends Error {
  constructor(status, message, code = "REQUEST_FAILED", details = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function sendError(res, status, message, details = null, code = "REQUEST_FAILED") {
  sendJson(res, status, { error: message, code, details });
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new HttpError(413, "请求体超过 1MB 限制", "PAYLOAD_TOO_LARGE");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(400, "请求体不是合法 JSON", "INVALID_JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "请求体必须是 JSON 对象", "INVALID_BODY");
  }
  return body;
}

function getObjectDefinition(code) {
  const row = db.prepare("SELECT * FROM object_defs WHERE code = ?").get(code);
  if (!row) return null;
  return {
    ...row,
    fields: parseJson(row.fields_json, []),
    states: parseJson(row.states_json, [])
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function requestHash(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function validatePayload(workflow, rawPayload) {
  const definition = getObjectDefinition(workflow.object_code);
  if (!definition) {
    throw new HttpError(500, "流程关联的业务对象定义不存在", "OBJECT_DEFINITION_MISSING");
  }
  if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) {
    throw new HttpError(422, "业务对象字段 payload 必须是对象", "INVALID_PAYLOAD");
  }
  const fieldMap = new Map(definition.fields.map(field => [field.code, field]));
  const unknown = Object.keys(rawPayload).filter(key => !fieldMap.has(key));
  if (unknown.length) {
    throw new HttpError(422, `存在未定义字段：${unknown.join("、")}`, "UNKNOWN_FIELDS", { fields: unknown });
  }

  const clean = {};
  for (const field of definition.fields) {
    let value = rawPayload[field.code];
    const missing = value === undefined || value === null || (typeof value === "string" && !value.trim());
    if (missing) {
      if (field.required) {
        throw new HttpError(422, `“${field.label}”为必填字段`, "REQUIRED_FIELD", { field: field.code });
      }
      continue;
    }
    if (["text", "textarea", "lookup"].includes(field.type)) {
      if (typeof value !== "string") {
        throw new HttpError(422, `“${field.label}”必须是文本`, "INVALID_FIELD_TYPE", { field: field.code });
      }
      value = value.trim();
      if (value.length > 5000) {
        throw new HttpError(422, `“${field.label}”长度不能超过 5000 字`, "FIELD_TOO_LONG", { field: field.code });
      }
    } else if (field.type === "number") {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new HttpError(422, `“${field.label}”必须是有效数字`, "INVALID_FIELD_TYPE", { field: field.code });
      }
    } else if (field.type === "date") {
      const parsedDate = typeof value === "string" ? new Date(`${value}T00:00:00Z`) : null;
      if (
        typeof value !== "string"
        || !/^\d{4}-\d{2}-\d{2}$/.test(value)
        || Number.isNaN(parsedDate.getTime())
        || parsedDate.toISOString().slice(0, 10) !== value
      ) {
        throw new HttpError(422, `“${field.label}”必须是 YYYY-MM-DD 日期`, "INVALID_FIELD_TYPE", { field: field.code });
      }
    } else if (field.type === "select") {
      if (typeof value !== "string" || (field.options?.length && !field.options.includes(value))) {
        throw new HttpError(422, `“${field.label}”不在允许选项内`, "INVALID_FIELD_VALUE", {
          field: field.code,
          options: field.options || []
        });
      }
    }
    clean[field.code] = value;
  }
  if (clean.quantity !== undefined && clean.quantity <= 0) {
    throw new HttpError(422, "数量必须大于 0", "INVALID_FIELD_VALUE", { field: "quantity" });
  }
  if (clean.amount !== undefined && clean.amount < 0) {
    throw new HttpError(422, "预算金额不能为负数", "INVALID_FIELD_VALUE", { field: "amount" });
  }
  return { clean, definition };
}

function getWorkflow(code) {
  const row = db.prepare("SELECT * FROM workflows WHERE code = ?").get(code);
  if (!row) return null;
  const config = parseJson(row.steps_json, {});
  return {
    ...row,
    steps: Array.isArray(config) ? config : (config.steps || []),
    completionStatus: Array.isArray(config) ? null : (config.completionStatus || null)
  };
}

function roleName(role) {
  const row = db.prepare("SELECT name FROM users WHERE role = ? ORDER BY id LIMIT 1").get(role);
  return row ? row.name : "待分配";
}

function conditionMatches(condition, payload) {
  if (!condition) return true;
  const actual = payload?.[condition.field];
  const expected = condition.value;
  switch (condition.operator) {
    case "eq": return actual === expected;
    case "neq": return actual !== expected;
    case "in": return Array.isArray(expected) && expected.includes(actual);
    case "not_in": return Array.isArray(expected) && !expected.includes(actual);
    case "gt": return Number(actual) > Number(expected);
    case "gte": return Number(actual) >= Number(expected);
    case "lt": return Number(actual) < Number(expected);
    case "lte": return Number(actual) <= Number(expected);
    case "exists": return actual !== undefined && actual !== null && actual !== "";
    default: return false;
  }
}

function findNextStep(steps, startIndex, payload) {
  for (let i = startIndex; i < steps.length; i++) {
    if (conditionMatches(steps[i].condition, payload)) return i;
  }
  return -1;
}

function taskForStep(instance, step, stepIndex) {
  return db.prepare(`
    INSERT INTO tasks(
      id,instance_id,step_index,step_name,assignee_role,assignee_name,status,due_at,decision,comment,created_at,completed_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    `task-${randomUUID()}`,
    instance.id,
    stepIndex,
    step.name,
    step.role,
    roleName(step.role),
    "pending",
    addHours(step.hours || 24),
    null,
    null,
    now(),
    null
  );
}

function createInstance(body, options = {}) {
  const workflowCode = String(body.workflowCode || "").trim();
  const workflow = getWorkflow(workflowCode);
  if (!workflow) throw new HttpError(404, "流程模板不存在", "WORKFLOW_NOT_FOUND");
  const title = String(body.title || "").trim();
  if (!title) throw new HttpError(422, "流程标题不能为空", "TITLE_REQUIRED");
  if (title.length > 120) throw new HttpError(422, "流程标题不能超过 120 字", "TITLE_TOO_LONG");
  const { clean: payload, definition } = validatePayload(workflow, body.payload || {});
  const startIndex = findNextStep(workflow.steps, 0, payload);
  if (startIndex < 0) throw new HttpError(409, "流程没有满足条件的可执行节点", "NO_START_STEP");
  const id = `inst-${randomUUID()}`;
  const createdBy = String(body.initiator || "演示用户").trim() || "演示用户";
  if (createdBy.length > 50) throw new HttpError(422, "发起人不能超过 50 字", "INITIATOR_TOO_LONG");
  const priority = body.priority || "normal";
  if (!["normal", "high", "critical"].includes(priority)) {
    throw new HttpError(422, "优先级只能是 normal、high 或 critical", "INVALID_PRIORITY");
  }
  const idempotencyKey = String(options.idempotencyKey || body.idempotencyKey || "").trim();
  if (idempotencyKey.length > 128) {
    throw new HttpError(422, "幂等键不能超过 128 字符", "IDEMPOTENCY_KEY_TOO_LONG");
  }
  const fingerprint = requestHash({
    workflowCode: workflow.code,
    title,
    initiator: createdBy,
    priority,
    payload
  });

  db.exec("BEGIN IMMEDIATE");
  try {
    if (idempotencyKey) {
      const existing = db.prepare(
        "SELECT * FROM workflow_instances WHERE idempotency_key = ?"
      ).get(idempotencyKey);
      if (existing) {
        if (existing.request_hash !== fingerprint) {
          throw new HttpError(409, "同一幂等键不能提交不同内容", "IDEMPOTENCY_CONFLICT");
        }
        db.exec("COMMIT");
        return { ...getInstanceDetail(existing.id), idempotent_replay: true };
      }
    }

    const nowValue = now();
    const objectId = `obj-record-${randomUUID()}`;
    const compactDate = nowValue.slice(0, 10).replaceAll("-", "");
    const businessKey = String(
      body.businessKey || `${workflow.object_code.replaceAll("_", "-")}-${compactDate}-${randomUUID().slice(0, 8)}`
    ).trim();
    const initialObjectStatus = workflow.steps[startIndex].objectState || definition.states[0] || "新建";
    db.prepare(`
      INSERT INTO business_objects(
        id,object_code,business_key,title,status,version,source_system,source_ref,fields_json,created_by,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      objectId, workflow.object_code, businessKey, title, initialObjectStatus, 1, "AIDT", null,
      json(payload), createdBy, nowValue, nowValue
    );
    db.prepare(`
      INSERT INTO workflow_instances(
        id,workflow_code,object_code,title,status,current_step,payload_json,priority,created_by,created_at,updated_at,
        object_id,idempotency_key,request_hash,version
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      id, workflow.code, workflow.object_code, title, "in_progress", startIndex,
      "{}", priority, createdBy, nowValue, nowValue, objectId, idempotencyKey || null, fingerprint, 1
    );
    const instance = db.prepare("SELECT * FROM workflow_instances WHERE id = ?").get(id);
    taskForStep(instance, workflow.steps[startIndex], startIndex);
    audit("business_object", objectId, "object.created", createdBy, {
      objectCode: workflow.object_code,
      businessKey,
      status: initialObjectStatus,
      sourceSystem: "AIDT"
    });
    audit("workflow_instance", id, "instance.created", createdBy, {
      workflow: workflow.code,
      startStep: workflow.steps[startIndex].name,
      objectId
    });
    db.exec("COMMIT");
    return { ...getInstanceDetail(id), idempotent_replay: false };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}

function taskAction(taskId, body) {
  const action = String(body.action || "").trim();
  if (!["approve", "return", "reject", "complete"].includes(action)) {
    throw new HttpError(422, "不支持的任务动作", "INVALID_TASK_ACTION");
  }
  const actor = String(body.actor || "演示用户").trim() || "演示用户";
  const comment = String(body.comment || "").trim();
  if (actor.length > 50) throw new HttpError(422, "操作人不能超过 50 字", "ACTOR_TOO_LONG");
  if (comment.length > 1000) throw new HttpError(422, "处理意见不能超过 1000 字", "COMMENT_TOO_LONG");
  if (["return", "reject"].includes(action) && !comment) {
    throw new HttpError(422, "退回或终止必须填写处理意见", "COMMENT_REQUIRED");
  }
  const decisionLabel = {
    approve: "通过",
    return: "退回",
    reject: "终止",
    complete: "完成"
  }[action];

  db.exec("BEGIN IMMEDIATE");
  try {
    const task = db.prepare(`
      SELECT t.*, i.workflow_code, i.status AS instance_status, i.title AS instance_title,
        i.object_id, o.fields_json, o.status AS object_status
      FROM tasks t
      JOIN workflow_instances i ON i.id = t.instance_id
      LEFT JOIN business_objects o ON o.id = i.object_id
      WHERE t.id = ?
    `).get(taskId);
    if (!task) throw new HttpError(404, "任务不存在", "TASK_NOT_FOUND");
    if (task.status !== "pending") {
      throw new HttpError(409, "任务已处理，不能重复操作", "TASK_ALREADY_PROCESSED");
    }
    if (task.instance_status !== "in_progress") {
      throw new HttpError(409, "流程实例不是进行中状态", "INSTANCE_NOT_IN_PROGRESS");
    }
    if (!task.object_id) {
      throw new HttpError(409, "流程实例没有关联业务对象", "OBJECT_LINK_MISSING");
    }
    const workflow = getWorkflow(task.workflow_code);
    if (!workflow) throw new HttpError(409, "流程模板不存在", "WORKFLOW_NOT_FOUND");
    const payload = parseJson(task.fields_json, {});

    const updateResult = db.prepare(`
      UPDATE tasks
      SET status = ?, decision = ?, comment = ?, assignee_name = ?, completed_at = ?
      WHERE id = ? AND status = 'pending'
    `).run(action === "reject" ? "rejected" : "completed", decisionLabel, comment, actor, now(), taskId);
    if (updateResult.changes !== 1) {
      throw new HttpError(409, "任务已被其他请求处理", "TASK_CONFLICT");
    }

    audit("task", taskId, `task.${action}`, actor, {
      instanceId: task.instance_id,
      objectId: task.object_id,
      step: task.step_name,
      decision: decisionLabel,
      comment
    });

    if (action === "reject") {
      const updatedAt = now();
      db.prepare(`
        UPDATE workflow_instances SET status = 'rejected', updated_at = ?, version = version + 1 WHERE id = ?
      `).run(updatedAt, task.instance_id);
      db.prepare(`
        UPDATE business_objects SET status = '已终止', updated_at = ?, version = version + 1 WHERE id = ?
      `).run(updatedAt, task.object_id);
      audit("business_object", task.object_id, "object.status_changed", actor, {
        from: task.object_status,
        to: "已终止",
        reason: "流程终止"
      });
      audit("workflow_instance", task.instance_id, "instance.rejected", actor, {
        step: task.step_name,
        objectId: task.object_id,
        comment
      });
    } else if (action === "return") {
      if (task.step_index <= 0) {
        throw new HttpError(409, "首节点没有可退回的上一节点", "RETURN_NOT_AVAILABLE");
      }
      const targetIndex = Math.max(0, task.step_index - 1);
      const targetStep = workflow.steps[targetIndex];
      const updatedAt = now();
      db.prepare(`
        UPDATE workflow_instances SET current_step = ?, updated_at = ?, version = version + 1 WHERE id = ?
      `).run(targetIndex, updatedAt, task.instance_id);
      if (targetStep.objectState) {
        db.prepare(`
          UPDATE business_objects SET status = ?, updated_at = ?, version = version + 1 WHERE id = ?
        `).run(targetStep.objectState, updatedAt, task.object_id);
        audit("business_object", task.object_id, "object.status_changed", actor, {
          from: task.object_status,
          to: targetStep.objectState,
          reason: "流程退回"
        });
      }
      const instance = db.prepare("SELECT * FROM workflow_instances WHERE id = ?").get(task.instance_id);
      taskForStep(instance, targetStep, targetIndex);
      audit("workflow_instance", task.instance_id, "instance.returned", actor, {
        from: task.step_name,
        to: targetStep.name,
        objectId: task.object_id,
        comment
      });
    } else {
      const nextIndex = findNextStep(workflow.steps, task.step_index + 1, payload);
      if (nextIndex < 0) {
        const updatedAt = now();
        const completionStatus = workflow.completionStatus || "已完成";
        const skipped = workflow.steps.slice(task.step_index + 1).map(step => step.name);
        db.prepare(`
          UPDATE workflow_instances SET status = 'completed', current_step = ?, updated_at = ?, version = version + 1 WHERE id = ?
        `).run(workflow.steps.length, updatedAt, task.instance_id);
        db.prepare(`
          UPDATE business_objects SET status = ?, updated_at = ?, version = version + 1 WHERE id = ?
        `).run(completionStatus, updatedAt, task.object_id);
        audit("business_object", task.object_id, "object.status_changed", actor, {
          from: task.object_status,
          to: completionStatus,
          reason: "流程完成"
        });
        audit("workflow_instance", task.instance_id, "instance.completed", actor, {
          finalStep: task.step_name,
          objectId: task.object_id,
          skipped
        });
      } else {
        const skipped = [];
        for (let i = task.step_index + 1; i < nextIndex; i++) skipped.push(workflow.steps[i].name);
        const nextStep = workflow.steps[nextIndex];
        const updatedAt = now();
        db.prepare(`
          UPDATE workflow_instances SET current_step = ?, updated_at = ?, version = version + 1 WHERE id = ?
        `).run(nextIndex, updatedAt, task.instance_id);
        if (nextStep.objectState) {
          db.prepare(`
            UPDATE business_objects SET status = ?, updated_at = ?, version = version + 1 WHERE id = ?
          `).run(nextStep.objectState, updatedAt, task.object_id);
          audit("business_object", task.object_id, "object.status_changed", actor, {
            from: task.object_status,
            to: nextStep.objectState,
            reason: "流程推进"
          });
        }
        const instance = db.prepare("SELECT * FROM workflow_instances WHERE id = ?").get(task.instance_id);
        taskForStep(instance, nextStep, nextIndex);
        audit("workflow_instance", task.instance_id, "instance.advanced", actor, {
          from: task.step_name,
          to: nextStep.name,
          skipped,
          objectId: task.object_id
        });
      }
    }
    db.exec("COMMIT");
    return getInstanceDetail(task.instance_id);
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}

function runAgent(agentId, body) {
  const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId);
  if (!agent) throw new HttpError(404, "数字员工不存在", "AGENT_NOT_FOUND");
  if (agent.status !== "active") throw new HttpError(409, "数字员工已停用", "AGENT_INACTIVE");
  const allowedWorkflows = parseJson(agent.allowed_workflows_json, []);
  let instance = null;
  if (body.instanceId !== undefined && body.instanceId !== null && body.instanceId !== "") {
    if (typeof body.instanceId !== "string") {
      throw new HttpError(422, "instanceId 必须是字符串", "INVALID_INSTANCE_ID");
    }
    instance = db.prepare("SELECT * FROM workflow_instances WHERE id = ?").get(body.instanceId);
    if (!instance) throw new HttpError(404, "关联流程实例不存在", "INSTANCE_NOT_FOUND");
    if (allowedWorkflows.length && !allowedWorkflows.includes(instance.workflow_code)) {
      throw new HttpError(403, "数字员工无权访问该流程实例", "AGENT_SCOPE_DENIED");
    }
  } else if (allowedWorkflows.length) {
    const placeholders = allowedWorkflows.map(() => "?").join(",");
    instance = db.prepare(`
      SELECT * FROM workflow_instances
      WHERE workflow_code IN (${placeholders})
      ORDER BY updated_at DESC LIMIT 1
    `).get(...allowedWorkflows);
  }
  const templates = {
    "agent-rd": {
      summary: "已对当前研发任务进行资料完整性检查。",
      findings: ["需求字段已填写", "尚缺少原料批次与实验设备信息", "未发现跨项目配方引用"],
      recommendation: "建议补齐实验条件后进入研发评审。",
      mode: "只生成建议，不修改业务数据"
    },
    "agent-batch": {
      summary: "已完成批次异常初步关联分析。",
      findings: ["异常与当前批次关联成功", "报警持续12分钟", "涉及重大风险等级"],
      recommendation: "建议由工艺与质量联合确认，并保留DCS原始报警作为证据。",
      mode: "创建分析结论，不执行DCS控制"
    },
    "agent-p2p": {
      summary: "已模拟执行订单、验收与发票三单匹配。",
      findings: ["采购金额68,000元", "达到重大采购阈值", "付款动作仍需财务人工审批"],
      recommendation: "补齐验收单与发票后提交付款审批。",
      mode: "只读比对，不执行付款"
    },
    "agent-delivery": {
      summary: "已生成交付资料完整性草稿。",
      findings: ["发货单可用", "CoA待质量放行", "客户回复未发送"],
      recommendation: "质量放行后补齐随货资料并由交付负责人确认。",
      mode: "仅生成草稿，不对外发送"
    }
  };
  const result = templates[agent.id] || {
    summary: "已完成模拟分析。",
    findings: ["仅使用当前演示数据"],
    recommendation: "请由业务负责人复核。",
    mode: "模拟技能"
  };
  const requiresApproval = Boolean(agent.requires_approval);
  const runStatus = requiresApproval ? "pending_confirmation" : "completed";
  const id = `run-${randomUUID()}`;
  db.prepare(`
    INSERT INTO agent_runs(id,agent_id,instance_id,action,result_json,status,requires_approval,created_at)
    VALUES(?,?,?,?,?,?,?,?)
  `).run(id, agent.id, instance?.id || null, "mock.skill.run", json(result), runStatus, requiresApproval ? 1 : 0, now());
  db.prepare("UPDATE agents SET last_run = ?, run_count = run_count + 1 WHERE id = ?").run(now(), agent.id);
  audit("agent", agent.id, "agent.run", agent.owner, {
    runId: id,
    instanceId: instance?.id || null,
    objectId: instance
      ? db.prepare("SELECT object_id FROM workflow_instances WHERE id = ?").get(instance.id)?.object_id || null
      : null,
    level: agent.level,
    requiresApproval,
    runStatus,
    blockedActions: parseJson(agent.blocked_actions_json, [])
  });
  return {
    id,
    agent: {
      ...agent,
      scopes: parseJson(agent.scopes_json, []),
      allowedWorkflows,
      permissions: parseJson(agent.permissions_json, []),
      blockedActions: parseJson(agent.blocked_actions_json, []),
      requiresApproval
    },
    instance: instance ? { id: instance.id, title: instance.title } : null,
    result,
    requiresApproval,
    runStatus,
    disclaimer: "本结果为本地规则化演示，不调用真实大模型，不代表生产决策。"
  };
}

function confirmAgentRun(runId, body) {
  const actor = String(body.actor || "").trim();
  const comment = String(body.comment || "").trim();
  if (!actor) throw new HttpError(422, "人工确认必须填写确认人", "CONFIRMER_REQUIRED");
  if (actor.length > 50) throw new HttpError(422, "确认人不能超过 50 字", "CONFIRMER_TOO_LONG");
  if (comment.length > 1000) throw new HttpError(422, "确认意见不能超过 1000 字", "COMMENT_TOO_LONG");

  db.exec("BEGIN IMMEDIATE");
  try {
    const run = db.prepare(`
      SELECT r.*, a.name AS agent_name, a.owner AS agent_owner, i.title AS instance_title
      FROM agent_runs r
      JOIN agents a ON a.id = r.agent_id
      LEFT JOIN workflow_instances i ON i.id = r.instance_id
      WHERE r.id = ?
    `).get(runId);
    if (!run) throw new HttpError(404, "数字员工运行记录不存在", "AGENT_RUN_NOT_FOUND");
    if (run.status !== "pending_confirmation") {
      throw new HttpError(409, "该运行记录不需要重复确认或已确认", "AGENT_RUN_NOT_PENDING");
    }
    const confirmedAt = now();
    db.prepare(`
      UPDATE agent_runs
      SET status = 'confirmed', confirmed_by = ?, confirmed_at = ?, confirmation_comment = ?
      WHERE id = ? AND status = 'pending_confirmation'
    `).run(actor, confirmedAt, comment, runId);
    audit("agent_run", runId, "agent.confirmed", actor, {
      agentId: run.agent_id,
      instanceId: run.instance_id,
      comment,
      businessEffect: "none_mock_only"
    });
    db.exec("COMMIT");
    return {
      id: run.id,
      status: "confirmed",
      confirmedBy: actor,
      confirmedAt,
      comment,
      agentName: run.agent_name,
      instanceId: run.instance_id,
      instanceTitle: run.instance_title
    };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}

function summary() {
  const objectTypeCount = db.prepare("SELECT COUNT(*) AS count FROM object_defs").get().count;
  const objectCount = db.prepare("SELECT COUNT(*) AS count FROM business_objects").get().count;
  const workflowCount = db.prepare("SELECT COUNT(*) AS count FROM workflows").get().count;
  const activeInstances = db.prepare("SELECT COUNT(*) AS count FROM workflow_instances WHERE status = 'in_progress'").get().count;
  const pendingTasks = db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE status = 'pending'").get().count;
  const agentCount = db.prepare("SELECT COUNT(*) AS count FROM agents WHERE status = 'active'").get().count;
  const connectorCount = db.prepare("SELECT COUNT(*) AS count FROM connectors").get().count;
  const auditCount = db.prepare("SELECT COUNT(*) AS count FROM audit_events").get().count;
  const overdueTasks = db.prepare(`
    SELECT COUNT(*) AS count FROM tasks WHERE status = 'pending' AND due_at < ?
  `).get(now()).count;
  const domainRows = db.prepare(`
    SELECT w.domain, COUNT(i.id) AS count
    FROM workflows w
    LEFT JOIN workflow_instances i ON i.workflow_code = w.code AND i.status = 'in_progress'
    GROUP BY w.domain ORDER BY count DESC
  `).all();
  const recentAudit = db.prepare(`
    SELECT * FROM audit_events ORDER BY created_at DESC LIMIT 8
  `).all().map(row => ({ ...row, details: parseJson(row.details_json, {}) }));
  return {
    generatedAt: now(),
    counts: {
      objects: objectCount,
      objectTypes: objectTypeCount,
      workflows: workflowCount,
      activeInstances,
      pendingTasks,
      overdueTasks,
      agents: agentCount,
      connectors: connectorCount,
      auditEvents: auditCount
    },
    domains: domainRows,
    recentAudit
  };
}

function listInstances() {
  return db.prepare(`
    SELECT i.*, w.name AS workflow_name, w.domain,
      o.business_key, o.title AS object_title, o.status AS object_status,
      o.fields_json, o.source_system, o.source_ref, o.version AS object_version,
      (SELECT COUNT(*) FROM tasks t WHERE t.instance_id = i.id AND t.status = 'completed') AS completed_steps
    FROM workflow_instances i
    JOIN workflows w ON w.code = i.workflow_code
    LEFT JOIN business_objects o ON o.id = i.object_id
    ORDER BY CASE i.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END, i.updated_at DESC
  `).all().map(hydrateInstanceRow);
}

function hydrateInstanceRow(row) {
  return {
    ...row,
    fields: parseJson(row.fields_json, {}),
    object: row.object_id ? {
      id: row.object_id,
      title: row.object_title,
      businessKey: row.business_key,
      status: row.object_status,
      sourceSystem: row.source_system,
      sourceRef: row.source_ref,
      version: row.object_version
    } : null
  };
}

function getInstanceBase(instanceId) {
  const row = db.prepare(`
    SELECT i.*, w.name AS workflow_name, w.domain,
      o.business_key, o.title AS object_title, o.status AS object_status,
      o.fields_json, o.source_system, o.source_ref, o.version AS object_version,
      (SELECT COUNT(*) FROM tasks t WHERE t.instance_id = i.id AND t.status = 'completed') AS completed_steps
    FROM workflow_instances i
    JOIN workflows w ON w.code = i.workflow_code
    LEFT JOIN business_objects o ON o.id = i.object_id
    WHERE i.id = ?
  `).get(instanceId);
  return row ? hydrateInstanceRow(row) : null;
}

function getInstanceDetail(instanceId) {
  const instance = getInstanceBase(instanceId);
  if (!instance) throw new HttpError(404, "流程实例不存在", "INSTANCE_NOT_FOUND");
  const workflow = getWorkflow(instance.workflow_code);
  const tasks = db.prepare(`
    SELECT * FROM tasks WHERE instance_id = ? ORDER BY created_at ASC, rowid ASC
  `).all(instanceId);
  const taskIds = tasks.map(task => task.id);
  const auditEvents = db.prepare(`
    SELECT * FROM audit_events
    WHERE (entity_type = 'workflow_instance' AND entity_id = ?)
       OR (entity_type = 'business_object' AND entity_id = ?)
       OR (entity_type = 'task' AND entity_id IN (${taskIds.length ? taskIds.map(() => "?").join(",") : "''"}))
    ORDER BY created_at ASC, rowid ASC
  `).all(instanceId, instance.object_id || "", ...taskIds)
    .map(row => ({ ...row, details: parseJson(row.details_json, {}) }));
  const agentRuns = db.prepare(`
    SELECT r.*, a.name AS agent_name, a.level AS agent_level
    FROM agent_runs r JOIN agents a ON a.id = r.agent_id
    WHERE r.instance_id = ?
    ORDER BY r.created_at DESC
  `).all(instanceId).map(run => ({ ...run, result: parseJson(run.result_json, {}) }));
  const skippedSteps = auditEvents
    .filter(event => ["instance.advanced", "instance.completed"].includes(event.action))
    .flatMap(event => event.details?.skipped || []);
  return {
    instance,
    workflow,
    object: instance.object,
    fields: instance.fields,
    tasks,
    pendingTask: tasks.find(task => task.status === "pending") || null,
    audit: auditEvents,
    agentRuns,
    skippedSteps
  };
}

function listTasks() {
  return db.prepare(`
    SELECT t.*, i.title AS instance_title, i.priority, i.workflow_code, w.name AS workflow_name,
      i.object_id, o.status AS object_status
    FROM tasks t
    JOIN workflow_instances i ON i.id = t.instance_id
    JOIN workflows w ON w.code = i.workflow_code
    LEFT JOIN business_objects o ON o.id = i.object_id
    ORDER BY CASE t.status WHEN 'pending' THEN 0 ELSE 1 END,
      CASE i.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,
      COALESCE(t.due_at, t.completed_at) ASC
  `).all();
}

function listAgents() {
  const agents = db.prepare("SELECT * FROM agents ORDER BY level, name").all();
  return agents.map(a => ({
    ...a,
    scopes: parseJson(a.scopes_json, []),
    allowedWorkflows: parseJson(a.allowed_workflows_json, []),
    permissions: parseJson(a.permissions_json, []),
    blockedActions: parseJson(a.blocked_actions_json, []),
    requiresApproval: Boolean(a.requires_approval),
    recentRuns: db.prepare(`
      SELECT id, instance_id, action, result_json, status, requires_approval, confirmed_by, confirmed_at,
        confirmation_comment, created_at
      FROM agent_runs WHERE agent_id = ? ORDER BY created_at DESC LIMIT 3
    `).all(a.id).map(run => ({
      ...run,
      result: parseJson(run.result_json, {}),
      requires_approval: Boolean(run.requires_approval)
    }))
  }));
}

function listObjectRecords() {
  return db.prepare(`
    SELECT o.*,
      (SELECT COUNT(*) FROM workflow_instances i WHERE i.object_id = o.id) AS instance_count
    FROM business_objects o
    ORDER BY o.updated_at DESC
  `).all().map(row => ({
    ...row,
    fields: parseJson(row.fields_json, {}),
    instanceCount: row.instance_count
  }));
}

function getObjectRecord(objectId) {
  const row = db.prepare(`
    SELECT o.*,
      (SELECT COUNT(*) FROM workflow_instances i WHERE i.object_id = o.id) AS instance_count
    FROM business_objects o WHERE o.id = ?
  `).get(objectId);
  if (!row) throw new HttpError(404, "业务对象不存在", "OBJECT_NOT_FOUND");
  const definition = getObjectDefinition(row.object_code);
  const instances = db.prepare(`
    SELECT i.*, w.name AS workflow_name, w.domain,
      (SELECT COUNT(*) FROM tasks t WHERE t.instance_id = i.id AND t.status = 'completed') AS completed_steps
    FROM workflow_instances i
    JOIN workflows w ON w.code = i.workflow_code
    WHERE i.object_id = ?
    ORDER BY i.updated_at DESC
  `).all(objectId);
  const auditEvents = db.prepare(`
    SELECT * FROM audit_events
    WHERE (entity_type = 'business_object' AND entity_id = ?)
       OR (entity_type = 'workflow_instance' AND entity_id IN (
         SELECT id FROM workflow_instances WHERE object_id = ?
       ))
    ORDER BY created_at ASC, rowid ASC
  `).all(objectId, objectId).map(event => ({ ...event, details: parseJson(event.details_json, {}) }));
  return {
    object: { ...row, fields: parseJson(row.fields_json, {}), instanceCount: row.instance_count },
    definition,
    instances,
    audit: auditEvents
  };
}

function listAgentRuns(instanceId = null) {
  const sql = `
    SELECT r.*, a.name AS agent_name, a.level AS agent_level, a.owner AS agent_owner,
      i.title AS instance_title
    FROM agent_runs r
    JOIN agents a ON a.id = r.agent_id
    LEFT JOIN workflow_instances i ON i.id = r.instance_id
    ${instanceId ? "WHERE r.instance_id = ?" : ""}
    ORDER BY r.created_at DESC
  `;
  const rows = instanceId ? db.prepare(sql).all(instanceId) : db.prepare(sql).all();
  return rows.map(run => ({ ...run, result: parseJson(run.result_json, {}) }));
}

function listConnectors() {
  return db.prepare("SELECT * FROM connectors ORDER BY name").all().map(c => ({
    ...c,
    capabilities: parseJson(c.capabilities_json, [])
  }));
}

function listAudit() {
  return db.prepare("SELECT * FROM audit_events ORDER BY created_at DESC LIMIT 200")
    .all()
    .map(row => ({ ...row, details: parseJson(row.details_json, {}) }));
}

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

function serveStatic(req, res, pathname) {
  const relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  const safePath = path.resolve(publicDir, relative);
  if (!safePath.startsWith(publicDir + path.sep) && safePath !== path.join(publicDir, "index.html")) {
    sendError(res, 403, "禁止访问");
    return;
  }
  let filePath = safePath;
  if (!fs.existsSync(filePath)) filePath = path.join(publicDir, "index.html");
  const ext = path.extname(filePath).toLowerCase();
  const content = fs.readFileSync(filePath);
  res.writeHead(200, {
    "Content-Type": mimeTypes[ext] || "application/octet-stream",
    "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=60",
    "Content-Length": content.length
  });
  res.end(content);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || `${host}:${port}`}`);
  try {
    if (url.pathname === "/api/health") {
      sendJson(res, 200, {
        ok: true,
        service: "AIDT Local MVP",
        time: now(),
        database: dbPath,
        mode: "zero-dependency-local-prototype",
        runtimeModes: {
          businessData: "local-sqlite",
          externalConnectors: "mock-only",
          digitalWorkforce: "rule-based-mock-with-human-confirmation",
          identity: "demo-header-simulation"
        }
      });
      return;
    }
    if (url.pathname === "/api/summary" && req.method === "GET") {
      sendJson(res, 200, summary());
      return;
    }
    if (url.pathname === "/api/object-defs" && req.method === "GET") {
      const rows = db.prepare("SELECT * FROM object_defs ORDER BY domain, name").all();
      sendJson(res, 200, rows.map(r => ({
        ...r,
        fields: parseJson(r.fields_json, []),
        states: parseJson(r.states_json, [])
      })));
      return;
    }
    if (url.pathname === "/api/objects" && req.method === "GET") {
      sendJson(res, 200, listObjectRecords());
      return;
    }
    const objectDetailMatch = url.pathname.match(/^\/api\/objects\/([^/]+)$/);
    if (objectDetailMatch && req.method === "GET") {
      sendJson(res, 200, getObjectRecord(decodeURIComponent(objectDetailMatch[1])));
      return;
    }
    if (url.pathname === "/api/workflows" && req.method === "GET") {
      const rows = db.prepare("SELECT * FROM workflows ORDER BY domain, name").all();
      sendJson(res, 200, rows.map(r => {
        const config = parseJson(r.steps_json, {});
        return {
          ...r,
          steps: Array.isArray(config) ? config : (config.steps || []),
          completionStatus: Array.isArray(config) ? null : (config.completionStatus || null)
        };
      }));
      return;
    }
    if (url.pathname === "/api/instances" && req.method === "GET") {
      sendJson(res, 200, listInstances());
      return;
    }
    if (url.pathname === "/api/instances" && req.method === "POST") {
      const body = await readBody(req);
      const headerKey = String(req.headers["idempotency-key"] || "").trim();
      if (headerKey && body.idempotencyKey && headerKey !== String(body.idempotencyKey).trim()) {
        throw new HttpError(422, "请求头与请求体中的幂等键不一致", "IDEMPOTENCY_KEY_MISMATCH");
      }
      const result = createInstance(body, { idempotencyKey: headerKey });
      sendJson(res, result.idempotent_replay ? 200 : 201, result);
      return;
    }
    const instanceDetailMatch = url.pathname.match(/^\/api\/instances\/([^/]+)$/);
    if (instanceDetailMatch && req.method === "GET") {
      sendJson(res, 200, getInstanceDetail(decodeURIComponent(instanceDetailMatch[1])));
      return;
    }
    if (url.pathname === "/api/tasks" && req.method === "GET") {
      sendJson(res, 200, listTasks());
      return;
    }
    const taskActionMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/action$/);
    if (taskActionMatch && req.method === "POST") {
      const body = await readBody(req);
      sendJson(res, 200, taskAction(decodeURIComponent(taskActionMatch[1]), body));
      return;
    }
    if (url.pathname === "/api/agents" && req.method === "GET") {
      sendJson(res, 200, listAgents());
      return;
    }
    if (url.pathname === "/api/agent-runs" && req.method === "GET") {
      sendJson(res, 200, listAgentRuns(url.searchParams.get("instanceId")));
      return;
    }
    const agentConfirmMatch = url.pathname.match(/^\/api\/agent-runs\/([^/]+)\/confirm$/);
    if (agentConfirmMatch && req.method === "POST") {
      const body = await readBody(req);
      sendJson(res, 200, confirmAgentRun(decodeURIComponent(agentConfirmMatch[1]), body));
      return;
    }
    const agentRunMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/run$/);
    if (agentRunMatch && req.method === "POST") {
      const body = await readBody(req);
      sendJson(res, 200, runAgent(decodeURIComponent(agentRunMatch[1]), body));
      return;
    }
    if (url.pathname === "/api/connectors" && req.method === "GET") {
      sendJson(res, 200, listConnectors());
      return;
    }
    if (url.pathname === "/api/audit" && req.method === "GET") {
      sendJson(res, 200, listAudit());
      return;
    }
    if (url.pathname === "/api/reset-demo" && req.method === "POST") {
      seedDatabase(true);
      audit("system", "demo", "demo.reset", "系统管理员", {});
      sendJson(res, 200, { ok: true, message: "演示数据已重置" });
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      sendError(res, 404, "API 不存在");
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendError(res, 405, "不支持的方法");
      return;
    }
    serveStatic(req, res, url.pathname);
  } catch (error) {
    if (!(error instanceof HttpError) || error.status >= 500) console.error(error);
    sendError(
      res,
      error.status || 400,
      error.message || "请求处理失败",
      error.details || null,
      error.code || "REQUEST_FAILED"
    );
  }
});

initSchema();
const seeded = seedDatabase(false);
const migratedObjects = migrateLegacyObjects();

server.listen(port, host, () => {
  console.log("");
  console.log("  AIDT 本地验证版已启动");
  console.log(`  http://${host}:${port}`);
  console.log(`  数据库：${dbPath}`);
  console.log(`  演示数据：${seeded ? "已初始化" : "已存在"}`);
  if (migratedObjects) console.log(`  旧流程对象迁移：${migratedObjects} 条`);
  console.log("  按 Ctrl+C 停止服务");
  console.log("");
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
