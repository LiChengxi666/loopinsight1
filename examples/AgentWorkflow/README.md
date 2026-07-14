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

运行“读取本地授权回放状态 → 生成候选 Plan → 多次仿真比较 → 输出隔离 Action”的参考规划闭环：

```bash
DEMO_NIGHTSCOUT_URL=https://your-nightscout.example \
DEMO_START=<start-iso> DEMO_END=<end-iso> \
npm run demo:real-data
npm run demo:planning-loop
```

闭环输出写入 `examples/AgentWorkflow/output/planning-loop.json`。它读取指定 Nightscout 日数据的末端确定性状态，但不会用该真实数据校准患者参数；四个候选 Plan 会在同一个 `Deichmann2021` 虚拟患者上分别重跑 24 小时场景。固定选择器先淘汰严重高/低血糖候选，再按 TBR、TIR、TAR 和 CV 风险分数选择。最终 Action 固定为 `human_review_only` 且 `executable=false`。

为避免回归测试产生仅由当前时间导致的 diff，可固定实时窗口结束时间：

```bash
DEMO_REALTIME_END_AT=2026-07-02T15:35:00.000Z npm run demo:agent
```

真实 Nightscout 日数据回放与确定性摘要（只保存在本地忽略目录）：

```bash
DEMO_NIGHTSCOUT_URL=https://your-nightscout.example \
DEMO_START=<start-iso> DEMO_END=<end-iso> \
npm run demo:real-data
```

必须通过 `DEMO_NIGHTSCOUT_URL` 提供本地地址，并可通过 `DEMO_START`、`DEMO_END` 指定窗口。输出写入被 Git 忽略的 `output/real-world-demo`。该路径可能保留真实 entries/treatments，禁止提交。

范围边界：真实日数据用于历史回放、State Builder 和报告 demo。没有完成个体参数辨识与验证之前，不能把它描述为已经校准的虚拟患者仿真。

在线患者状态初始化与双 Plan 闭环：

```bash
NIGHTSCOUT_URL=https://your-nightscout.example npm run demo:online-loop
```

该命令只发送 GET 请求。输出 `output/online-patient-loop.json` 含患者摘要并被 Git 忽略；仓库内不得保存真实 URL、凭据或产物。

在线闭环保持两个正式候选 Plan，但会额外输出不可执行的反事实补碳 sweep。正式候选只能使用患者已批准的补碳协议或确定性纠正剂量；反事实 sweep 只用于解释 LoopInsighT1 对 5/10/15/20 g 碳水的模拟响应，永远标记为 `research_counterfactual_only`，不能转成治疗建议。

在线预测输出会同时包含 30、60、120 分钟血糖点和最低值发生时间。AAPS `eventualBG` 不再被直接等同于 LoopInsighT1 的两小时最低值；如果 Nightscout 提供 OpenAPS `predBGs` 序列，门禁优先用该序列的最低预测值做外部模型一致性检查。如果只有 `eventualBG`，它只作为外部低血糖风险警报进入 `external_low_projection_unresolved`。

真实 NS 中 `Meal Bolus` 有胰岛素但 `carbs=null` 时，在线闭环会显式记录 `mealBolusWithoutCarbs` 和 `carbsInferenceDisabled`。正式候选不会伪造历史餐食；该信息会进入状态不确定性和 blockers，提醒 warm-start 可能缺少真实进食扰动。

输出文件会写到：

```text
examples/AgentWorkflow/output/normal-reference-day.json
examples/AgentWorkflow/output/normal-reference-day.csv
examples/AgentWorkflow/output/t1d-agent-day.json
examples/AgentWorkflow/output/t1d-agent-day.csv
examples/AgentWorkflow/output/demo-report.html
examples/AgentWorkflow/output/planning-loop.json
examples/AgentWorkflow/output/nightscout/entries.json
examples/AgentWorkflow/output/nightscout/treatments.json
examples/AgentWorkflow/output/nightscout/profile.json
examples/AgentWorkflow/output/nightscout/devicestatus.json
examples/AgentWorkflow/output/nightscout/bundle.json
examples/AgentWorkflow/output/nightscout/nightscout-report.html
examples/AgentWorkflow/output/nightscout-realtime/entries.json
examples/AgentWorkflow/output/nightscout-realtime/treatments.json
examples/AgentWorkflow/output/nightscout-realtime/profile.json
examples/AgentWorkflow/output/nightscout-realtime/devicestatus.json
examples/AgentWorkflow/output/nightscout-realtime/bundle.json
examples/AgentWorkflow/output/nightscout-realtime/nightscout-report.html
```

其中 `demo-report.html` 是自包含可视化报告，直接在浏览器里打开即可查看正常参考日和 I 型糖尿病仿真日的血糖曲线、进食、运动和 bolus 标记。

`output/nightscout` 下是 Nightscout-compatible 历史产物，保留仿真原始日期，适合在 Nightscout `/report` 里按日期范围回看。`output/nightscout-realtime` 使用同一段仿真结果，但把时间整体平移到当前时间窗口，适合导入本地 Nightscout 后直接在首页 `/` 查看实时 dashboard。

这两组 NS 产物默认都按现实世界 `5 min / step` 导出。它们不会自动写入远端 Nightscout 站点；如果要 POST 到真实 NS，需要调用方额外提供目标站点和写入凭据。`nightscout-report.html` 是本地 NS 风格展示页，用来确认 entries、treatments、profile 和 devicestatus 能被同一套 NS 语义消费。

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
- 内置完整性校验：脚本会确认 simulator 内部产生 1441 个 1 分钟积分点、三餐共 135 分钟碳水输入、45 分钟运动、全日连续胰岛素输入、3 次餐前 bolus、每分钟 agent state 完整。校验失败会直接抛错，不会静默生成结果。对外发给 NS 和 agent 展示的默认步长是现实世界 `5 min / step`。

输出 JSON 的 `summary.scientific_basis`、`summary.scenario`、`summary.model` 和 `summary.validation` 会记录这些信息，方便 benchmark 和 agent 侧追溯。

## Nightscout 适配输出

`NightscoutAdapter.ts` 把仿真结果转换成四类 NS 核心对象：

- `entries.json`：默认每 5 分钟一条 SGV，字段包含 `type=sgv`、`date`、`created_at`、`sgv`、`direction`、`units=mg/dl`。
- `treatments.json`：三次餐前 bolus 记录为 `Meal Bolus`，运动记录为 `Exercise`。基础率写入 profile，不按分钟写成 treatment。
- `profile.json`：包含 demo profile 的 basal、carb ratio、ISF、target 和 DIA。当前 demo policy 使用的假设是 `carbratio=18 g/U`、`sens=70 mg/dL/U`、`target=130 mg/dL`、`dia=6 h`。
- `devicestatus.json`：默认每 5 分钟记录一次 `openaps.suggested`；通过 safety gate 且实际执行的 bolus 会额外出现 `openaps.enacted`。

`NightscoutAdapterOptions.sampleIntervalMin` 可以覆盖导出步长，但没有特别说明时固定使用 `5`。`NightscoutAdapterOptions.timeShift.endAt` 可以把整段仿真平移到指定结束时间；`nightscout-realtime` 就是用这个能力让最后一个 SGV 落在当前 5 分钟边界附近，从而能在 Nightscout 首页实时视图显示。

这样 agent 可以继续负责读取真实 Nightscout；仿真端负责把“简单仿真”或“被 agent 操作后的仿真结果”导出成 NS 圈子熟悉的数据形态。

## 本地部署 Nightscout 并查看结果

下面流程用于把 demo 生成的 NS 产物导入一个本地 Nightscout 服务，验证 `/report` 历史报表和首页实时 dashboard 都能消费同一套仿真语义。

### 1. 启动本地 Nightscout

如果需要 clone Nightscout 仓库，建议 clone 到本仓库的上一级目录，避免混入当前项目：

```bash
cd ..
git clone https://github.com/nightscout/cgm-remote-monitor.git
cd loopinsight1
```

本地验证不需要修改 Nightscout 仓库。可以直接用 Docker 启动 MongoDB 和 Nightscout：

```bash
docker network create loopinsight-nightscout-net 2>/dev/null || true
docker volume create loopinsight-nightscout-mongo-data

docker rm -f loopinsight-nightscout-mongo loopinsight-nightscout 2>/dev/null || true

docker run -d \
  --name loopinsight-nightscout-mongo \
  --network loopinsight-nightscout-net \
  -v loopinsight-nightscout-mongo-data:/data/db \
  mongo:4.4

docker run -d \
  --name loopinsight-nightscout \
  --network loopinsight-nightscout-net \
  -p 1337:1337 \
  -e NODE_ENV=production \
  -e TZ=Etc/UTC \
  -e PORT=1337 \
  -e INSECURE_USE_HTTP=true \
  -e MONGO_CONNECTION=mongodb://loopinsight-nightscout-mongo:27017/nightscout \
  -e MONGODB_URI=mongodb://loopinsight-nightscout-mongo:27017/nightscout \
  -e API_SECRET='LoopInsightNSSecret2026!' \
  -e DISPLAY_UNITS=mmol \
  -e AUTH_DEFAULT_ROLES=readable \
  -e ENABLE='careportal rawbg iob cob basal profile bolus openaps pump loop devicestatus' \
  nightscout/cgm-remote-monitor:latest
```

确认服务启动：

```bash
curl -s http://localhost:1337/api/v1/status.json
```

返回里应包含 `status: "ok"`，并且 `settings.units` 是 `mmol`。

### 2. 导入 demo 数据

先生成 demo 和 NS 产物：

```bash
npm run demo:agent
```

然后把历史版和实时版都导入本地 Mongo。历史版用于 `/report` 按日期回看；实时版用于首页 `/` 显示当前窗口。

```bash
for dir in nightscout nightscout-realtime; do
  docker cp examples/AgentWorkflow/output/$dir/entries.json loopinsight-nightscout-mongo:/tmp/${dir}-entries.json
  docker cp examples/AgentWorkflow/output/$dir/treatments.json loopinsight-nightscout-mongo:/tmp/${dir}-treatments.json
  docker cp examples/AgentWorkflow/output/$dir/profile.json loopinsight-nightscout-mongo:/tmp/${dir}-profile.json
  docker cp examples/AgentWorkflow/output/$dir/devicestatus.json loopinsight-nightscout-mongo:/tmp/${dir}-devicestatus.json
done

docker exec loopinsight-nightscout-mongo mongo nightscout --quiet --eval \
  'db.entries.drop(); db.treatments.drop(); db.profile.drop(); db.devicestatus.drop();'

for dir in nightscout nightscout-realtime; do
  docker exec loopinsight-nightscout-mongo mongoimport --db nightscout --collection entries --file /tmp/${dir}-entries.json --jsonArray --quiet
  docker exec loopinsight-nightscout-mongo mongoimport --db nightscout --collection treatments --file /tmp/${dir}-treatments.json --jsonArray --quiet
  docker exec loopinsight-nightscout-mongo mongoimport --db nightscout --collection profile --file /tmp/${dir}-profile.json --jsonArray --quiet
  docker exec loopinsight-nightscout-mongo mongoimport --db nightscout --collection devicestatus --file /tmp/${dir}-devicestatus.json --jsonArray --quiet
done

docker restart loopinsight-nightscout
```

最后的 `docker restart` 很重要：Nightscout 首页使用服务启动时加载到内存的 runtime data；直接 `mongoimport` 后 API 能读到数据，但首页可能要重启服务后才会显示。

检查导入数量：

```bash
docker exec loopinsight-nightscout-mongo mongo nightscout --quiet --eval \
  '({entries: db.entries.countDocuments({}), treatments: db.treatments.countDocuments({}), profile: db.profile.countDocuments({}), devicestatus: db.devicestatus.countDocuments({})})'
```

当前 demo 同时导入历史版和实时版后，通常应看到 `entries=578`、`devicestatus=578`、`treatments=8`、`profile=2`。

### 3. 查看结果

历史报表：

1. 打开 `http://localhost:1337/report/`。
2. 选择 `From: 2022/05/01`、`To: 2022/05/02`。
3. 点击 `SHOW`，查看 `Day to day` 曲线、三餐 bolus、运动事件和 profile 标记。

实时 dashboard：

1. 打开 `http://localhost:1337/`。
2. 首页应显示黑底实时视图，单位为 `mmol/L`。
3. 因为 `nightscout-realtime` 会把最后一个 SGV 平移到当前 5 分钟边界附近，首页会显示类似 `5 mins ago` 的当前数据。

也可以用 CLI 直接确认：

```bash
curl -g -s 'http://localhost:1337/api/v1/entries/sgv.json?count=5'
curl -g -s 'http://localhost:1337/api/v1/treatments.json?count=10'
curl -s 'http://localhost:1337/pebble?count=3'
```

其中 `/pebble` 是首页实时视图会消费的聚合数据；如果 `/api/v1/entries` 有数据但 `/pebble` 的 `bgs` 为空，通常说明 Nightscout 需要在导入后重启一次。

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
