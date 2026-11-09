# AIDT 本地验证版测试证据

测试环境：Windows、Node.js `v24.18.0`、内置 SQLite、Microsoft Edge Headless  
最终测试时间：2026-10-27 23:48（Asia/Shanghai）  
服务准备：所有服务端修改完成后执行 `stop.ps1`，再由 `start.ps1` 拉起新进程，再执行测试。

## 一句话结论

核心闭环已通过自动化验证：业务对象、流程实例、自动待办、通过/退回/终止、条件进入/跳过、对象状态、审计、数字员工权限与人工确认均形成真实本地实现。

## 1. 语法检查

```powershell
node --check .\server.mjs
node --check .\public\app.js
node --check .\tests\api-smoke.mjs
node --check .\tests\browser-smoke.mjs
```

结果：4 项全部 PASS。

## 2. API 闭环测试

命令：

```powershell
node .\tests\api-smoke.mjs
```

结果：`PASS`

| 验证项 | 实际证据 | 状态 |
|---|---|---|
| 独立业务对象 | 样品实例 `inst-81db20d5-2066-4f46-a841-ccede4129365` 引用对象 `obj-record-4d584e66-44f0-423e-8585-3bdf954d5e19` | PASS |
| 对象字段来源 | 字段从 `business_objects.fields_json` 读取 | PASS |
| 对象反查流程 | 对象详情返回同一关联实例 | PASS |
| 字段校验 | 缺失必填、未知字段、错误数字类型、非法日期均返回 422 稳定错误码 | PASS |
| 发起幂等 | 首次 201；同键同内容 200 返回同一实例；同键不同内容 409 | PASS |
| 完整链路 1 | 客户样品到研发转产，6 节点后 `completed` | PASS |
| 完整链路 2 | 低金额采购到付款，6 节点后 `completed` | PASS |
| 完整链路 3 | 高金额采购到付款，7 节点后 `completed` | PASS |
| 条件跳过 | 1,200 元不进入“重大采购总经理审批”，完成审计记录跳过节点 | PASS |
| 条件进入 | 68,000 元进入“重大采购总经理审批” | PASS |
| 退回 | 客诉第二节点退回“客诉受理与分级”，生成新待办，实例保持运行 | PASS |
| 终止 | 退回后的任务终止，实例 `rejected`，对象状态 `已终止` | PASS |
| 审计动作 | 同一测试实例包含 `task.approve`、`instance.advanced`、`task.return`、`instance.returned`、`task.reject`、`instance.rejected` | PASS |
| 并发保护 | 同一任务两个并发请求，仅 1 个 200，另 1 个 409；只保留 1 个新待办 | PASS |
| 对象状态联动 | 样品对象状态最终 `已转产`，版本从 1 增至 7 | PASS |
| 数字员工独立身份 | A2 批次异常分析员，具备允许权限和禁止动作 | PASS |
| 数字员工范围 | 跨流程访问返回 403 `AGENT_SCOPE_DENIED` | PASS |
| 人工确认 | 运行先为 `pending_confirmation`，确认后 `confirmed` 并记录确认人 | PASS |
| 运行记录 | `/api/agent-runs?instanceId=...` 返回已确认运行 | PASS |
| 审计增长 | 测试前 9 条，测试后 92 条 | PASS |

机器可读结果：

- [api-smoke-result.json](./test-artifacts/api-smoke-result.json)

## 3. 浏览器与移动端测试

命令：

```powershell
node .\tests\browser-smoke.mjs
```

结果：`PASS`

| 验证项 | 实际结果 | 状态 |
|---|---|---|
| 首屏 | 加载层隐藏，6 个 KPI、4 个待办、6 类对象定义、4 条对象记录 | PASS |
| 桌面宽度 | 1440px，文档宽度 1440px，无横向溢出 | PASS |
| 导航 | 7 个导航页，0 失败 | PASS |
| 任务弹窗 | 通过、退回、终止 3 个动作；显示对象状态与流程证据入口 | PASS |
| 发起弹窗 | 4 个流程模板，动态生成 5 个对象字段 | PASS |
| 对象详情 | 展示字段、关联流程、对象审计和 `DCS-MOCK` 模拟边界 | PASS |
| 流程详情 | 展示 6 步时间线、对象字段、审计和数字员工记录 | PASS |
| 浏览器任务推进 | 批次实例新增任务记录，当前节点前进，保留 1 个待办，审计增加 3 条 | PASS |
| 数字员工 | 展示权限与禁止动作，人工确认后运行状态为 `confirmed`，确认审计存在 | PASS |
| 移动端首次加载 | 390×844，文档宽度 390px，侧栏默认收起 | PASS |
| 移动菜单 | 可打开、显示遮罩、可关闭 | PASS |
| 移动弹窗 | 弹窗宽约 349px，适配 390px 视口，无横向溢出 | PASS |
| 浏览器异常 | 未捕获异常 0，`console.error` 0 | PASS |

机器可读结果：

- [browser-smoke-result.json](./test-artifacts/browser-smoke-result.json)

视觉证据：

- [桌面驾驶舱](./test-artifacts/browser-desktop-dashboard.png)
- [流程步骤时间线与证据](./test-artifacts/browser-process-evidence.png)
- [业务对象详情与模拟边界](./test-artifacts/browser-object-detail.png)
- [数字员工人工确认](./test-artifacts/browser-agent-confirmation.png)
- [390px 移动端](./test-artifacts/browser-mobile-390.png)

## 4. SQLite 完整性

浏览器测试结束后执行演示数据重置，再检查数据库：

```json
{
  "integrity": "ok",
  "foreignKeys": [],
  "counts": {
    "objects": 4,
    "instances": 4,
    "tasks": 4,
    "audit_events": 9,
    "agent_runs": 0
  }
}
```

结果：SQLite `integrity_check = ok`，外键检查无违规；演示数据回到可直接展示的初始状态。

## 5. 当前已知限制

- 身份是演示用户头/前端选择，不是正式 SSO 或细粒度登录鉴权。
- U9、ERP、DCS、钉钉没有任何真实连接，全部为明确标识的 mock。
- 数字员工是规则化模拟，不调用外部大模型。
- A3 限额执行和 A4 自动闭环未启用。
- 没有生产级电子签名、备份恢复、集群和高可用。
- 没有真实 DCS 控制、付款、质量放行或已批准配方修改接口。

