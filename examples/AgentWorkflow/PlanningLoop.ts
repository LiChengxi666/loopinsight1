import * as fs from 'fs'
import * as path from 'path'
import Simulator from '../../src/core/Simulator.js'
import StaticInsulinPump from '../../src/core/actuators/StaticInsulinPump.js'
import VirtualPatientDeichmann from '../../src/core/models/Deichmann2021.js'
import IdealCGM from '../../src/core/sensors/IdealCGM.js'
import type Exercise from '../../src/types/Exercise.js'
import type Meal from '../../src/types/Meal.js'
import { AgentAdapterController } from './AgentAdapter.js'
import type { AgentAction, AgentState } from './AgentAdapter.js'

type CandidatePlan = {
    id: string
    label: string
    hypothesis: string
    mealBolus: boolean
    timingMinutesBeforeMeal: number
    carbRatioGPerU: number | null
    correctionTargetMgdl: number
    insulinSensitivityMgdlPerU: number
}

type CandidateMetrics = {
    meanMgdl: number
    minMgdl: number
    maxMgdl: number
    tirPercent: number
    tbrPercent: number
    tarPercent: number
    cvPercent: number
}

type CandidateResult = {
    plan: CandidatePlan
    observation: {
        at: string
        currentGlucoseMgdl: number | null
        trend: AgentState['trend']
        pendingMealCarbsG: number | null
        dataQuality: AgentState['data_quality']
    }
    metrics: CandidateMetrics
    eligible: boolean
    rejectionReasons: string[]
    score: number
    simulatedActions: Array<{
        kind: 'simulated_bolus'
        at: string
        bolusU: number
        allowed: boolean
        safetyFlags: string[]
    }>
    blockedActions: Array<{
        at: string
        requestedBolusU: number
        safetyFlags: string[]
    }>
}

const simulationStart = '2022-05-01T06:00:00Z'
const simulationEnd = '2022-05-02T06:00:00Z'
const outputFile = path.join(
    process.cwd(),
    'examples',
    'AgentWorkflow',
    'output',
    'planning-loop.json',
)
const realWorldSummaryFile = path.join(
    process.cwd(),
    'examples',
    'AgentWorkflow',
    'output',
    'real-world-demo',
    'summary.json',
)

const candidatePlans: CandidatePlan[] = [
    {
        id: 'observe-only',
        label: '只观察，不加入餐时动作',
        hypothesis: '作为对照组，观察相同饮食和基础率下不加入餐时 bolus 的虚拟曲线。',
        mealBolus: false,
        timingMinutesBeforeMeal: 0,
        carbRatioGPerU: null,
        correctionTargetMgdl: 130,
        insulinSensitivityMgdlPerU: 70,
    },
    {
        id: 'at-meal-reference',
        label: '进餐时参考策略',
        hypothesis: '在虚拟进餐开始时按 18 g/U 参考参数加入模拟餐时动作。',
        mealBolus: true,
        timingMinutesBeforeMeal: 0,
        carbRatioGPerU: 18,
        correctionTargetMgdl: 130,
        insulinSensitivityMgdlPerU: 70,
    },
    {
        id: 'premeal-reference',
        label: '餐前 15 分钟参考策略',
        hypothesis: '保持相同虚拟剂量假设，只比较餐前 15 分钟的时机差异。',
        mealBolus: true,
        timingMinutesBeforeMeal: 15,
        carbRatioGPerU: 18,
        correctionTargetMgdl: 130,
        insulinSensitivityMgdlPerU: 70,
    },
    {
        id: 'premeal-conservative',
        label: '餐前 15 分钟保守策略',
        hypothesis: '餐前 15 分钟，但使用 20 g/U 的更保守虚拟参数。',
        mealBolus: true,
        timingMinutesBeforeMeal: 15,
        carbRatioGPerU: 20,
        correctionTargetMgdl: 140,
        insulinSensitivityMgdlPerU: 80,
    },
]

function main() {
    const results = candidatePlans.map(runCandidate)
    const selected = selectCandidate(results)
    const observation = readRealWorldObservation()
    const simulationBaseline = {
        source: 'virtual_patient_cgm',
        ...selected.observation,
        limitations: [
            '观察来自 Deichmann2021 虚拟患者，不是指定 Nightscout 用户的数字孪生。',
            '真实数据只用于只读回放，尚未用于虚拟患者参数辨识。',
        ],
    }
    const payload = {
        schemaVersion: 'simulation-planning-loop-v1',
        generatedAt: process.env.PLANNING_GENERATED_AT || simulationEnd,
        mode: 'simulation_only',
        executableOnRealDevice: false,
        simulator: {
            name: 'LoopInsighT1',
            version: '2.1.0',
            patientModel: 'Deichmann2021',
            sensor: 'IdealCGM',
            seed: 42,
            window: { start: simulationStart, end: simulationEnd },
        },
        observation,
        simulationBaseline,
        isolationBridge: {
            calibratedToObservedPerson: false,
            realDataUsage: 'read_only_state_and_quality_context',
            simulationUsage: 'reference_candidate_comparison',
            decision: '仿真只能辅助筛选需要人工复核的方向，不能产生个人可执行治疗动作。',
        },
        plan: {
            objective: '先避免虚拟低血糖，再比较 TIR、TAR 和波动。',
            candidates: results,
            selectionRule: '排除 TBR>1% 或最低血糖<54 mg/dL；其余候选按固定风险分数从低到高选择。',
        },
        action: {
            kind: 'review_simulation_plan',
            status: 'requires_human_review',
            selectedPlanId: selected.plan.id,
            title: `优先复核：${selected.plan.label}`,
            summary: `参考仿真中该候选得到 TIR ${selected.metrics.tirPercent}%、TBR ${selected.metrics.tbrPercent}%；真实数据未用于患者参数校准。`,
            simulationActions: selected.simulatedActions,
            executable: false,
            destination: 'human_review_only',
            safetyNotice: '仅为虚拟患者仿真结果，不得转换为真实胰岛素剂量或设备命令。',
        },
        trace: [
            { step: 'observe', status: 'completed', detail: '读取指定 Nightscout 日数据的末端血糖、趋势和数据质量。' },
            { step: 'plan', status: 'completed', detail: `生成 ${results.length} 个隔离候选策略。` },
            { step: 'simulate', status: 'completed', detail: '每个候选均重新运行同一 24 小时虚拟患者场景。' },
            { step: 'action', status: 'completed', detail: '固定规则选择候选，并输出只供人工审核的 Action。' },
        ],
    }

    fs.mkdirSync(path.dirname(outputFile), { recursive: true })
    fs.writeFileSync(outputFile, JSON.stringify(payload, null, 2))
    console.log('Wrote planning loop:', outputFile)
    console.log('Selected plan:', selected.plan.id, selected.metrics)
}

function readRealWorldObservation() {
    if (!fs.existsSync(realWorldSummaryFile)) {
        throw new Error('Real-world summary is missing. Run npm run demo:real-data first.')
    }
    const summary = JSON.parse(fs.readFileSync(realWorldSummaryFile, 'utf8'))
    const features = summary.glucose.endOfWindowFeatures
    return {
        source: 'nightscout_replay',
        windowEnd: summary.source.end,
        currentGlucoseMgdl: features.currentGlucoseMgdl,
        currentAt: features.currentAt,
        trend: features.trend,
        slope30Min: round(features.slope30Min, 3),
        projected30MinMgdl: features.projected30MinMgdl,
        coveragePercent: summary.dataQuality.coveragePercent,
        longestGapMin: summary.dataQuality.longestGapMin,
        dataQuality: summary.dataQuality.longestGapMin > 20 ? 'partial' : features.dataQuality,
        treatments: summary.treatments.validRecords,
        limitations: [
            '该状态来自历史日数据回放，不是当前实时状态。',
            '最长数据缺口必须随 Plan 一起进入人工审核上下文。',
        ],
    }
}

function runCandidate(plan: CandidatePlan): CandidateResult {
    const simulator = new Simulator()
    const patient = new VirtualPatientDeichmann()
    const controller = new AgentAdapterController({
        decide: createCandidatePolicy(plan),
        basalRateUPerHour: patient.getPatientProfile().IIReq * 0.85,
        samplingTimeMin: 5,
        minBolusIntervalMin: 120,
        maxBolusU: 8,
        emitBolusToSimulator: true,
    })

    simulator.setPatient(patient)
    simulator.setController(controller)
    simulator.setSensor(new IdealCGM())
    simulator.setActuator(new StaticInsulinPump())
    simulator.setMeals(demoMeals())
    simulator.setExerciseUnits(demoExercise())
    simulator.setOptions({
        t0: new Date(simulationStart),
        tmax: new Date(simulationEnd),
        dt: 1,
        seed: 42,
    })

    const simulation = simulator.runSimulation()
    const glucose = simulation.map(point => point.s.CGM ?? point.s.SMBG ?? point.y.Gp)
    const metrics = summarize(glucose)
    const rejectionReasons: string[] = []
    if (metrics.tbrPercent > 1) rejectionReasons.push('tbr_above_1_percent')
    if (metrics.minMgdl < 54) rejectionReasons.push('level_2_hypoglycemia')
    if (metrics.maxMgdl > 300) rejectionReasons.push('severe_hyperglycemia')
    if (metrics.tarPercent > 50) rejectionReasons.push('tar_above_50_percent')
    const simulatedActions = controller.decisions
        .filter(decision => (decision.output.ibolus ?? 0) > 0)
        .map(decision => ({
            kind: 'simulated_bolus' as const,
            at: decision.state.time,
            bolusU: round(decision.output.ibolus ?? 0, 2),
            allowed: decision.action.allowed,
            safetyFlags: decision.action.safety_flags,
        }))
    const blockedByMeal = new Map<string, CandidateResult['blockedActions'][number]>()
    for (const decision of controller.decisions) {
        if (decision.action.kind !== 'suggest_bolus' || decision.action.allowed) continue
        const key = decision.state.pending_meals[0]?.id ?? decision.state.time
        if (!blockedByMeal.has(key)) {
            blockedByMeal.set(key, {
                at: decision.state.time,
                requestedBolusU: round(decision.action.bolus_u ?? 0, 2),
                safetyFlags: decision.action.safety_flags,
            })
        }
    }
    const blockedActions = [...blockedByMeal.values()]
    const planningDecision = controller.decisions.find(decision =>
        decision.action.kind === 'suggest_bolus',
    ) ?? controller.decisions.find(decision => decision.state.pending_meals.length > 0)

    return {
        plan,
        observation: {
            at: planningDecision?.state.time ?? simulationStart,
            currentGlucoseMgdl: planningDecision?.state.current_glucose_mgdl === null
                || planningDecision?.state.current_glucose_mgdl === undefined
                ? null
                : round(planningDecision.state.current_glucose_mgdl, 1),
            trend: planningDecision?.state.trend ?? 'unknown',
            pendingMealCarbsG: planningDecision?.state.pending_meals[0]?.carbs ?? null,
            dataQuality: planningDecision?.state.data_quality ?? 'missing_glucose',
        },
        metrics,
        eligible: rejectionReasons.length === 0,
        rejectionReasons,
        score: candidateScore(metrics, rejectionReasons.length === 0),
        simulatedActions,
        blockedActions,
    }
}

function createCandidatePolicy(plan: CandidatePlan) {
    return (state: AgentState): AgentAction => {
        const meal = state.pending_meals[0]
        if (!meal) {
            return { kind: 'no_action', explanation: 'No pending virtual meal.', confidence: 'high' }
        }
        const minutesToMeal = (
            new Date(meal.startsAt).valueOf() - new Date(state.time).valueOf()
        ) / 60e3
        if (minutesToMeal > plan.timingMinutesBeforeMeal) {
            return {
                kind: 'no_action',
                explanation: `Candidate waits for its ${plan.timingMinutesBeforeMeal}-minute virtual window.`,
                confidence: 'high',
            }
        }
        if (!plan.mealBolus || plan.carbRatioGPerU === null) {
            return {
                kind: 'warn',
                explanation: 'Observe-only comparator intentionally emits no meal bolus.',
                confidence: 'high',
            }
        }
        if (minutesToMeal < -10) {
            return {
                kind: 'warn',
                explanation: 'The candidate virtual meal window has passed.',
                confidence: 'medium',
            }
        }
        const correction = state.current_glucose_mgdl === null
            ? 0
            : Math.max(
                0,
                (state.current_glucose_mgdl - plan.correctionTargetMgdl)
                    / plan.insulinSensitivityMgdlPerU,
            )
        return {
            kind: 'suggest_bolus',
            bolus_u: meal.carbs / plan.carbRatioGPerU + correction,
            explanation: `Simulation-only candidate ${plan.id}.`,
            confidence: 'medium',
        }
    }
}

function selectCandidate(results: CandidateResult[]): CandidateResult {
    const eligible = results.filter(result => result.eligible)
    if (!eligible.length) throw new Error('No simulation candidate passed the fixed safety criteria')
    return [...eligible].sort((a, b) => a.score - b.score)[0]
}

function candidateScore(metrics: CandidateMetrics, eligible: boolean): number {
    if (!eligible) return 1_000_000
    return round(
        metrics.tbrPercent * 1000
        + (100 - metrics.tirPercent) * 10
        + metrics.tarPercent * 3
        + Math.max(0, metrics.cvPercent - 36) * 2,
        2,
    )
}

function summarize(values: number[]): CandidateMetrics {
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length
    const variance = values.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / values.length
    const inRange = values.filter(value => value >= 70 && value <= 180).length
    const below = values.filter(value => value < 70).length
    const above = values.filter(value => value > 180).length
    return {
        meanMgdl: round(mean, 2),
        minMgdl: round(Math.min(...values), 2),
        maxMgdl: round(Math.max(...values), 2),
        tirPercent: round(inRange / values.length * 100, 2),
        tbrPercent: round(below / values.length * 100, 2),
        tarPercent: round(above / values.length * 100, 2),
        cvPercent: round(Math.sqrt(variance) / mean * 100, 2),
    }
}

function demoMeals(): Meal[] {
    return [
        meal('2022-05-01T08:00:00Z', 45, 55),
        meal('2022-05-01T13:00:00Z', 45, 70),
        meal('2022-05-01T19:00:00Z', 45, 65),
    ]
}

function meal(start: string, duration: number, carbs: number): Meal {
    const startsAt = new Date(start)
    return {
        start: startsAt,
        duration,
        carbs,
        announcement: {
            start: startsAt,
            carbs,
            time: new Date(startsAt.valueOf() - 15 * 60e3),
        },
    }
}

function demoExercise(): Exercise[] {
    return [{
        start: new Date('2022-05-01T16:30:00Z'),
        duration: 45,
        intensity: 25,
    }]
}

function round(value: number, digits = 2): number {
    const factor = Math.pow(10, digits)
    return Math.round(value * factor) / factor
}

main()
