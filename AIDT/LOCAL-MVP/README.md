# AIDT 企业业务操作系统 · Windows 本地验证版

这是一个**可弃型纵向样板**，用于在最终技术栈尚未确定前，验证 AIDT 的核心业务闭环：

> 业务对象 → 流程实例 → 自动生成待办 → 人工审批/退回 → 条件节点 → 审计证据 → 数字员工辅助。

它不是生产系统，也不连接真实 U9、ERP、DCS 或外部大模型。

## 一分钟启动

在 PowerShell 中执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\start.ps1
```

浏览器会打开：

```text
http://127.0.0.1:4173/
```

停止：

```powershell
powershell -ExecutionPolicy Bypass -File .\stop.ps1
```

前置条件：Node.js 24+。本机已验证 Node.js 24.18.0；不需要安装 npm 依赖。

## 当前已实现

- 6 类业务对象定义和独立 `business_objects` 主对象记录；流程实例通过 `object_id` 引用对象，不复制业务字段。
- 4 条标准流程：样品到转产、批次异常到 CAPA、采购到付款、客诉到 CAPA。
- 流程实例、待办、通过、退回、终止、条件进入/跳过及对象状态联动。
- 服务端字段校验、结构化错误码、发起幂等键和任务并发保护。
- 流程详情、步骤时间线、对象字段、审计证据、对象反查关联流程。
- 数字员工 A0—A4 独立身份、允许/禁止权限、范围校验、模拟运行和人工确认。
- U9、ERP、DCS、钉钉 mock 连接器及能力边界。
- SQLite 本地数据库和完整审计事件流。
- 桌面与移动端响应式界面。

## 关键边界

- 财务权威仍在 U9；实时控制仍在 DCS；订单和计划仍在 ERP。
- AIDT 当前只提供统一业务对象、流程、协同、证据和智能辅助层。
- 所有外部系统均为 mock，界面明确显示“本地原型模式”。
- 数字员工运行结果是规则化模拟，不是真实大模型结论。
- 点击“重置演示”会清空当前本地操作数据并恢复种子数据。

## 目录

```text
AIDT-LOCAL-MVP/
├─ server.mjs                 # Node 原生 HTTP + SQLite 服务
├─ public/                    # 无构建步骤的前端
├─ data/aidt.db               # 首次启动自动创建
├─ tests/api-smoke.mjs        # 业务闭环测试
├─ tests/browser-smoke.mjs    # 浏览器交互与响应式测试
├─ docs/test-artifacts/       # 测试 JSON、桌面/移动截图
├─ prompts/                   # 目标模式提示词包
├─ docs/CONTRACTS.md          # 数据和接口契约
└─ task_plan.md/findings.md/progress.md
```

## 验证

先启动服务，再运行：

```powershell
node .\tests\api-smoke.mjs
node .\tests\browser-smoke.mjs
```

业务测试会验证三条完成链、低金额跳过与高金额进入、退回后终止、幂等冲突、并发推进、数字员工范围与人工确认、审计增长，最后重置演示数据。JSON 和桌面/移动截图保存在 `docs/test-artifacts/`。

## 通宵运行

1. 阅读 `prompts/00_MASTER_GOAL.md`，这是产品目标和不可破坏约束。
2. 将 `prompts/01_OVERNIGHT_RUN.md` 作为目标模式任务交给编码智能体。
3. 明早用 `prompts/02_MORNING_REVIEW.md` 验收。
4. 技术栈确定后，使用 `prompts/03_STACK_MIGRATION.md` 做迁移，不要重写业务契约。

## 重要提醒

本工程用于验证方法，不应直接承载真实配方、客户、成本或工艺数据。正式建设前需重新完成安全、权限、审计、备份、合规和技术栈评审。
