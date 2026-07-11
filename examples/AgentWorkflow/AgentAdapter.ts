import type { AnnouncementList, ControllerOutput, Measurement, TracedMeasurement } from '../../src/types/Controller.js'
import type Controller from '../../src/types/Controller.js'
import type { ModuleProfile } from '../../src/types/ModuleProfile.js'
import type { ParameterDescriptions } from '../../src/types/ParametricModule.js'
import AbstractController from '../../src/core/AbstractController.js'
import { buildDeterministicGlucoseFeatures } from './GlucoseStateBuilder.js'

export type AgentMeal = {
    id: string
    announcedAt: string
    startsAt: string
    carbs: number
}

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

export type GuardedAgentAction = AgentAction & {
    allowed: boolean
    safety_flags: string[]
}

export type AgentDecision = (state: AgentState) => AgentAction

export type AgentControllerOptions = {
    decide: AgentDecision
    basalRateUPerHour?: number
    samplingTimeMin?: number
    minBolusIntervalMin?: number
    maxBolusU?: number
    emitBolusToSimulator?: boolean
}

export const agentControllerProfile: ModuleProfile = {
    type: 'controller',
    id: 'AgentAdapterController',
    version: '0.1.0',
    name: 'Agent adapter controller',
}

const emptyParameterDescription = {} satisfies ParameterDescriptions

export class AgentAdapterController
    extends AbstractController<typeof emptyParameterDescription>
    implements Controller {

    private readonly decide: AgentDecision
    private readonly basalRateUPerHour: number
    private readonly minBolusIntervalMin: number
    private readonly maxBolusU: number
    private readonly emitBolusToSimulator: boolean
    private history: Array<{ t: Date, glucose: number }> = []
    private lastBolusAt?: Date
    private lastBolusU = 0
    private handledMealIds = new Set<string>()
    public readonly decisions: Array<{
        state: AgentState,
        action: GuardedAgentAction,
        output: ControllerOutput,
    }> = []

    constructor(options: AgentControllerOptions) {
        super({
            samplingTime: options.samplingTimeMin ?? 5,
        })
        this.decide = options.decide
        this.basalRateUPerHour = options.basalRateUPerHour ?? 0
        this.minBolusIntervalMin = options.minBolusIntervalMin ?? 90
        this.maxBolusU = options.maxBolusU ?? 10
        this.emitBolusToSimulator = options.emitBolusToSimulator ?? false
    }

    getModelInfo(): ModuleProfile {
        return agentControllerProfile
    }

    getParameterDescription() {
        return emptyParameterDescription
    }

    getInputList(): Array<keyof Measurement> {
        return ['CGM', 'SMBG']
    }

    getOutputList(): Array<keyof ControllerOutput> {
        return ['iir', 'ibolus']
    }

    override reset(t: Date): void {
        super.reset(t)
        this.history = []
        this.lastBolusAt = undefined
        this.lastBolusU = 0
        this.handledMealIds.clear()
        this.decisions.length = 0
    }

    update(t: Date, s: TracedMeasurement, announcements: AnnouncementList = {}): void {
        const state = this.buildState(t, s, announcements)
        const rawAction = this.decide(state)
        const action = this.applySafetyGate(t, state, rawAction)

        const output: ControllerOutput = {}

        if (Number.isFinite(this.basalRateUPerHour) && this.basalRateUPerHour > 0) {
            output.iir = this.basalRateUPerHour
        }

        if (
            action.allowed &&
            action.kind === 'suggest_basal' &&
            Number.isFinite(action.basal_u_per_hr) &&
            (action.basal_u_per_hr ?? 0) >= 0
        ) {
            output.iir = action.basal_u_per_hr
        }

        if (
            this.emitBolusToSimulator &&
            action.allowed &&
            action.kind === 'suggest_bolus' &&
            (action.bolus_u ?? 0) > 0
        ) {
            output.ibolus = roundToIncrement(action.bolus_u!, 0.05)
            this.lastBolusAt = t
            this.lastBolusU = output.ibolus
            for (const meal of state.pending_meals) {
                this.handledMealIds.add(meal.id)
            }
        }

        this.output = output
        this.internals = {
            reason: [
                action.explanation,
                `allowed=${action.allowed}`,
                `safety_flags=${action.safety_flags.join(',') || 'none'}`,
            ],
            debug: [JSON.stringify({ state, action })],
        }
        this.decisions.push({ state, action, output })
    }

    private buildState(t: Date, s: TracedMeasurement, announcements: AnnouncementList): AgentState {
        const glucose = readGlucose(s)
        if (glucose !== null) {
            this.history.push({ t, glucose })
            this.history = this.history.filter(point => t.valueOf() - point.t.valueOf() <= 30 * 60e3)
        }

        const deterministic = buildDeterministicGlucoseFeatures(
            this.history.map(point => ({
                time: point.t,
                glucoseMgdl: point.glucose,
            })),
            t,
        )
        const trendMgdlPerMin = deterministic.slope30Min

        const pendingMeals = Object.entries(announcements)
            .filter(([id]) => !this.handledMealIds.has(id))
            .map(([id, meal]) => ({
                id,
                announcedAt: meal.time.toISOString(),
                startsAt: meal.start.toISOString(),
                carbs: meal.carbs,
            }))

        const minutesSinceLastBolus = this.lastBolusAt
            ? (t.valueOf() - this.lastBolusAt.valueOf()) / 60e3
            : null

        const recentRisk = inferRisk(glucose, trendMgdlPerMin)
        return {
            time: t.toISOString(),
            current_glucose_mgdl: glucose,
            trend_mgdl_per_min: trendMgdlPerMin,
            trend: deterministic.trend,
            pending_meals: pendingMeals,
            recent_bolus_u: this.lastBolusU,
            minutes_since_last_bolus: minutesSinceLastBolus,
            data_quality: glucose === null ? 'missing_glucose' : 'complete',
            recent_risk: recentRisk,
        }
    }

    private applySafetyGate(t: Date, state: AgentState, action: AgentAction): GuardedAgentAction {
        const safetyFlags: string[] = []

        if (state.current_glucose_mgdl === null) {
            safetyFlags.push('missing_glucose')
        }
        if ((state.current_glucose_mgdl ?? Infinity) < 80) {
            safetyFlags.push('low_glucose')
        }
        if ((state.trend_mgdl_per_min ?? 0) < -2) {
            safetyFlags.push('fast_falling')
        }
        if ((action.bolus_u ?? 0) > this.maxBolusU) {
            safetyFlags.push('bolus_above_max')
        }
        if (
            action.kind === 'suggest_bolus' &&
            this.lastBolusAt &&
            t.valueOf() - this.lastBolusAt.valueOf() < this.minBolusIntervalMin * 60e3
        ) {
            safetyFlags.push('recent_bolus')
        }

        const allowed = safetyFlags.length === 0
        return {
            ...action,
            bolus_u: Math.min(action.bolus_u ?? 0, this.maxBolusU),
            allowed,
            safety_flags: safetyFlags,
        }
    }
}

export function mealBolusDemoPolicy(state: AgentState): AgentAction {
    const nextMeal = state.pending_meals[0]
    if (!nextMeal) {
        return {
            kind: 'no_action',
            explanation: 'No active meal announcement.',
            confidence: 'high',
        }
    }

    const minutesToMeal = (new Date(nextMeal.startsAt).valueOf() - new Date(state.time).valueOf()) / 60e3
    if (minutesToMeal > 15) {
        return {
            kind: 'no_action',
            explanation: `Meal is announced but still ${Math.round(minutesToMeal)} min away.`,
            confidence: 'medium',
        }
    }
    if (minutesToMeal < -10) {
        return {
            kind: 'warn',
            explanation: `Meal bolus window was missed by ${Math.abs(Math.round(minutesToMeal))} min.`,
            confidence: 'medium',
        }
    }

    const mealBolus = nextMeal.carbs / 18
    const correction = state.current_glucose_mgdl === null
        ? 0
        : Math.max(0, (state.current_glucose_mgdl - 130) / 70)
    return {
        kind: 'suggest_bolus',
        bolus_u: mealBolus + correction,
        explanation: `Demo policy: ${nextMeal.carbs}g carbs / 18g/U plus conservative correction.`,
        confidence: 'medium',
    }
}

function readGlucose(s: TracedMeasurement): number | null {
    const value = s.CGM?.() ?? s.SMBG?.()
    return Number.isFinite(value) ? value! : null
}

function inferRisk(glucose: number | null, trend: number | null): string[] {
    const risks: string[] = []
    if (glucose === null) risks.push('missing glucose')
    if ((glucose ?? Infinity) < 80) risks.push('low glucose')
    if ((glucose ?? 0) > 180) risks.push('high glucose')
    if ((trend ?? 0) > 2) risks.push('rapid rise')
    if ((trend ?? 0) < -2) risks.push('rapid fall')
    return risks
}

function roundToIncrement(value: number, increment: number): number {
    return Math.round(value / increment) * increment
}
