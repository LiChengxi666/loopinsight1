import * as fs from 'fs'
import * as path from 'path'
import Simulator from '../../src/core/Simulator.js'
import AbstractController from '../../src/core/AbstractController.js'
import StaticInsulinPump from '../../src/core/actuators/StaticInsulinPump.js'
import VirtualPatientDeichmann from '../../src/core/models/Deichmann2021.js'
import IdealCGM from '../../src/core/sensors/IdealCGM.js'
import type { AnnouncementList, ControllerOutput, Measurement, TracedMeasurement } from '../../src/types/Controller.js'
import type Controller from '../../src/types/Controller.js'
import type Meal from '../../src/types/Meal.js'
import type { ModuleProfile } from '../../src/types/ModuleProfile.js'
import type { ParameterDescriptions } from '../../src/types/ParametricModule.js'
import type { PatientState } from '../../src/types/Patient.js'

const MINUTE = 60e3
const HOUR = 60 * MINUTE
const WARMUP_HOURS = 6
const FORECAST_HOURS = 2
const MAX_CALIBRATION_RMSE = Number(process.env.MAX_CALIBRATION_RMSE_MGDL ?? 25)

type Entry = { sgv: number, date: number, dateString?: string }
type Treatment = {
    eventType?: string
    created_at?: string
    timestamp?: string
    insulin?: number
    carbs?: number
    duration?: number
    durationInMilliseconds?: number
    absolute?: number
    rate?: number
    pumpId?: number
    endId?: number
    endmills?: number
}
type ScheduleEntry = { time?: string, value: number, timeAsSeconds: number }
type ProfileStore = {
    basal: ScheduleEntry[]
    sens: ScheduleEntry[]
    carbratio: ScheduleEntry[]
    target_low: ScheduleEntry[]
    target_high: ScheduleEntry[]
    timezone?: string
    dia?: number
    units?: string
}
type Profile = { defaultProfile?: string, store?: Record<string, ProfileStore> }
type DeviceStatus = {
    created_at?: string
    loop?: { iob?: { iob?: number, timestamp?: string }, cob?: { cob?: number, timestamp?: string } }
    openaps?: {
        iob?: { iob?: number, activity?: number, basaliob?: number, time?: string }
        suggested?: {
            COB?: number
            eventualBG?: number
            timestamp?: string
            rate?: number
            predBGs?: Record<string, number[]>
        }
    }
    pump?: { suspended?: boolean }
}

type OnlineInput = {
    sourceUrl: string
    asOf: Date
    entries: Entry[]
    treatments: Treatment[]
    profile: Profile
    profileStore: ProfileStore
    deviceStatus: DeviceStatus | null
}

type CandidateAction = {
    id: 'plan_a' | 'plan_b'
    kind: 'observe_and_recheck' | 'correction_bolus' | 'carb_rescue'
    insulinU: number
    carbsG: number
    recheckMinutes: number
    blockers: string[]
}

type ForecastMetrics = {
    meanMgdl: number
    minMgdl: number
    minAtMinutes: number
    maxMgdl: number
    endMgdl: number
    glucoseAt30Min: number
    glucoseAt60Min: number
    glucoseAt120Min: number
    tirPercent: number
    tbrPercent: number
    tarPercent: number
}

type FitResult = {
    patientState: PatientState
    parameters: { p1Multiplier: number, p3Multiplier: number }
    rmseMgdl: number
    maeMgdl: number
    validationPoints: number
    coveragePercent: number
    currentClampMgdl: number
    carbHistoryPresent: boolean
    mealBolusWithoutCarbs: number
    validationWindows: Record<'30min' | '60min' | '90min', {
        rmseMgdl: number
        maeMgdl: number
        points: number
        coveragePercent: number
    }>
}

const outputFile = path.join(
    process.cwd(),
    'examples',
    'AgentWorkflow',
    'output',
    'online-patient-loop.json',
)

async function main() {
    const input = await readOnlineInput()
    const state = buildDecisionInput(input)
    const fit = identifyAndWarmStart(input)
    const candidates = createTwoCandidates(state)
    const simulated = candidates.map(candidate => simulateWithReplan(input, fit, state, candidate))
    const counterfactuals = createCounterfactuals(input, fit, state)
    const calibrationPassed = fit.rmseMgdl <= MAX_CALIBRATION_RMSE
        && fit.validationPoints >= 12
        && fit.coveragePercent >= 70
    const eligible = simulated.filter(item =>
        item.action.blockers.length === 0
        && item.validation.passed
        && calibrationPassed,
    )
    const selected = [...eligible].sort((a, b) => a.score - b.score)[0] ?? null
    const numericSelected = selected?.action.kind !== 'observe_and_recheck'
    const finalStatus = selected
        ? numericSelected && !fit.carbHistoryPresent
            ? 'blocked_missing_carb_history'
            : 'requires_human_review'
        : 'blocked_no_safe_calibrated_candidate'
    const payload = {
        schemaVersion: 'online-patient-planning-loop-v1',
        generatedAt: new Date().toISOString(),
        mode: 'simulation_only',
        executableOnRealDevice: false,
        source: {
            kind: 'nightscout_read_only',
            urlHost: new URL(input.sourceUrl).host,
            asOf: input.asOf.toISOString(),
            counts: { glucose: input.entries.length, treatments: input.treatments.length },
        },
        state,
        patientInitialization: {
            method: 'history_replay_parameter_grid_and_query_node_state_clamp',
            model: 'Deichmann2021',
            warmupHours: WARMUP_HOURS,
            mappedInputs: [
                'CGM history',
                'scheduled and temporary basal',
                'bolus history',
                'recorded carb history',
                'active therapy target',
            ],
            fit: {
                ...fit,
                patientState: summarizeState(fit.patientState),
                thresholdRmseMgdl: MAX_CALIBRATION_RMSE,
                passed: calibrationPassed,
            },
            onlinePatientUsed: true,
            fixedReferencePatientUsed: false,
            limitations: compact([
                !fit.carbHistoryPresent && 'Nightscout 治疗记录中没有碳水事件；正式候选未反推或伪造历史餐食。',
                fit.mealBolusWithoutCarbs > 0 && `发现 ${fit.mealBolusWithoutCarbs} 条 Meal Bolus 没有 carbs；历史状态可能缺少真实进食扰动。`,
                state.iobU === null && '实时 IOB 缺失，不能验证模型胰岛素作用状态。',
                state.cobG === null && '实时 COB 缺失，不能验证模型消化吸收状态。',
                'Deichmann2021 隐状态不可由 CGM 唯一确定；当前实现是可审计的状态估计，不是数字孪生证明。',
            ]),
        },
        plan: {
            candidateCount: 2,
            candidates: simulated,
            counterfactuals,
            maxReplanIterations: 3,
            selectionRule: '正式候选先通过校准门禁与低/高血糖硬门禁，再最小化范围外暴露和终点偏差；反事实 sweep 永远不可执行。',
        },
        finalAction: selected ? {
            status: finalStatus,
            selectedPlanId: selected.action.id,
            action: selected.action,
            predicted: selected.metrics,
            executable: false,
            destination: 'human_review_only',
            notice: '这是只读研究仿真候选。系统不会向 Nightscout、泵或 Profile 写入任何数据。',
        } : {
            status: finalStatus,
            selectedPlanId: null,
            action: null,
            executable: false,
            destination: 'human_review_only',
            notice: '校准或候选安全门禁未通过，没有生成患者数值动作。',
        },
        trace: [
            { step: 'observe', status: 'completed', detail: '读取当前节点之前的 CGM、治疗、Profile 与 DeviceStatus。' },
            { step: 'model', status: calibrationPassed ? 'completed' : 'blocked', detail: `6 小时历史回放；验证 RMSE ${fit.rmseMgdl} mg/dL。` },
            { step: 'plan', status: 'completed', detail: '由确定性代码生成恰好两个候选。' },
            { step: 'simulate', status: 'completed', detail: '从同一个在线患者估计状态分叉，输出 30/60/120 分钟预测点，并最多重规划 3 次。' },
            { step: 'action', status: finalStatus, detail: selected ? `选择 ${selected.action.id}，仅供人工审核。` : '无候选通过。' },
        ],
    }
    fs.mkdirSync(path.dirname(outputFile), { recursive: true })
    fs.writeFileSync(outputFile, JSON.stringify(payload, null, 2))
    console.log('Wrote online patient loop:', outputFile)
    console.log('As of:', input.asOf.toISOString())
    console.log('Fit:', payload.patientInitialization.fit)
    console.log('Final status:', finalStatus, selected?.action ?? null)
}

async function readOnlineInput(): Promise<OnlineInput> {
    const rawUrl = process.env.NIGHTSCOUT_URL
    if (!rawUrl) throw new Error('NIGHTSCOUT_URL is required; only read-only GET requests are used.')
    const sourceUrl = rawUrl.replace(/\/$/, '')
    const headers: Record<string, string> = {}
    if (process.env.NIGHTSCOUT_TOKEN) headers['api-secret'] = process.env.NIGHTSCOUT_TOKEN
    const latest = await getJson<Entry[]>(`${sourceUrl}/api/v1/entries.json?count=1`, headers)
    if (!latest.length) throw new Error('Nightscout returned no glucose entries.')
    const asOf = new Date(Number(latest[0].date) || Date.parse(latest[0].dateString ?? ''))
    const start = new Date(asOf.valueOf() - 24 * HOUR)
    const entriesUrl = new URL(`${sourceUrl}/api/v1/entries.json`)
    entriesUrl.searchParams.set('find[date][$gte]', String(start.valueOf()))
    entriesUrl.searchParams.set('find[date][$lte]', String(asOf.valueOf()))
    entriesUrl.searchParams.set('count', '2000')
    const treatmentsUrl = new URL(`${sourceUrl}/api/v1/treatments.json`)
    treatmentsUrl.searchParams.set('find[created_at][$gte]', start.toISOString())
    treatmentsUrl.searchParams.set('find[created_at][$lte]', asOf.toISOString())
    treatmentsUrl.searchParams.set('count', '5000')
    const [entries, treatments, profiles, statuses] = await Promise.all([
        getJson<Entry[]>(entriesUrl.toString(), headers),
        getJson<Treatment[]>(treatmentsUrl.toString(), headers),
        getJson<Profile[]>(`${sourceUrl}/api/v1/profile.json?count=1`, headers),
        getJson<DeviceStatus[]>(`${sourceUrl}/api/v1/devicestatus.json?count=1`, headers),
    ])
    const profile = profiles[0]
    if (!profile?.store) throw new Error('Nightscout profile is missing.')
    const profileStore = profile.store[profile.defaultProfile ?? '']
        ?? profile.store.Default
        ?? Object.values(profile.store)[0]
    if (!profileStore) throw new Error('Nightscout profile store is missing.')
    return {
        sourceUrl,
        asOf,
        entries: normalizeEntries(entries, start, asOf),
        treatments: normalizeTreatments(treatments, start, asOf),
        profile,
        profileStore,
        deviceStatus: statuses[0] ?? null,
    }
}

async function getJson<T>(url: string, headers: Record<string, string>): Promise<T> {
    const response = await fetch(url, { headers, method: 'GET' })
    if (!response.ok) throw new Error(`Nightscout GET failed: ${response.status} ${new URL(url).pathname}`)
    return await response.json() as T
}

function buildDecisionInput(input: OnlineInput) {
    const latest = input.entries.at(-1)!
    const status = input.deviceStatus
    const store = input.profileStore
    const seconds = secondsFromMidnight(input.asOf, store.timezone)
    const targetLow = scheduleValue(store.target_low, seconds)
    const targetHigh = scheduleValue(store.target_high, seconds)
    const iobU = finiteOrNull(status?.loop?.iob?.iob ?? status?.openaps?.iob?.iob)
    const cobG = finiteOrNull(status?.loop?.cob?.cob ?? status?.openaps?.suggested?.COB)
    const carbs = input.treatments.filter(treatment => Number(treatment.carbs) > 0)
    const mealBolusWithoutCarbs = input.treatments.filter(treatment =>
        treatment.eventType === 'Meal Bolus'
        && Number(treatment.insulin ?? 0) > 0
        && !(Number(treatment.carbs ?? 0) > 0),
    ).length
    const recent = input.entries.filter(entry => entry.date >= input.asOf.valueOf() - 2 * HOUR)
    const externalPrediction = extractExternalPrediction(status)
    return {
        currentGlucoseMgdl: latest.sgv,
        currentAt: new Date(latest.date).toISOString(),
        slope30MinMgdlPerMin: regressionSlope(
            input.entries.filter(entry => entry.date >= input.asOf.valueOf() - 30 * MINUTE),
        ),
        projected30MinMgdl: externalPrediction.eventualBgMgdl,
        externalPrediction,
        iobU,
        cobG,
        activeBasalUph: finiteOrNull(status?.openaps?.suggested?.rate)
            ?? scheduleValue(store.basal, seconds),
        scheduledBasalUph: scheduleValue(store.basal, seconds),
        isfMgdlPerU: scheduleValue(store.sens, seconds),
        carbRatioGPerU: scheduleValue(store.carbratio, seconds),
        targetLowMgdl: targetLow,
        targetHighMgdl: targetHigh,
        diaHours: finiteOrNull(store.dia),
        pumpSuspended: status?.pump?.suspended ?? null,
        carbHistoryPresent: carbs.length > 0,
        mealBolusWithoutCarbs,
        carbsInferenceDisabled: mealBolusWithoutCarbs > 0,
        recentGlucosePoints: recent.length,
        blockers: compact([
            recent.length < 18 && 'recent_glucose_history_insufficient',
            iobU === null && 'iob_missing',
            cobG === null && 'cob_missing',
            scheduleValue(store.sens, seconds) === null && 'isf_missing',
            targetLow === null && 'target_missing',
            targetHigh === null && 'target_missing',
            status?.pump?.suspended === true && 'pump_suspended',
            carbs.length === 0 && 'carb_treatment_history_missing',
            mealBolusWithoutCarbs > 0 && 'meal_bolus_without_carbs',
        ]),
    }
}

function identifyAndWarmStart(input: OnlineInput): FitResult {
    const start = new Date(input.asOf.valueOf() - WARMUP_HOURS * HOUR)
    const observed = input.entries.filter(entry => entry.date >= start.valueOf())
    const firstGlucose = observed[0]?.sgv ?? input.entries.at(-1)!.sgv
    let best: (FitResult & { patientState: PatientState }) | null = null
    for (const p1Multiplier of [0.75, 1, 1.25]) {
        for (const p3Multiplier of [0.5, 0.75, 1, 1.25, 1.5]) {
            const run = runWarmup(input, start, firstGlucose, p1Multiplier, p3Multiplier)
            if (!best || run.rmseMgdl < best.rmseMgdl) best = run
        }
    }
    if (!best) throw new Error('Patient history warm-up failed.')
    const current = input.entries.at(-1)!.sgv
    const patientState: PatientState = { ...best.patientState, G: current }
    if ((readCob(input.deviceStatus) ?? 0) === 0) {
        patientState.D1 = 0
        patientState.D2 = 0
    }
    return { ...best, patientState, currentClampMgdl: current }
}

function runWarmup(
    input: OnlineInput,
    start: Date,
    firstGlucose: number,
    p1Multiplier: number,
    p3Multiplier: number,
): FitResult {
    const patient = createPatient(input, p1Multiplier, p3Multiplier)
    patient.getPatientProfile()
    patient.setInitialState({ ...patient.getInitialState(), G: firstGlucose })
    const simulator = configuredSimulator(
        patient,
        new TimelineController(
            time => basalAt(input, time),
            bolusEvents(input.treatments, start, input.asOf),
        ),
        mealsFromTreatments(input.treatments, start, input.asOf),
        start,
        input.asOf,
    )
    const result = simulator.runSimulation()
    const validationWindows = {
        '30min': validationWindow(input, result, start, 30),
        '60min': validationWindow(input, result, start, 60),
        '90min': validationWindow(input, result, start, 90),
    }
    const rmseMgdl = validationWindows['90min'].rmseMgdl
    const maeMgdl = validationWindows['90min'].maeMgdl
    const expected = 19
    const mealBolusWithoutCarbs = input.treatments.filter(treatment =>
        treatment.eventType === 'Meal Bolus'
        && Number(treatment.insulin ?? 0) > 0
        && !(Number(treatment.carbs ?? 0) > 0),
    ).length
    return {
        patientState: patient.getState(),
        parameters: { p1Multiplier, p3Multiplier },
        rmseMgdl: round(rmseMgdl, 2),
        maeMgdl: round(maeMgdl, 2),
        validationPoints: validationWindows['90min'].points,
        coveragePercent: round(Math.min(100, validationWindows['90min'].points / expected * 100), 1),
        currentClampMgdl: input.entries.at(-1)!.sgv,
        carbHistoryPresent: input.treatments.some(item => Number(item.carbs) > 0),
        mealBolusWithoutCarbs,
        validationWindows,
    }
}

function createPatient(input: OnlineInput, p1Multiplier: number, p3Multiplier: number) {
    const seconds = secondsFromMidnight(input.asOf, input.profileStore.timezone)
    const targetLow = scheduleValue(input.profileStore.target_low, seconds) ?? 90
    const targetHigh = scheduleValue(input.profileStore.target_high, seconds) ?? 110
    return new VirtualPatientDeichmann({
        Gpeq: (targetLow + targetHigh) / 2,
        p1: 0.0041 * p1Multiplier,
        p3: 6.913e-6 * p3Multiplier,
    })
}

function createTwoCandidates(state: ReturnType<typeof buildDecisionInput>): [CandidateAction, CandidateAction] {
    const current = state.currentGlucoseMgdl
    const target = state.targetLowMgdl !== null && state.targetHighMgdl !== null
        ? (state.targetLowMgdl + state.targetHighMgdl) / 2
        : null
    if (current < 70 || (state.projected30MinMgdl ?? Infinity) < 70) {
        const approvedHypoCarbsG = finiteOrNull(process.env.APPROVED_HYPO_CARBS_G)
        return [
            {
                id: 'plan_a', kind: 'carb_rescue', insulinU: 0,
                carbsG: approvedHypoCarbsG ?? 0, recheckMinutes: 15,
                blockers: approvedHypoCarbsG === null ? ['approved_hypo_protocol_missing'] : [],
            },
            {
                id: 'plan_b', kind: 'observe_and_recheck', insulinU: 0,
                carbsG: 0, recheckMinutes: 5,
                blockers: ['low_glucose_requires_active_protocol'],
            },
        ]
    }
    if (target !== null && state.isfMgdlPerU !== null && state.iobU !== null
        && current > (state.targetHighMgdl ?? 180)) {
        const correction = Math.max(0, (current - target) / state.isfMgdlPerU - state.iobU)
        const numericBlockers = state.blockers.filter(blocker => blocker !== 'target_missing')
        return [
            {
                id: 'plan_a', kind: 'observe_and_recheck', insulinU: 0,
                carbsG: 0, recheckMinutes: 15, blockers: [],
            },
            {
                id: 'plan_b', kind: 'correction_bolus', insulinU: round(correction, 3),
                carbsG: 0, recheckMinutes: 30, blockers: numericBlockers,
            },
        ]
    }
    return [
        {
            id: 'plan_a', kind: 'observe_and_recheck', insulinU: 0,
            carbsG: 0, recheckMinutes: 30, blockers: [],
        },
        {
            id: 'plan_b', kind: 'observe_and_recheck', insulinU: 0,
            carbsG: 0, recheckMinutes: 15, blockers: [],
        },
    ]
}

function createCounterfactuals(
    input: OnlineInput,
    fit: FitResult,
    state: ReturnType<typeof buildDecisionInput>,
) {
    const projectedLow = state.currentGlucoseMgdl < 70
        || (state.externalPrediction.eventualBgMgdl ?? Infinity) < 70
        || (state.externalPrediction.lowestPredBgMgdl ?? Infinity) < 70
    if (!projectedLow) return []
    return [5, 10, 15, 20].map(carbsG => {
        const action: CandidateAction = {
            id: 'plan_a',
            kind: 'carb_rescue',
            insulinU: 0,
            carbsG,
            recheckMinutes: 15,
            blockers: ['counterfactual_only', 'not_patient_protocol'],
        }
        const metrics = forecast(input, fit, action)
        return {
            kind: 'carb_rescue_counterfactual',
            carbsG,
            metrics,
            validation: {
                passed: validateForecast(metrics, state.externalPrediction).length === 0,
                reasons: validateForecast(metrics, state.externalPrediction),
            },
            executable: false,
            destination: 'research_counterfactual_only',
            notice: '反事实补碳 sweep 仅用于解释模型响应；没有专家批准协议时不得转为患者动作。',
        }
    })
}

function simulateWithReplan(
    input: OnlineInput,
    fit: FitResult,
    state: ReturnType<typeof buildDecisionInput>,
    original: CandidateAction,
) {
    let action = { ...original }
    const attempts: Array<{ iteration: number, action: CandidateAction, metrics: ForecastMetrics, reasons: string[] }> = []
    for (let iteration = 0; iteration < 3; iteration += 1) {
        const metrics = forecast(input, fit, action)
        const reasons = validateForecast(metrics, state.externalPrediction)
        attempts.push({ iteration, action: { ...action }, metrics, reasons })
        if (!reasons.length) break
        const refined = refineAction(action, reasons)
        if (JSON.stringify(refined) === JSON.stringify(action)) break
        action = refined
    }
    const finalAttempt = attempts.at(-1)!
    return {
        action,
        initialAction: original,
        metrics: finalAttempt.metrics,
        validation: { passed: finalAttempt.reasons.length === 0, reasons: finalAttempt.reasons },
        replanned: attempts.length > 1,
        replanAttempts: attempts,
        score: candidateScore(finalAttempt.metrics, finalAttempt.reasons),
        executable: false,
        destination: 'human_review_only',
    }
}

function forecast(input: OnlineInput, fit: FitResult, action: CandidateAction): ForecastMetrics {
    const patient = createPatient(input, fit.parameters.p1Multiplier, fit.parameters.p3Multiplier)
    patient.setInitialState(
        fit.patientState as Parameters<typeof patient.setInitialState>[0],
    )
    const boluses = action.insulinU > 0
        ? [{ at: input.asOf.valueOf(), insulinU: action.insulinU }]
        : []
    const meals: Meal[] = action.carbsG > 0
        ? [{ start: input.asOf, duration: 5, carbs: action.carbsG }]
        : []
    const simulator = configuredSimulator(
        patient,
        new TimelineController(time => basalAt(input, time), boluses),
        meals,
        input.asOf,
        new Date(input.asOf.valueOf() + FORECAST_HOURS * HOUR),
    )
    const result = simulator.runSimulation()
    return summarize(result.map(point => point.y.Gp))
}

function validateForecast(metrics: ForecastMetrics, externalPrediction: ReturnType<typeof extractExternalPrediction>): string[] {
    return compact([
        metrics.minMgdl < 70 && 'predicted_below_70',
        metrics.maxMgdl > 250 && 'predicted_above_250',
        metrics.tbrPercent > 0 && 'predicted_tbr_above_zero',
        metrics.endMgdl < 70 && 'forecast_end_below_70',
        metrics.endMgdl > 180 && 'forecast_end_above_180',
        externalPrediction.lowestPredBgMgdl !== null
            && externalPrediction.lowestPredBgMgdl < 70
            && Math.min(metrics.glucoseAt30Min, metrics.glucoseAt60Min, metrics.glucoseAt120Min) >= 90
            && 'prediction_model_disagreement',
        externalPrediction.eventualBgMgdl !== null
            && externalPrediction.eventualBgMgdl < 70
            && metrics.glucoseAt30Min >= 70
            && metrics.glucoseAt60Min >= 70
            && 'external_low_projection_unresolved',
    ])
}

function refineAction(action: CandidateAction, reasons: string[]): CandidateAction {
    if (action.kind === 'correction_bolus' && reasons.some(reason => reason.includes('below'))) {
        return { ...action, insulinU: round(action.insulinU * 0.8, 3) }
    }
    if (action.kind === 'carb_rescue' && reasons.some(reason => reason.includes('above'))) {
        return { ...action, carbsG: round(action.carbsG * 0.8, 1) }
    }
    return action
}

function configuredSimulator(
    patient: InstanceType<typeof VirtualPatientDeichmann>,
    controller: Controller,
    meals: Meal[],
    start: Date,
    end: Date,
) {
    const simulator = new Simulator()
    simulator.setPatient(patient)
    simulator.setController(controller)
    simulator.setSensor(new IdealCGM())
    simulator.setActuator(new StaticInsulinPump())
    simulator.setMeals(meals)
    simulator.setExerciseUnits([])
    simulator.setOptions({ t0: start, tmax: end, dt: 1, seed: 42 })
    return simulator
}

const emptyParameters = {} satisfies ParameterDescriptions
const timelineProfile: ModuleProfile = {
    type: 'controller', id: 'OnlineTimelineController', version: '0.1.0', name: 'Online timeline replay',
}

class TimelineController extends AbstractController<typeof emptyParameters> implements Controller {
    private emitted = new Set<number>()

    constructor(
        private readonly basalAtTime: (time: Date) => number,
        private readonly boluses: Array<{ at: number, insulinU: number }>,
    ) {
        super({ samplingTime: 1 })
    }

    getModelInfo() { return timelineProfile }
    getParameterDescription() { return emptyParameters }
    getInputList(): Array<keyof Measurement> { return ['CGM'] }
    getOutputList(): Array<keyof ControllerOutput> { return ['iir', 'ibolus'] }
    override reset(t: Date): void { super.reset(t); this.emitted.clear() }

    update(t: Date, _s: TracedMeasurement, _a: AnnouncementList = {}): void {
        const output: ControllerOutput = { iir: Math.max(0, this.basalAtTime(t)) }
        for (const bolus of this.boluses) {
            if (!this.emitted.has(bolus.at) && Math.abs(t.valueOf() - bolus.at) < MINUTE / 2) {
                output.ibolus = bolus.insulinU
                this.emitted.add(bolus.at)
            }
        }
        this.output = output
    }
}

function basalAt(input: OnlineInput, time: Date): number {
    const active = tempBasalIntervals(input.treatments)
        .find(item => item.start <= time.valueOf() && item.end > time.valueOf())
    return active?.rate ?? scheduleValue(
        input.profileStore.basal,
        secondsFromMidnight(time, input.profileStore.timezone),
    ) ?? 0
}

function tempBasalIntervals(treatments: Treatment[]) {
    const tempBasals = treatments
        .filter(item => item.eventType === 'Temp Basal')
        .map(item => ({
            treatment: item,
            start: treatmentTime(item),
            rate: finiteOrNull(item.absolute ?? item.rate),
        }))
        .filter((item): item is { treatment: Treatment, start: number, rate: number } =>
            item.start !== null && item.rate !== null,
        )
        .sort((a, b) => a.start - b.start)
    return tempBasals
        .map((item, index) => {
            const explicitEnd = finiteOrNull(item.treatment.endmills)
            const durationMin = finiteOrNull(item.treatment.duration)
            const durationMs = finiteOrNull(item.treatment.durationInMilliseconds)
                ?? (durationMin !== null ? durationMin * MINUTE : null)
            const nextStart = tempBasals[index + 1]?.start ?? null
            const inferredEnd = explicitEnd
                ?? (durationMs !== null && durationMs > 0 ? item.start + durationMs : null)
                ?? (nextStart !== null && nextStart - item.start <= 3 * HOUR ? nextStart : null)
            return inferredEnd && inferredEnd > item.start
                ? { start: item.start, end: inferredEnd, rate: item.rate }
                : null
        })
        .filter((item): item is { start: number, end: number, rate: number } => item !== null)
        .sort((a, b) => b.start - a.start)
}

function bolusEvents(treatments: Treatment[], start: Date, end: Date) {
    return treatments
        .map(item => ({ at: treatmentTime(item), insulinU: Number(item.insulin ?? 0) }))
        .filter((item): item is { at: number, insulinU: number } =>
            item.at !== null && item.at >= start.valueOf() && item.at <= end.valueOf()
            && Number.isFinite(item.insulinU) && item.insulinU > 0,
        )
}

function mealsFromTreatments(treatments: Treatment[], start: Date, end: Date): Meal[] {
    return treatments
        .map(item => ({ at: treatmentTime(item), carbs: Number(item.carbs ?? 0) }))
        .filter((item): item is { at: number, carbs: number } =>
            item.at !== null && item.at >= start.valueOf() && item.at <= end.valueOf()
            && Number.isFinite(item.carbs) && item.carbs > 0,
        )
        .map(item => ({ start: new Date(item.at), duration: 15, carbs: item.carbs }))
}

function normalizeEntries(entries: Entry[], start: Date, end: Date): Entry[] {
    const unique = new Map<number, Entry>()
    for (const entry of entries) {
        const date = Number(entry.date) || Date.parse(entry.dateString ?? '')
        const sgv = Number(entry.sgv)
        if (Number.isFinite(date) && Number.isFinite(sgv) && sgv >= 20 && sgv <= 600
            && date >= start.valueOf() && date <= end.valueOf()) unique.set(date, { ...entry, date, sgv })
    }
    return [...unique.values()].sort((a, b) => a.date - b.date)
}

function normalizeTreatments(treatments: Treatment[], start: Date, end: Date): Treatment[] {
    return treatments.filter(item => {
        const time = treatmentTime(item)
        return time !== null && time >= start.valueOf() && time <= end.valueOf()
    })
}

function treatmentTime(item: Treatment): number | null {
    const value = Date.parse(item.created_at ?? item.timestamp ?? '')
    return Number.isFinite(value) ? value : null
}

function scheduleValue(entries: ScheduleEntry[] | undefined, seconds: number): number | null {
    if (!entries?.length) return null
    const sorted = [...entries].sort((a, b) => a.timeAsSeconds - b.timeAsSeconds)
    let active = sorted.at(-1)!
    for (const entry of sorted) {
        if (seconds >= entry.timeAsSeconds) active = entry
        else break
    }
    return finiteOrNull(active.value)
}

function secondsFromMidnight(date: Date, timezone?: string): number {
    if (timezone) {
        try {
            const parts = new Intl.DateTimeFormat('en-US', {
                timeZone: timezone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
            }).formatToParts(date)
            const value = (type: 'hour' | 'minute' | 'second') =>
                Number(parts.find(part => part.type === type)?.value ?? 0)
            return value('hour') * 3600 + value('minute') * 60 + value('second')
        }
        catch { /* use host time below */ }
    }
    return date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds()
}

function regressionSlope(entries: Entry[]): number | null {
    if (entries.length < 3) return null
    const origin = entries[0].date
    const xs = entries.map(entry => (entry.date - origin) / MINUTE)
    const meanX = xs.reduce((sum, value) => sum + value, 0) / xs.length
    const meanY = entries.reduce((sum, entry) => sum + entry.sgv, 0) / entries.length
    const numerator = entries.reduce((sum, entry, index) =>
        sum + (xs[index] - meanX) * (entry.sgv - meanY), 0)
    const denominator = xs.reduce((sum, value) => sum + Math.pow(value - meanX, 2), 0)
    return denominator ? round(numerator / denominator, 3) : null
}

function validationWindow(
    input: OnlineInput,
    result: ReturnType<Simulator['runSimulation']>,
    start: Date,
    minutes: number,
) {
    const observed = input.entries.filter(entry =>
        entry.date >= Math.max(start.valueOf(), input.asOf.valueOf() - minutes * MINUTE),
    )
    const errors = observed.map(entry => {
        const index = Math.max(0, Math.min(result.length - 1, Math.round((entry.date - start.valueOf()) / MINUTE)))
        return result[index].y.Gp - entry.sgv
    })
    const rmseMgdl = errors.length
        ? Math.sqrt(errors.reduce((sum, value) => sum + value * value, 0) / errors.length)
        : Infinity
    const maeMgdl = errors.length
        ? errors.reduce((sum, value) => sum + Math.abs(value), 0) / errors.length
        : Infinity
    const expected = Math.floor(minutes / 5) + 1
    return {
        rmseMgdl: round(rmseMgdl, 2),
        maeMgdl: round(maeMgdl, 2),
        points: errors.length,
        coveragePercent: round(Math.min(100, errors.length / expected * 100), 1),
    }
}

function extractExternalPrediction(status: DeviceStatus | null) {
    const predValues = Object.values(status?.openaps?.suggested?.predBGs ?? {})
        .flat()
        .map(value => Number(value))
        .filter(value => Number.isFinite(value) && value >= 20 && value <= 600)
    return {
        source: predValues.length ? 'openaps_predBGs' : 'openaps_eventualBG',
        eventualBgMgdl: finiteOrNull(status?.openaps?.suggested?.eventualBG),
        lowestPredBgMgdl: predValues.length ? round(Math.min(...predValues), 1) : null,
        horizonPoints: predValues.length,
    }
}

function summarize(values: number[]): ForecastMetrics {
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length
    const minMgdl = Math.min(...values)
    const minIndex = values.findIndex(value => value === minMgdl)
    return {
        meanMgdl: round(mean, 2),
        minMgdl: round(minMgdl, 2),
        minAtMinutes: minIndex,
        maxMgdl: round(Math.max(...values), 2),
        endMgdl: round(values.at(-1)!, 2),
        glucoseAt30Min: valueAtMinute(values, 30),
        glucoseAt60Min: valueAtMinute(values, 60),
        glucoseAt120Min: valueAtMinute(values, 120),
        tirPercent: round(values.filter(value => value >= 70 && value <= 180).length / values.length * 100, 2),
        tbrPercent: round(values.filter(value => value < 70).length / values.length * 100, 2),
        tarPercent: round(values.filter(value => value > 180).length / values.length * 100, 2),
    }
}

function valueAtMinute(values: number[], minute: number): number {
    const index = Math.max(0, Math.min(values.length - 1, minute))
    return round(values[index], 2)
}

function candidateScore(metrics: ForecastMetrics, reasons: string[]): number {
    if (reasons.length) return 1e6 + reasons.length * 1e4
    return round(
        metrics.tbrPercent * 10_000
        + metrics.tarPercent * 100
        + Math.abs(metrics.endMgdl - 110),
        2,
    )
}

function readCob(status: DeviceStatus | null): number | null {
    return finiteOrNull(status?.loop?.cob?.cob ?? status?.openaps?.suggested?.COB)
}

function summarizeState(state: PatientState) {
    return Object.fromEntries(Object.entries(state).map(([key, value]) => [key, round(value, 6)]))
}

function finiteOrNull(value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
}

function compact(values: Array<string | false | null | undefined>): string[] {
    return [...new Set(values.filter((value): value is string => Boolean(value)))]
}

function round(value: number, digits = 2): number {
    const factor = Math.pow(10, digits)
    return Math.round(value * factor) / factor
}

main().catch(error => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
})
