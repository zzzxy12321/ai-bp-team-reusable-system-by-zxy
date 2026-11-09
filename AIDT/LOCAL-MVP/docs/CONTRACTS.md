# AIDT 本地验证版业务契约

本文件是临时技术栈与最终技术栈之间的稳定层。迁移时优先保持这些业务语义，不机械复制当前 Node.js 代码。

## 1. 数据权威边界

| 数据/能力 | 权威系统 | AIDT 责任 |
|---|---|---|
| 财务凭证、总账、应收应付 | U9 | 读取、审批前置、业务协同、分析 |
| 客户订单、计划、工单、采购交易 | ERP | 组织跨部门流程、异常和证据 |
| 实时工艺参数、设备联锁、报警 | DCS/PLC | 只读报警摘要、批次关联、异常处置 |
| 项目、任务、实验、质量异常、流程、文档、知识 | AIDT | 业务主账、流程账和证据账 |
| 组织身份与消息 | 钉钉/HR | 单点登录、待办、通知和移动入口 |

硬规则：

- 不直接写外部系统数据库。
- 跨系统写入必须通过受控命令接口、幂等键和审批证据。
- AIDT 不向 DCS 下发安全关键控制命令。

## 2. 业务对象

### 2.0 对象定义与对象实例

- `object_defs` 只保存对象类型、字段和状态元数据。
- `business_objects` 保存真实业务记录，是现实实体的唯一主对象。
- `workflow_instances.object_id` 引用主对象；流程不得复制对象字段到实例。
- 对象实例至少包含：唯一 ID、对象类型、业务键、标题、状态、版本、来源系统、来源引用、字段值、创建/更新时间和操作者。
- 本次演示对象全部为虚构数据；`source_system = DCS-MOCK` 明确表示模拟事件。

### 2.1 客户样品需求 `CUSTOMER_SAMPLE`

| 字段 | 类型 | 必填 |
|---|---|---|
| customer 客户 | lookup | 是 |
| productRequirement 目标产品/技术要求 | textarea | 是 |
| quantity 样品数量 | number | 是 |
| targetDate 期望日期 | date | 是 |
| confidentiality 保密等级 | select | 是 |

状态：

`草稿 → 研发评审 → 实验中 → 待测试 → 待试产 → 已转产`

异常状态：`已退回`

### 2.2 研发实验 `LAB_EXPERIMENT`

| 字段 | 类型 | 必填 |
|---|---|---|
| project 研发项目 | lookup | 是 |
| formulaVersion 配方版本 | text | 是 |
| materials 原料批次 | textarea | 是 |
| condition 工艺条件 | textarea | 否 |
| result 实验结果 | textarea | 否 |

状态：

`计划 → 执行中 → 待复核 → 通过/不通过 → 关闭`

### 2.3 生产批次 `PRODUCTION_BATCH`

| 字段 | 类型 | 必填 |
|---|---|---|
| workOrder 工单号 | text | 是 |
| product 产品 | lookup | 是 |
| formulaVersion 配方版本 | text | 是 |
| equipment 设备 | lookup | 是 |
| batchNo 批次号 | text | 是 |

状态：

`待生产 → 生产中 → 待检 → 待放行 → 已放行`

异常状态：`异常`

### 2.4 质量偏差 `QUALITY_DEVIATION`

| 字段 | 类型 | 必填 |
|---|---|---|
| batch 批次 | lookup | 是 |
| severity 风险等级 | select | 是 |
| description 问题描述 | textarea | 是 |
| disposition 处置意见 | textarea | 否 |
| capa CAPA措施 | textarea | 否 |

状态：

`待确认 → 调查中 → 待处置 → CAPA中 → 待验证 → 已关闭`

### 2.5 采购申请 `PURCHASE_REQUEST`

| 字段 | 类型 | 必填 |
|---|---|---|
| material 物料 | lookup | 是 |
| quantity 数量 | number | 是 |
| amount 预算金额 | number | 是 |
| supplier 建议供应商 | lookup | 否 |
| requiredDate 需求日期 | date | 是 |

状态：

`待预算 → 采购中 → 待到货 → 待检验 → 付款中 → 已完成`

异常状态：`已退回`

### 2.6 客户客诉 `CUSTOMER_COMPLAINT`

| 字段 | 类型 | 必填 |
|---|---|---|
| customer 客户 | lookup | 是 |
| batch 涉及批次 | lookup | 是 |
| complaint 客诉描述 | textarea | 是 |
| severity 影响等级 | select | 是 |
| responseDue 回复期限 | date | 是 |

状态：

`已受理 → 追溯中 → 调查中 → 待回复 → CAPA中 → 已关闭`

## 3. 流程模板

### 3.1 客户样品到研发转产 `SAMPLE_TO_TRIAL`

1. 销售登记样品需求。
2. 研发立项评审。
3. 实验执行与结果登记。
4. 质量测试判定。
5. 试产联合评审。
6. 研发总监批准转产。

### 3.2 批次异常到 CAPA `BATCH_DEVIATION`

1. 系统关联批次并生成异常。
2. 班组长现场确认。
3. 工艺与质量联合评审。
4. 处置方案审批。
5. CAPA执行与效果验证。
6. 重大异常总经理审批。

条件：

```json
{
  "field": "severity",
  "operator": "in",
  "value": ["重大", "特别重大"]
}
```

### 3.3 采购到付款 `PURCHASE_TO_PAY`

1. 需求部门提交请购。
2. 财务预算审核。
3. 采购询价与下单。
4. 到货与检验确认。
5. 订单、验收、发票三单匹配。
6. 付款审批。
7. 重大采购总经理审批。

条件：

```json
{
  "field": "amount",
  "operator": "gte",
  "value": 50000
}
```

### 3.4 客诉到 CAPA `COMPLAINT_TO_CAPA`

1. 客诉受理与分级。
2. 批次与同批去向追溯。
3. 研发质量联合调查。
4. 客户处置方案确认。
5. CAPA与体系更新。
6. 客户回访与关闭。

## 4. 条件运算符

| 运算符 | 含义 |
|---|---|
| `eq` | 等于 |
| `neq` | 不等于 |
| `in` | 属于集合 |
| `not_in` | 不属于集合 |
| `gt` / `gte` | 大于 / 大于等于 |
| `lt` / `lte` | 小于 / 小于等于 |
| `exists` | 字段存在且非空 |

条件节点不满足时自动跳过，并在流程推进审计中记录跳过的节点。

## 5. 流程实例与任务语义

### 流程实例状态

- `in_progress` 运行中。
- `completed` 已完成。
- `rejected` 已终止。

### 任务状态

- `pending` 待处理。
- `completed` 已通过/已退回/已终止。
- `rejected` 已终止。

### 任务动作

| 动作 | 效果 |
|---|---|
| `approve` | 通过并进入下一可用节点 |
| `complete` | 普通任务完成并进入下一节点 |
| `return` | 退回到上一节点，并创建新的待办 |
| `reject` | 终止整个流程实例 |

附加规则：

- `return` 和 `reject` 必须填写处理意见。
- 首节点不得退回。
- 退回和终止会同步更新业务对象状态。
- 流程完成、退回、终止和条件跳过均会写审计。
- 同一任务只允许一次成功状态变更；并发请求返回 409。

所有动作必须：

1. 校验任务仍是 `pending`。
2. 校验实例仍是 `in_progress`。
3. 在事务中更新任务和实例。
4. 写入审计事件。
5. 返回新的实例状态和下一任务。

## 6. API 契约

基础地址：`http://127.0.0.1:4173`

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/health` | 服务健康检查 |
| GET | `/api/summary` | 驾驶舱汇总 |
| GET | `/api/object-defs` | 业务对象定义 |
| GET | `/api/objects` | 业务对象实例列表 |
| GET | `/api/objects/:id` | 对象字段、关联流程与审计 |
| GET | `/api/workflows` | 流程模板 |
| GET | `/api/instances` | 流程实例 |
| POST | `/api/instances` | 发起流程 |
| GET | `/api/instances/:id` | 流程、对象、任务、审计和数字员工详情 |
| GET | `/api/tasks` | 任务列表 |
| POST | `/api/tasks/:id/action` | 处理任务 |
| GET | `/api/agents` | 数字员工目录 |
| POST | `/api/agents/:id/run` | 模拟运行数字员工 |
| GET | `/api/agent-runs` | 数字员工运行记录，可按 `instanceId` 过滤 |
| POST | `/api/agent-runs/:id/confirm` | 人工确认数字员工结果 |
| GET | `/api/connectors` | 连接器目录 |
| GET | `/api/audit` | 审计事件 |
| POST | `/api/reset-demo` | 重置演示数据 |

发起流程请求：

```json
{
  "workflowCode": "PURCHASE_TO_PAY",
  "title": "研发中试原料紧急采购",
  "initiator": "刘采购",
  "priority": "high",
  "payload": {
    "material": "功能单体FM-21",
    "quantity": 500,
    "amount": 68000,
    "requiredDate": "2026-11-01"
  }
}
```

幂等：

- 推荐传递请求头 `Idempotency-Key`，也可使用请求体 `idempotencyKey`。
- 同键同内容返回原实例，HTTP 200，`idempotent_replay=true`。
- 同键不同内容返回 HTTP 409 `IDEMPOTENCY_CONFLICT`。
- 首次创建返回 HTTP 201。

字段校验：

- 服务端按对象定义校验必填、文本/数字/日期/枚举类型。
- 未定义字段返回 422 `UNKNOWN_FIELDS`。
- 必填缺失返回 422 `REQUIRED_FIELD`。
- 类型错误返回 422 `INVALID_FIELD_TYPE`。
- 数量必须大于 0，预算金额不得为负数。

处理任务请求：

```json
{
  "action": "approve",
  "actor": "孙财务",
  "comment": "预算已确认"
}
```

## 7. 数字员工

| 等级 | 能力 | 本次演示边界 |
|---|---|---|
| A0 | 只生成建议 | 不写业务数据 |
| A1 | 草稿 | 发送前人工确认 |
| A2 | 执行后通知 | 只创建分析结论/任务 |
| A3 | 限额执行 | 当前未实现真实业务写入 |
| A4 | 低风险闭环 | 当前未启用 |

数字员工必须登记：

- 名称与编号。
- 所属部门。
- 业务负责人。
- 执行等级和模式。
- 数据范围。
- 工具范围。
- 是否需要人工确认。
- 最近运行和运行次数。

当前运行器为规则化模拟，不调用真实大模型，不产生外部副作用。

运行状态：

- A0：无需逐次确认，运行状态为 `completed`。
- A1—A4 当前均进入 `pending_confirmation`，确认后变为 `confirmed`。
- 运行记录保存关联实例、权限、禁止动作、免责声明、确认人和确认时间。
- 数字员工只能处理 `allowed_workflows_json` 范围内的实例，跨范围返回 403。
- 所有模拟运行与人工确认均写入审计；`businessEffect=none_mock_only`。

## 8. 审计事件

每条审计至少记录：

```json
{
  "entity_type": "workflow_instance",
  "entity_id": "inst-xxx",
  "action": "instance.advanced",
  "actor": "赵质量",
  "details": {
    "from": "工艺与质量联合评审",
    "to": "处置方案审批",
    "skipped": []
  },
  "created_at": "2026-10-27T15:00:00.000Z"
}
```

## 9. 配置分级

| 级别 | 范围 | 当前原型 |
|---|---|---|
| L1 | 个人视图和提醒 | 未实现 |
| L2 | 部门流程节点和待办 | 只读展示 |
| L3 | 对象、状态、规则和连接器 | 种子数据/只读 |
| L4 | 身份、权限、平台安全 | 本地简化实现 |

正式版本必须提供版本、沙箱、影响分析、发布和回滚。

## 9.1 当前 API 错误语义

错误响应结构：

```json
{
  "error": "可理解的错误说明",
  "code": "STABLE_ERROR_CODE",
  "details": {}
}
```

当前已覆盖：`WORKFLOW_NOT_FOUND`、`TITLE_REQUIRED`、`REQUIRED_FIELD`、`UNKNOWN_FIELDS`、`INVALID_FIELD_TYPE`、`INVALID_FIELD_VALUE`、`IDEMPOTENCY_CONFLICT`、`TASK_ALREADY_PROCESSED`、`RETURN_NOT_AVAILABLE`、`AGENT_SCOPE_DENIED`、`AGENT_RUN_NOT_PENDING`。

## 10. 迁移不变量

无论最终技术栈如何，以下不能改变：

1. 一个现实实体一个主对象。
2. 流程不复制业务对象。
3. 每个流程动作有审计。
4. U9、ERP、DCS 各守权威边界。
5. 数字员工独立身份和最小权限。
6. 高风险动作保留人工确认。
7. mock、真实连接和未连接状态必须明确。
8. 部门配置基于标准能力包，不产生私有后端。
