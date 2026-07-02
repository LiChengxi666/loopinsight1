import * as fs from 'fs'
import * as path from 'path'
import type { AgentState, GuardedAgentAction } from './AgentAdapter.js'

export type DemoPointForNightscout = {
    time: string
    glucose_mgdl: number
    carbs_g_per_min?: number
    exercise_percent?: number
    insulin_u_per_hr?: number
    bolus_u?: number
    agent_state?: AgentState
    agent_action?: GuardedAgentAction
}

export type NightscoutScenario = {
    meals: Array<{
        start: string
        duration_min: number
        carbs_g: number
        announced_at?: string
    }>
    exercise: Array<{
        start: string
        duration_min: number
        intensity_percent: number
    }>
}

export type NightscoutAdapterOptions = {
    outputDir: string
    points: DemoPointForNightscout[]
    summary: {
        basal_u_per_hr?: number
        simulation_window?: {
            start: string
            end: string
        }
        scenario?: NightscoutScenario
    }
    device?: string
    enteredBy?: string
    timezone?: string
    profileName?: string
    assumptions?: {
        carbRatioGPerU?: number
        insulinSensitivityMgdlPerU?: number
        targetMgdl?: number
        diaHours?: number
    }
}

export type NightscoutEntry = {
    type: 'sgv'
    date: number
    dateString: string
    created_at: string
    sgv: number
    direction: string
    device: string
    units: 'mg/dl'
}

export type NightscoutTreatment = {
    eventType: string
    created_at: string
    date: number
    enteredBy: string
    glucose?: number
    glucoseType?: 'Sensor'
    carbs?: number
    insulin?: number
    duration?: number
    absolute?: number
    rate?: number
    notes?: string
    reason?: string
}

export type NightscoutDeviceStatus = {
    device: string
    created_at: string
    date: number
    openaps: {
        suggested: {
            timestamp: string
            bg: number | null
            tick: string
            eventualBG?: number | null
            targetBG?: number
            insulinReq?: number
            rate?: number
            duration?: number
            reason: string
            safetyFlags: string[]
        }
        enacted?: {
            timestamp: string
            rate?: number
            duration?: number
            bolus?: number
            received: boolean
            reason: string
        }
    }
}

export type NightscoutProfile = {
    units: 'mg/dL'
    startDate: string
    defaultProfile: string
    store: {
        [profileName: string]: {
            units: 'mg/dL'
            dia: number
            timezone: string
            basal: Array<ProfileScheduleEntry>
            sens: Array<ProfileScheduleEntry>
            carbratio: Array<ProfileScheduleEntry>
            target_low: Array<ProfileScheduleEntry>
            target_high: Array<ProfileScheduleEntry>
            carbs_hr: string
        }
    }
}

type ProfileScheduleEntry = {
    time: string
    timeAsSeconds: number
    value: number
}

export type NightscoutBundle = {
    entries: NightscoutEntry[]
    treatments: NightscoutTreatment[]
    profile: NightscoutProfile
    devicestatus: NightscoutDeviceStatus[]
}

export function writeNightscoutArtifacts(options: NightscoutAdapterOptions): NightscoutBundle {
    const bundle = buildNightscoutBundle(options)
    fs.mkdirSync(options.outputDir, { recursive: true })
    writeJson(options.outputDir, 'entries.json', bundle.entries)
    writeJson(options.outputDir, 'treatments.json', bundle.treatments)
    writeJson(options.outputDir, 'profile.json', [bundle.profile])
    writeJson(options.outputDir, 'devicestatus.json', bundle.devicestatus)
    writeJson(options.outputDir, 'bundle.json', bundle)
    writeNightscoutHtml(options.outputDir, bundle)
    return bundle
}

export function buildNightscoutBundle(options: NightscoutAdapterOptions): NightscoutBundle {
    return {
        entries: simulationToEntries(options.points, options.device ?? 'LoopInsighT1'),
        treatments: simulationToTreatments(options),
        profile: simulationToProfile(options),
        devicestatus: simulationToDeviceStatus(options),
    }
}

export function simulationToEntries(
    points: DemoPointForNightscout[],
    device: string,
): NightscoutEntry[] {
    return points.map(point => ({
        type: 'sgv',
        date: Date.parse(point.time),
        dateString: point.time,
        created_at: point.time,
        sgv: Math.round(point.glucose_mgdl),
        direction: trendToNightscoutDirection(point.agent_state?.trend_mgdl_per_min ?? null),
        device,
        units: 'mg/dl',
    }))
}

export function simulationToTreatments(options: NightscoutAdapterOptions): NightscoutTreatment[] {
    const enteredBy = options.enteredBy ?? 'LoopInsighT1 AgentWorkflow'
    const treatments: NightscoutTreatment[] = []

    for (const point of options.points) {
        if ((point.bolus_u ?? 0) <= 0) continue
        const meal = point.agent_state?.pending_meals[0]
        treatments.push({
            eventType: meal ? 'Meal Bolus' : 'Correction Bolus',
            created_at: point.time,
            date: Date.parse(point.time),
            enteredBy,
            glucose: Math.round(point.glucose_mgdl),
            glucoseType: 'Sensor',
            carbs: meal?.carbs,
            insulin: round(point.bolus_u!, 2),
            notes: 'Generated from AgentAdapterController output after safety gate.',
        })
    }

    for (const exercise of options.summary.scenario?.exercise ?? []) {
        treatments.push({
            eventType: 'Exercise',
            created_at: exercise.start,
            date: Date.parse(exercise.start),
            enteredBy,
            duration: exercise.duration_min,
            notes: `Intensity ${exercise.intensity_percent}%`,
        })
    }

    return treatments.sort((a, b) => a.date - b.date)
}

export function simulationToProfile(options: NightscoutAdapterOptions): NightscoutProfile {
    const assumptions = normalizeAssumptions(options.assumptions)
    const profileName = options.profileName ?? 'LoopInsighT1 Demo'
    const startDate = options.summary.simulation_window?.start ?? options.points[0]?.time ?? new Date(0).toISOString()
    const basal = round(options.summary.basal_u_per_hr ?? inferBasalRate(options.points), 3)

    return {
        units: 'mg/dL',
        startDate,
        defaultProfile: profileName,
        store: {
            [profileName]: {
                units: 'mg/dL',
                dia: assumptions.diaHours,
                timezone: options.timezone ?? 'UTC',
                carbs_hr: '0',
                basal: [scheduleEntry('00:00', basal)],
                sens: [scheduleEntry('00:00', assumptions.insulinSensitivityMgdlPerU)],
                carbratio: [scheduleEntry('00:00', assumptions.carbRatioGPerU)],
                target_low: [scheduleEntry('00:00', assumptions.targetMgdl)],
                target_high: [scheduleEntry('00:00', assumptions.targetMgdl)],
            },
        },
    }
}

export function simulationToDeviceStatus(options: NightscoutAdapterOptions): NightscoutDeviceStatus[] {
    const device = options.device ?? 'LoopInsighT1'
    const basal = round(options.summary.basal_u_per_hr ?? inferBasalRate(options.points), 3)
    return options.points
        .filter(point => point.agent_state)
        .map(point => {
            const state = point.agent_state!
            const rawAction = point.agent_action ?? fallbackAgentAction(point)
            const insulinReq = point.bolus_u ?? rawAction.bolus_u
            const basalRate = rawAction.basal_u_per_hr ?? basal
            const safetyFlags = rawAction.safety_flags ?? []
            const suggested = {
                timestamp: point.time,
                bg: state.current_glucose_mgdl === null ? null : Math.round(state.current_glucose_mgdl),
                tick: trendTick(state.trend_mgdl_per_min),
                eventualBG: null,
                targetBG: normalizeAssumptions(options.assumptions).targetMgdl,
                insulinReq: insulinReq === undefined ? undefined : round(insulinReq, 2),
                rate: rawAction.kind === 'suggest_basal' ? basalRate : undefined,
                duration: rawAction.kind === 'suggest_basal' ? 30 : undefined,
                reason: rawAction.explanation ?? 'No agent action.',
                safetyFlags,
            }

            const enacted = rawAction.allowed && (point.bolus_u || rawAction.kind === 'suggest_basal')
                ? {
                    timestamp: point.time,
                    rate: rawAction.kind === 'suggest_basal' ? basalRate : undefined,
                    duration: rawAction.kind === 'suggest_basal' ? 30 : undefined,
                    bolus: point.bolus_u,
                    received: true,
                    reason: rawAction.explanation ?? 'Agent action enacted.',
                }
                : undefined

            return {
                device,
                created_at: point.time,
                date: Date.parse(point.time),
                openaps: {
                    suggested,
                    enacted,
                },
            }
        })
}

function fallbackAgentAction(point: DemoPointForNightscout): GuardedAgentAction {
    return {
        kind: point.bolus_u ? 'suggest_bolus' : 'no_action',
        bolus_u: point.bolus_u,
        confidence: 'low',
        explanation: point.bolus_u
            ? `Delivered bolus ${round(point.bolus_u, 2)} U.`
            : 'No enacted bolus at this sample.',
        allowed: true,
        safety_flags: [] as string[],
        basal_u_per_hr: undefined as number | undefined,
    }
}

function writeNightscoutHtml(outputDir: string, bundle: NightscoutBundle) {
    const payload = JSON.stringify(bundle)
    fs.writeFileSync(path.join(outputDir, 'nightscout-report.html'), `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Nightscout-compatible Demo</title>
  <style>
    :root {
      --bg: #0b1720;
      --panel: #122331;
      --line: #54c6eb;
      --target: rgba(104, 190, 114, .18);
      --text: #edf7fb;
      --muted: #92a9b7;
      --meal: #f0b44c;
      --bolus: #d78df0;
      --exercise: #79d68b;
      --grid: rgba(255,255,255,.12);
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { width: min(1200px, calc(100vw - 28px)); margin: 22px auto 36px; }
    header { display: flex; justify-content: space-between; gap: 16px; align-items: end; margin-bottom: 14px; }
    h1 { margin: 0; font-size: 24px; font-weight: 650; }
    .sub { color: var(--muted); font-size: 13px; margin-top: 4px; }
    .pill { border: 1px solid var(--grid); border-radius: 999px; padding: 6px 10px; color: var(--muted); font-size: 12px; }
    .metrics { display: grid; grid-template-columns: repeat(4, minmax(0,1fr)); gap: 10px; margin: 12px 0; }
    .metric, .panel { background: var(--panel); border: 1px solid var(--grid); border-radius: 8px; }
    .metric { padding: 10px; min-height: 68px; }
    .metric b { display: block; font-size: 22px; margin-bottom: 2px; }
    .metric span { color: var(--muted); font-size: 12px; }
    .panel { padding: 12px; }
    canvas { display: block; width: 100%; height: 520px; }
    .timeline { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 10px; }
    h2 { margin: 0 0 8px; font-size: 15px; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    td, th { border-top: 1px solid var(--grid); padding: 7px 6px; text-align: left; vertical-align: top; }
    th { color: var(--muted); font-weight: 500; }
    @media (max-width: 800px) { .metrics, .timeline { grid-template-columns: 1fr; } header { display: block; } canvas { height: 420px; } }
  </style>
</head>
<body>
<main>
  <header>
    <div>
      <h1>Nightscout-compatible T1D Demo</h1>
      <div class="sub">entries / treatments / profile / devicestatus generated from LoopInsighT1 AgentWorkflow</div>
    </div>
    <div class="pill" id="range"></div>
  </header>
  <section class="metrics" id="metrics"></section>
  <section class="panel"><canvas id="chart" width="1160" height="520"></canvas></section>
  <section class="timeline">
    <div class="panel">
      <h2>Treatments</h2>
      <table id="treatments"><thead><tr><th>Time</th><th>Type</th><th>Details</th></tr></thead><tbody></tbody></table>
    </div>
    <div class="panel">
      <h2>Profile</h2>
      <table id="profile"><tbody></tbody></table>
    </div>
  </section>
</main>
<script>
const bundle = ${payload};
const entries = bundle.entries;
const treatments = bundle.treatments;
const profile = bundle.profile.store[bundle.profile.defaultProfile];
const canvas = document.getElementById('chart');
const ctx = canvas.getContext('2d');
const margin = { left: 58, right: 20, top: 22, bottom: 44 };
const start = entries[0].date;
const end = entries[entries.length - 1].date;
const minY = 50;
const maxY = Math.max(260, Math.ceil(Math.max(...entries.map(e => e.sgv)) / 20) * 20);
function xOf(ms) { return margin.left + (ms - start) / (end - start) * (canvas.width - margin.left - margin.right); }
function yOf(v) { return margin.top + (maxY - v) / (maxY - minY) * (canvas.height - margin.top - margin.bottom); }
function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = getCss('--target');
  ctx.fillRect(margin.left, yOf(180), canvas.width - margin.left - margin.right, yOf(70) - yOf(180));
  ctx.strokeStyle = getCss('--grid');
  ctx.fillStyle = getCss('--muted');
  ctx.font = '12px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif';
  for (const v of [50, 70, 100, 140, 180, 220, 260]) {
    const y = yOf(v);
    ctx.beginPath(); ctx.moveTo(margin.left, y); ctx.lineTo(canvas.width - margin.right, y); ctx.stroke();
    ctx.fillText(String(v), 14, y + 4);
  }
  for (let h = 0; h <= 24; h += 3) {
    const x = margin.left + h / 24 * (canvas.width - margin.left - margin.right);
    ctx.beginPath(); ctx.moveTo(x, margin.top); ctx.lineTo(x, canvas.height - margin.bottom); ctx.stroke();
    ctx.fillText(String((6 + h) % 24).padStart(2, '0') + ':00', x - 17, canvas.height - 16);
  }
  for (const t of treatments) {
    const x = xOf(t.date);
    ctx.strokeStyle = t.eventType === 'Exercise' ? getCss('--exercise') : getCss('--meal');
    ctx.beginPath(); ctx.moveTo(x, margin.top); ctx.lineTo(x, canvas.height - margin.bottom); ctx.stroke();
    if (t.insulin) {
      const e = entries.reduce((best, item) => Math.abs(item.date - t.date) < Math.abs(best.date - t.date) ? item : best, entries[0]);
      ctx.fillStyle = getCss('--bolus');
      ctx.beginPath(); ctx.arc(x, yOf(e.sgv), 5, 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.strokeStyle = getCss('--line');
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  entries.forEach((e, i) => i === 0 ? ctx.moveTo(xOf(e.date), yOf(e.sgv)) : ctx.lineTo(xOf(e.date), yOf(e.sgv)));
  ctx.stroke();
}
function renderMetrics() {
  const values = entries.map(e => e.sgv);
  const inRange = values.filter(v => v >= 70 && v <= 180).length;
  const items = [
    ['SGV samples', entries.length],
    ['Treatments', treatments.length],
    ['Mean SGV', Math.round(values.reduce((a,b)=>a+b,0)/values.length) + ' mg/dL'],
    ['TIR', Math.round(inRange / values.length * 1000) / 10 + '%'],
  ];
  document.getElementById('metrics').innerHTML = items.map(([label, value]) => '<div class="metric"><b>' + value + '</b><span>' + label + '</span></div>').join('');
  document.getElementById('range').textContent = new Date(start).toISOString() + ' - ' + new Date(end).toISOString();
}
function renderTables() {
  document.querySelector('#treatments tbody').innerHTML = treatments.map(t => {
    const details = [
      t.carbs ? t.carbs + 'g carbs' : '',
      t.insulin ? t.insulin + 'U insulin' : '',
      t.duration ? t.duration + ' min' : '',
      t.notes || '',
    ].filter(Boolean).join(' · ');
    return '<tr><td>' + new Date(t.date).toISOString().slice(11,16) + '</td><td>' + t.eventType + '</td><td>' + details + '</td></tr>';
  }).join('');
  document.querySelector('#profile tbody').innerHTML = [
    ['Basal', profile.basal[0].value + ' U/h'],
    ['Carb ratio', profile.carbratio[0].value + ' g/U'],
    ['ISF', profile.sens[0].value + ' mg/dL/U'],
    ['Target', profile.target_low[0].value + ' mg/dL'],
    ['DIA', profile.dia + ' h'],
  ].map(row => '<tr><th>' + row[0] + '</th><td>' + row[1] + '</td></tr>').join('');
}
function getCss(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
renderMetrics();
renderTables();
draw();
</script>
</body>
</html>
`)
}

function writeJson(outputDir: string, filename: string, value: unknown) {
    fs.writeFileSync(path.join(outputDir, filename), JSON.stringify(value, null, 2))
}

function scheduleEntry(time: string, value: number): ProfileScheduleEntry {
    const [hours, minutes] = time.split(':').map(Number)
    return {
        time,
        timeAsSeconds: hours * 3600 + minutes * 60,
        value,
    }
}

function normalizeAssumptions(options: NightscoutAdapterOptions['assumptions'] = {}) {
    return {
        carbRatioGPerU: options.carbRatioGPerU ?? 18,
        insulinSensitivityMgdlPerU: options.insulinSensitivityMgdlPerU ?? 70,
        targetMgdl: options.targetMgdl ?? 130,
        diaHours: options.diaHours ?? 6,
    }
}

function inferBasalRate(points: DemoPointForNightscout[]): number {
    const values = points
        .filter(point => !point.bolus_u && (point.insulin_u_per_hr ?? 0) > 0)
        .map(point => point.insulin_u_per_hr!)
    if (values.length === 0) return 0
    const sorted = values.slice().sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length / 2)]
}

function trendToNightscoutDirection(trendMgdlPerMin: number | null): string {
    if (trendMgdlPerMin === null) return 'NONE'
    if (trendMgdlPerMin >= 3) return 'DoubleUp'
    if (trendMgdlPerMin >= 2) return 'SingleUp'
    if (trendMgdlPerMin >= 1) return 'FortyFiveUp'
    if (trendMgdlPerMin <= -3) return 'DoubleDown'
    if (trendMgdlPerMin <= -2) return 'SingleDown'
    if (trendMgdlPerMin <= -1) return 'FortyFiveDown'
    return 'Flat'
}

function trendTick(trendMgdlPerMin: number | null): string {
    if (trendMgdlPerMin === null) return '?'
    const tick = Math.round(trendMgdlPerMin * 5)
    return tick > 0 ? `+${tick}` : String(tick)
}

function round(value: number, digits = 2): number {
    const factor = Math.pow(10, digits)
    return Math.round(value * factor) / factor
}
