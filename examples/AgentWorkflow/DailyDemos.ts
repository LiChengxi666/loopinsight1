import * as fs from 'fs'
import * as path from 'path'
import Simulator from '../../src/core/Simulator.js'
import StaticInsulinPump from '../../src/core/actuators/StaticInsulinPump.js'
import VirtualPatientDeichmann from '../../src/core/models/Deichmann2021.js'
import IdealCGM from '../../src/core/sensors/IdealCGM.js'
import type Exercise from '../../src/types/Exercise.js'
import type Meal from '../../src/types/Meal.js'
import type { SimulationResult } from '../../src/types/SimulationResult.js'
import { AgentAdapterController, mealBolusDemoPolicy } from './AgentAdapter.js'
import type { AgentState, GuardedAgentAction } from './AgentAdapter.js'
import { writeNightscoutArtifacts } from './NightscoutAdapter.js'

type DemoPoint = {
    time: string
    glucose_mgdl: number
    carbs_g_per_min?: number
    exercise_percent?: number
    insulin_u_per_hr?: number
    bolus_u?: number
    agent_state?: AgentState
    agent_action?: GuardedAgentAction
}

const outputDir = path.join(process.cwd(), 'examples', 'AgentWorkflow', 'output')
const simulationStart = '2022-05-01T06:00:00Z'
const simulationEnd = '2022-05-02T06:00:00Z'

const t1dScientificBasis = [
    'Virtual patient model: Deichmann et al. (2021), "Simulation-Based Evaluation of Treatment Adjustment to Exercise in Type 1 Diabetes", Frontiers in Endocrinology.',
    'The model exposes meal carbohydrate intake, subcutaneous insulin infusion, exercise intensity, and plasma glucose output.',
    'Sensor path: IdealCGM reads simulated plasma glucose without measurement noise for deterministic agent integration testing.',
    'Actuator path: StaticInsulinPump applies basal infusion and converts bolus doses to one-minute insulin infusion pulses.',
]

function main() {
    fs.mkdirSync(outputDir, { recursive: true })

    const normal = runNormalReferenceDay()
    writeDemo('normal-reference-day', normal.points, normal.summary)

    const t1d = runT1DAgentDay()
    writeDemo('t1d-agent-day', t1d.points, t1d.summary)
    const nightscout = writeNightscoutArtifacts({
        outputDir: path.join(outputDir, 'nightscout'),
        points: t1d.points,
        summary: t1d.summary,
        device: 'LoopInsighT1 AgentWorkflow',
        enteredBy: 'LoopInsighT1 AgentWorkflow',
        timezone: 'UTC',
        profileName: 'LoopInsighT1 Demo',
        assumptions: {
            carbRatioGPerU: 18,
            insulinSensitivityMgdlPerU: 70,
            targetMgdl: 130,
            diaHours: 6,
        },
    })
    writeHtmlReport(normal, t1d)

    console.log('Wrote demo outputs to', outputDir)
    console.log('Open visualization:', path.join(outputDir, 'demo-report.html'))
    console.log('Open Nightscout-compatible visualization:', path.join(outputDir, 'nightscout', 'nightscout-report.html'))
    console.log('Normal reference summary:', normal.summary)
    console.log('T1D agent summary:', t1d.summary)
    console.log('Nightscout artifact summary:', {
        entries: nightscout.entries.length,
        treatments: nightscout.treatments.length,
        devicestatus: nightscout.devicestatus.length,
        profile: nightscout.profile.defaultProfile,
    })
}

function runNormalReferenceDay() {
    const t0 = new Date(simulationStart)
    const points: DemoPoint[] = []
    for (let minute = 0; minute <= 24 * 60; minute += 5) {
        const t = new Date(t0.valueOf() + minute * 60e3)
        const glucose = normalReferenceGlucose(minute)
        const state = buildReferenceAgentState(points, t, glucose)
        points.push({
            time: t.toISOString(),
            glucose_mgdl: round(glucose),
            carbs_g_per_min: normalCarbRate(minute),
            exercise_percent: normalExercise(minute),
            agent_state: state,
        })
    }

    return {
        points,
        summary: summarize(points, 'normal-reference'),
    }
}

function runT1DAgentDay() {
    const sim = new Simulator()
    const patient = new VirtualPatientDeichmann()
    const basalRate = patient.getPatientProfile().IIReq * 0.85
    const controller = new AgentAdapterController({
        decide: mealBolusDemoPolicy,
        basalRateUPerHour: basalRate,
        samplingTimeMin: 5,
        minBolusIntervalMin: 120,
        maxBolusU: 8,
        emitBolusToSimulator: true,
    })

    sim.setPatient(patient)
    sim.setController(controller)
    sim.setSensor(new IdealCGM())
    sim.setActuator(new StaticInsulinPump())
    sim.setMeals(demoMeals())
    sim.setExerciseUnits(demoExercise())
    sim.setOptions({
        t0: new Date(simulationStart),
        tmax: new Date(simulationEnd),
        dt: 1,
        seed: 42,
    })

    const results = sim.runSimulation()
    const points = results.map((result, index) => toDemoPoint(result, controller, index))
    const validation = validateT1DDay(points)

    const scenario = {
        meals: demoMeals().map(item => ({
            start: item.start.toISOString(),
            duration_min: item.duration ?? 0,
            carbs_g: item.carbs,
            announced_at: item.announcement?.time.toISOString(),
        })),
        exercise: demoExercise().map(item => ({
            start: item.start.toISOString(),
            duration_min: item.duration,
            intensity_percent: item.intensity,
        })),
    }

    return {
        points,
        summary: {
            ...summarize(points, 't1d-agent'),
            model: patient.getModelInfo(),
            sensor: 'IdealCGM',
            actuator: 'StaticInsulinPump',
            simulation_window: {
                start: simulationStart,
                end: simulationEnd,
                dt_min: 1,
                seed: 42,
            },
            scenario,
            scientific_basis: t1dScientificBasis,
            basal_u_per_hr: round(basalRate, 3),
            bolus_events: points.filter(point => (point.bolus_u ?? 0) > 0).map(point => ({
                time: point.time,
                bolus_u: point.bolus_u,
            })),
            validation,
        },
    }
}

function demoMeals(): Meal[] {
    return [
        meal('2022-05-01T08:00:00Z', 45, 55, 15),
        meal('2022-05-01T13:00:00Z', 45, 70, 15),
        meal('2022-05-01T19:00:00Z', 45, 65, 15),
    ]
}

function demoExercise(): Exercise[] {
    return [
        {
            start: new Date('2022-05-01T16:30:00Z'),
            duration: 45,
            intensity: 25,
        },
    ]
}

function meal(start: string, duration: number, carbs: number, announcementLeadMin: number): Meal {
    const startDate = new Date(start)
    return {
        start: startDate,
        duration,
        carbs,
        announcement: {
            start: startDate,
            carbs,
            time: new Date(startDate.valueOf() - announcementLeadMin * 60e3),
        },
    }
}

function normalReferenceGlucose(minute: number): number {
    const baseline = 88 + 4 * Math.sin((minute - 90) / 1440 * 2 * Math.PI)
    const breakfast = gaussian(minute, 150, 38, 28)
    const lunch = gaussian(minute, 445, 43, 33)
    const dinner = gaussian(minute, 805, 48, 34)
    const exerciseDip = gaussian(minute, 705, 55, -13)
    const overnightDrift = minute > 960 ? -0.01 * (minute - 960) : 0
    return clamp(baseline + breakfast + lunch + dinner + exerciseDip + overnightDrift, 72, 145)
}

function normalCarbRate(minute: number): number {
    const meals = [
        { start: 120, duration: 30, carbs: 55 },
        { start: 420, duration: 35, carbs: 70 },
        { start: 780, duration: 35, carbs: 65 },
    ]
    const active = meals.find(item => minute >= item.start && minute < item.start + item.duration)
    return active ? round(active.carbs / active.duration, 3) : 0
}

function normalExercise(minute: number): number {
    return minute >= 690 && minute < 735 ? 45 : 0
}

function buildReferenceAgentState(previous: DemoPoint[], t: Date, glucose: number): AgentState {
    const last = previous.at(-1)
    const trend = last
        ? (glucose - last.glucose_mgdl) / ((t.valueOf() - new Date(last.time).valueOf()) / 60e3)
        : null
    return {
        time: t.toISOString(),
        current_glucose_mgdl: round(glucose),
        trend_mgdl_per_min: trend === null ? null : round(trend, 3),
        trend: trend === null ? 'unknown' : trend > 1 ? 'rising' : trend < -1 ? 'falling' : 'stable',
        pending_meals: [],
        recent_bolus_u: 0,
        minutes_since_last_bolus: null,
        data_quality: 'complete',
        recent_risk: [],
    }
}

function toDemoPoint(
    result: SimulationResult,
    controller: AgentAdapterController,
    index: number
): DemoPoint {
    const glucose = result.s.CGM ?? result.s.SMBG ?? result.y.Gp
    const decision = controller.decisions[index]
    return {
        time: result.t.toISOString(),
        glucose_mgdl: round(glucose),
        carbs_g_per_min: round(result.u.carbs ?? 0, 3),
        exercise_percent: result.u.exercise ?? 0,
        insulin_u_per_hr: round(result.u.iir ?? 0, 3),
        bolus_u: decision?.output.ibolus,
        agent_state: decision?.state,
        agent_action: decision?.action,
    }
}

function writeDemo(name: string, points: DemoPoint[], summary: object) {
    fs.writeFileSync(
        path.join(outputDir, `${name}.json`),
        JSON.stringify({ summary, points }, null, 2)
    )
    fs.writeFileSync(
        path.join(outputDir, `${name}.csv`),
        toCsv(points)
    )
}

function writeHtmlReport(
    normal: { points: DemoPoint[], summary: object },
    t1d: { points: DemoPoint[], summary: object },
) {
    const payload = JSON.stringify({
        normal: {
            summary: normal.summary,
            points: normal.points,
        },
        t1d: {
            summary: t1d.summary,
            points: t1d.points,
        },
    })

    fs.writeFileSync(path.join(outputDir, 'demo-report.html'), `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AgentWorkflow Demo Report</title>
  <style>
    :root {
      color-scheme: light;
      --text: #16202a;
      --muted: #66717e;
      --grid: #d9e0e7;
      --normal: #177ddc;
      --t1d: #d4380d;
      --meal: #8c5a00;
      --exercise: #237804;
      --bolus: #722ed1;
      --band: #f6ffed;
      --surface: #ffffff;
      --page: #f5f7fa;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--text);
      background: var(--page);
    }
    main {
      width: min(1180px, calc(100vw - 32px));
      margin: 24px auto 40px;
    }
    h1 { margin: 0 0 6px; font-size: 28px; }
    p { margin: 0; color: var(--muted); line-height: 1.5; }
    .summary {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
      margin: 18px 0;
    }
    .panel {
      background: var(--surface);
      border: 1px solid #e5eaf0;
      border-radius: 8px;
      padding: 14px;
    }
    .panel h2 {
      margin: 0 0 10px;
      font-size: 16px;
    }
    .metrics {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 8px;
    }
    .metric {
      border: 1px solid #edf1f5;
      border-radius: 6px;
      padding: 8px;
      min-height: 58px;
    }
    .metric b {
      display: block;
      font-size: 18px;
      margin-bottom: 2px;
    }
    .metric span {
      color: var(--muted);
      font-size: 12px;
    }
    .chart-panel {
      background: var(--surface);
      border: 1px solid #e5eaf0;
      border-radius: 8px;
      padding: 12px;
    }
    canvas {
      display: block;
      width: 100%;
      height: 520px;
    }
    .legend {
      display: flex;
      flex-wrap: wrap;
      gap: 14px;
      margin-top: 10px;
      color: var(--muted);
      font-size: 13px;
    }
    .key { display: inline-flex; align-items: center; gap: 6px; }
    .swatch {
      width: 22px;
      height: 3px;
      border-radius: 999px;
      background: currentColor;
    }
    @media (max-width: 760px) {
      .summary { grid-template-columns: 1fr; }
      .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      canvas { height: 420px; }
    }
  </style>
</head>
<body>
<main>
  <h1>AgentWorkflow Demo 可视化</h1>
  <p>蓝线为正常参考日，红线为 I 型糖尿病仿真日。浅绿色区域是 70-180 mg/dL 范围；棕色竖线是进食，绿色竖线是运动，紫色点是 bolus。</p>
  <section class="summary">
    <div class="panel">
      <h2>正常参考日</h2>
      <div id="normalMetrics" class="metrics"></div>
    </div>
    <div class="panel">
      <h2>I 型糖尿病仿真日</h2>
      <div id="t1dMetrics" class="metrics"></div>
    </div>
  </section>
  <section class="chart-panel">
    <canvas id="chart" width="1160" height="520"></canvas>
    <div class="legend">
      <span class="key" style="color: var(--normal)"><span class="swatch"></span>正常参考血糖</span>
      <span class="key" style="color: var(--t1d)"><span class="swatch"></span>I 型糖尿病血糖</span>
      <span class="key" style="color: var(--meal)"><span class="swatch"></span>进食</span>
      <span class="key" style="color: var(--exercise)"><span class="swatch"></span>运动</span>
      <span class="key" style="color: var(--bolus)"><span class="swatch"></span>bolus</span>
    </div>
  </section>
</main>
<script>
const data = ${payload};
const canvas = document.getElementById('chart');
const ctx = canvas.getContext('2d');
const css = getComputedStyle(document.documentElement);
const colors = {
  text: css.getPropertyValue('--text').trim(),
  muted: css.getPropertyValue('--muted').trim(),
  grid: css.getPropertyValue('--grid').trim(),
  band: css.getPropertyValue('--band').trim(),
  normal: css.getPropertyValue('--normal').trim(),
  t1d: css.getPropertyValue('--t1d').trim(),
  meal: css.getPropertyValue('--meal').trim(),
  exercise: css.getPropertyValue('--exercise').trim(),
  bolus: css.getPropertyValue('--bolus').trim(),
};
const margin = { left: 58, right: 22, top: 22, bottom: 46 };
const start = new Date(data.t1d.points[0].time).getTime();
const end = new Date(data.t1d.points[data.t1d.points.length - 1].time).getTime();
const yMin = 50;
const yMax = 280;

function xOf(time) {
  return margin.left + (new Date(time).getTime() - start) / (end - start) * (canvas.width - margin.left - margin.right);
}
function yOf(value) {
  return margin.top + (yMax - value) / (yMax - yMin) * (canvas.height - margin.top - margin.bottom);
}
function drawGrid() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = colors.band;
  ctx.fillRect(margin.left, yOf(180), canvas.width - margin.left - margin.right, yOf(70) - yOf(180));
  ctx.strokeStyle = colors.grid;
  ctx.lineWidth = 1;
  ctx.font = '12px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif';
  ctx.fillStyle = colors.muted;
  for (const value of [50, 70, 100, 140, 180, 220, 260]) {
    const y = yOf(value);
    ctx.beginPath();
    ctx.moveTo(margin.left, y);
    ctx.lineTo(canvas.width - margin.right, y);
    ctx.stroke();
    ctx.fillText(String(value), 16, y + 4);
  }
  for (let hour = 0; hour <= 24; hour += 3) {
    const x = margin.left + hour / 24 * (canvas.width - margin.left - margin.right);
    ctx.beginPath();
    ctx.moveTo(x, margin.top);
    ctx.lineTo(x, canvas.height - margin.bottom);
    ctx.stroke();
    ctx.fillText(String((6 + hour) % 24).padStart(2, '0') + ':00', x - 18, canvas.height - 18);
  }
  ctx.fillStyle = colors.text;
  ctx.fillText('mg/dL', 14, 18);
}
function drawLine(points, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  points.forEach((point, index) => {
    const x = xOf(point.time);
    const y = yOf(point.glucose_mgdl);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}
function drawEvents(points) {
  const seenMeals = new Set();
  ctx.lineWidth = 1.5;
  for (const point of points) {
    if ((point.carbs_g_per_min || 0) > 0) {
      const key = point.time.slice(0, 16);
      if (!seenMeals.has(key)) {
        seenMeals.add(key);
        const x = xOf(point.time);
        ctx.strokeStyle = colors.meal;
        ctx.beginPath();
        ctx.moveTo(x, margin.top);
        ctx.lineTo(x, canvas.height - margin.bottom);
        ctx.stroke();
      }
    }
    if ((point.exercise_percent || 0) > 0) {
      const x = xOf(point.time);
      ctx.strokeStyle = colors.exercise;
      ctx.beginPath();
      ctx.moveTo(x, margin.top);
      ctx.lineTo(x, canvas.height - margin.bottom);
      ctx.stroke();
    }
    if ((point.bolus_u || 0) > 0) {
      ctx.fillStyle = colors.bolus;
      ctx.beginPath();
      ctx.arc(xOf(point.time), yOf(point.glucose_mgdl), 5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
function renderMetrics(id, summary) {
  const el = document.getElementById(id);
  const items = [
    ['最低', summary.min_glucose_mgdl + ' mg/dL'],
    ['最高', summary.max_glucose_mgdl + ' mg/dL'],
    ['均值', summary.mean_glucose_mgdl + ' mg/dL'],
    ['TIR', summary.time_in_70_180_percent + '%'],
  ];
  el.innerHTML = items.map(([label, value]) => '<div class="metric"><b>' + value + '</b><span>' + label + '</span></div>').join('');
}
renderMetrics('normalMetrics', data.normal.summary);
renderMetrics('t1dMetrics', data.t1d.summary);
drawGrid();
drawEvents(data.t1d.points);
drawLine(data.normal.points, colors.normal);
drawLine(data.t1d.points, colors.t1d);
</script>
</body>
</html>
`)
}

function toCsv(points: DemoPoint[]): string {
    const header = [
        'time',
        'glucose_mgdl',
        'carbs_g_per_min',
        'exercise_percent',
        'insulin_u_per_hr',
        'bolus_u',
        'agent_action',
        'agent_allowed',
        'safety_flags',
        'trend',
        'risk',
    ]
    const rows = points.map(point => [
        point.time,
        point.glucose_mgdl,
        point.carbs_g_per_min ?? '',
        point.exercise_percent ?? '',
        point.insulin_u_per_hr ?? '',
        point.bolus_u ?? '',
        point.agent_action?.kind ?? '',
        point.agent_action?.allowed ?? '',
        point.agent_action?.safety_flags.join('|') ?? '',
        point.agent_state?.trend ?? '',
        point.agent_state?.recent_risk.join('|') ?? '',
    ])
    return [header, ...rows].map(row => row.join(',')).join('\n') + '\n'
}

function summarize(points: DemoPoint[], kind: string) {
    const values = points.map(point => point.glucose_mgdl)
    const inRange = values.filter(value => value >= 70 && value <= 180).length
    const low = values.filter(value => value < 70).length
    const high = values.filter(value => value > 180).length
    return {
        kind,
        samples: values.length,
        min_glucose_mgdl: round(Math.min(...values)),
        max_glucose_mgdl: round(Math.max(...values)),
        mean_glucose_mgdl: round(values.reduce((a, b) => a + b, 0) / values.length),
        time_in_70_180_percent: round(100 * inRange / values.length),
        time_below_70_percent: round(100 * low / values.length),
        time_above_180_percent: round(100 * high / values.length),
    }
}

function validateT1DDay(points: DemoPoint[]) {
    const validation = {
        expected_samples: 24 * 60 + 1,
        actual_samples: points.length,
        meal_active_minutes: points.filter(point => (point.carbs_g_per_min ?? 0) > 0).length,
        exercise_active_minutes: points.filter(point => (point.exercise_percent ?? 0) > 0).length,
        basal_or_bolus_insulin_minutes: points.filter(point => (point.insulin_u_per_hr ?? 0) > 0).length,
        bolus_count: points.filter(point => (point.bolus_u ?? 0) > 0).length,
        complete_agent_state_minutes: points.filter(point => point.agent_state?.data_quality === 'complete').length,
    }

    const failures = [
        validation.actual_samples !== validation.expected_samples && 'sample_count',
        validation.meal_active_minutes !== 135 && 'three_45_min_meals',
        validation.exercise_active_minutes !== 45 && 'one_45_min_exercise',
        validation.basal_or_bolus_insulin_minutes !== validation.expected_samples && 'continuous_insulin_delivery',
        validation.bolus_count !== 3 && 'three_meal_boluses',
        validation.complete_agent_state_minutes !== validation.expected_samples && 'complete_agent_state',
    ].filter(Boolean)

    if (failures.length > 0) {
        throw new Error(`T1D demo validation failed: ${failures.join(', ')}`)
    }

    return {
        ...validation,
        status: 'passed',
    }
}

function gaussian(x: number, center: number, width: number, amplitude: number): number {
    return amplitude * Math.exp(-0.5 * Math.pow((x - center) / width, 2))
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value))
}

function round(value: number, digits = 2): number {
    const factor = Math.pow(10, digits)
    return Math.round(value * factor) / factor
}

main()
