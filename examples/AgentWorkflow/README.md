# Agent workflow 示例

这个目录提供一层面向 Agent 开发的最小集成代码。

它主要做两件事：

1. 生成两个“一天级别”的 demo 数据：正常参考日和 I 型糖尿病日。
2. 提供稳定的 `AgentState -> AgentAction -> safety gate -> simulator output` 适配层。

重要范围说明：LoopInsighT1 是 I 型糖尿病仿真器，不包含经过验证的非糖尿病 β 细胞反馈模型。因此 `normal-reference-day` 输出的是确定性的正常参考曲线，主要用于 UI、State Builder 和 Agent 接口联调；`t1d-agent-day` 才是实际调用 LoopInsighT1 simulator 的路径。

## 运行

在仓库根目录执行：

```bash
npm install
npm run demo:agent
```

输出文件会写到：

```text
examples/AgentWorkflow/output/normal-reference-day.json
examples/AgentWorkflow/output/normal-reference-day.csv
examples/AgentWorkflow/output/t1d-agent-day.json
examples/AgentWorkflow/output/t1d-agent-day.csv
examples/AgentWorkflow/output/demo-report.html
```

其中 `demo-report.html` 是自包含可视化报告，直接在浏览器里打开即可查看正常参考日和 I 型糖尿病仿真日的血糖曲线、进食、运动和 bolus 标记。

## Demo 内容

两个 demo 都覆盖从 `2022-05-01T06:00:00Z` 到 `2022-05-02T06:00:00Z` 的一天。

正常参考日包含：

- 早餐：55 g 碳水。
- 午餐：70 g 碳水。
- 晚餐：65 g 碳水。
- 运动：下午 45 分钟中等强度运动。
- 不包含胰岛素字段，因为这是非糖尿病参考曲线。

I 型糖尿病日包含：

- 同样的三餐。
- 同样的运动事件。
- 基础胰岛素：来自虚拟患者的平衡基础率，并做了保守折减，随后通过 `StaticInsulinPump` 持续送入患者模型。
- 餐前大剂量：由 `AgentAdapterController` 使用保守 demo policy 生成。
- 在 bolus 真正进入 simulator 之前，会先经过 safety gate。

注意：当前 demo policy 只是集成测试用的简单策略，不是临床剂量算法，不能用于真实治疗建议。

### I 型糖尿病仿真的依据和完整性

`t1d-agent-day` 是完整走 LoopInsighT1 simulator 的患者仿真路径：

- 虚拟患者：`Deichmann2021`，对应 Deichmann et al. (2021) 的 I 型糖尿病运动治疗调整仿真模型。
- 患者输入：三餐碳水、基础胰岛素、餐前 bolus、运动强度。
- 患者输出：血浆葡萄糖 `Gp`，由 `IdealCGM` 作为确定性 CGM 读数提供给 agent。
- 给药路径：`AgentAdapterController` 生成 controller output，`StaticInsulinPump` 将基础率和 bolus 转换成实际胰岛素输入。
- 内置完整性校验：脚本会确认 1441 个 1 分钟采样点、三餐共 135 分钟碳水输入、45 分钟运动、全日连续胰岛素输入、3 次餐前 bolus、每分钟 agent state 完整。校验失败会直接抛错，不会静默生成结果。

输出 JSON 的 `summary.scientific_basis`、`summary.scenario`、`summary.model` 和 `summary.validation` 会记录这些信息，方便 benchmark 和 agent 侧追溯。

## Agent 接口约定

`AgentAdapter.ts` 定义了 Agent 侧优先使用的接口。

```ts
export type AgentState = {
    time: string
    current_glucose_mgdl: number | null
    trend_mgdl_per_min: number | null
    trend: 'rising' | 'falling' | 'stable' | 'unknown'
    pending_meals: AgentMeal[]
    recent_bolus_u: number
    minutes_since_last_bolus: number | null
    data_quality: 'complete' | 'missing_glucose'
    recent_risk: string[]
}

export type AgentAction = {
    kind: 'no_action' | 'warn' | 'suggest_bolus' | 'suggest_basal'
    bolus_u?: number
    basal_u_per_hr?: number
    explanation: string
    confidence: 'low' | 'medium' | 'high'
}
```

Agent 开发方只需要传入一个决策函数：

```ts
const controller = new AgentAdapterController({
    decide: (state) => {
        if (state.data_quality !== 'complete') {
            return {
                kind: 'warn',
                explanation: '血糖数据缺失。',
                confidence: 'high',
            }
        }

        return {
            kind: 'no_action',
            explanation: '暂不需要动作。',
            confidence: 'medium',
        }
    },
    basalRateUPerHour: 1.0,
    samplingTimeMin: 5,
    emitBolusToSimulator: false,
})
```

如果只测试“建议输出”，把 `emitBolusToSimulator` 设为 `false`。只有在需要让 simulator 真实接收 bolus 作为胰岛素输入时，才设为 `true`。

## Safety gate

当出现以下任一安全标记时，适配层会阻止 bolus 进入 simulator：

- `missing_glucose`
- `low_glucose`
- `fast_falling`
- `bolus_above_max`
- `recent_bolus`

Agent 原始建议仍会记录在 `controller.decisions` 和仿真结果的 `log.debug` 中，所以 benchmark 代码可以比较“原始建议”和“经过安全门后的动作”。

## 下一步建议

把 `mealBolusDemoPolicy` 替换成真实 Agent 调用。尽量保持输入/输出类型不变，这样 benchmark 脚本和前端展示可以继续消费同一套 JSON 文件。
