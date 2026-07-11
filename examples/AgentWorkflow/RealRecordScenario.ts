import * as fs from 'fs'
import * as path from 'path'
import Simulator from '../../src/core/Simulator.js'
import AbstractController from '../../src/core/AbstractController.js'
import StaticInsulinPump from '../../src/core/actuators/StaticInsulinPump.js'
import VirtualPatientDeichmann from '../../src/core/models/Deichmann2021.js'
import IdealCGM from '../../src/core/sensors/IdealCGM.js'
import type Controller from '../../src/types/Controller.js'
import type { ControllerOutput, Measurement, TracedMeasurement } from '../../src/types/Signals.js'
import type { ModuleProfile } from '../../src/types/ModuleProfile.js'
import type { ParameterDescriptions } from '../../src/types/ParametricModule.js'
import type Meal from '../../src/types/Meal.js'
import type { SimulationResult } from '../../src/types/SimulationResult.js'
import { simulationToEntries } from './NightscoutAdapter.js'
import type { DemoPointForNightscout, NightscoutDeviceStatus } from './NightscoutAdapter.js'

type NightscoutGlucoseEntry = {
    date: number
    created_at: string
    sgv: number
    direction?: string
    units?: string
}

type NightscoutTreatmentRecord = {
    date?: number
    created_at: string
    eventType: string
    insulin?: number | null
    carbs?: number | null
    rate?: number | null
    absolute?: number | null
    duration?: number | null
    utcOffset?: number
    enteredBy?: string
    app?: string
    notes?: string
}

type NightscoutProfileDocument = {
    defaultProfile: string
    store: Record<string, NightscoutProfileStore>
    startDate?: string
}

type NightscoutProfileStore = {
    units: string
    dia: number
    timezone: string
    basal: ProfileScheduleEntry[]
    sens: ProfileScheduleEntry[]
    carbratio: ProfileScheduleEntry[]
    target_low: ProfileScheduleEntry[]
    target_high: ProfileScheduleEntry[]
    carbs_hr?: string
}

type ProfileScheduleEntry = {
    time: string
    timeAsSeconds: number
    value: number
}

type BolusEvent = {
    time: Date
    insulin: number
    eventType: 'Meal Bolus' | 'Correction Bolus'
}

type TempBasalInterval = {
    start: Date
    end: Date
    rate: number
}

type ReplayPoint = DemoPointForNightscout & {
    basal_u_per_hr: number
    real_glucose_mgdl?: number
}

const outputRoot = path.join(process.cwd(), 'examples', 'AgentWorkflow', 'output', 'real-record-2026-07-06')
const sourceDir = path.join(outputRoot, 'source')
const simulatedNsDir = path.join(outputRoot, 'nightscout-simulated')
const simulationStart = new Date('2026-07-06T00:00:00.000Z')
const simulationEnd = new Date('2026-07-07T00:00:00.000Z')
const exportIntervalMin = 5

const replayControllerProfile: ModuleProfile = {
    type: 'controller',
    id: 'RecordedNightscoutTreatmentReplay',
    version: '0.1.0',
    name: 'Recorded Nightscout treatment replay',
}

const emptyParameterDescription = {} satisfies ParameterDescriptions

class RecordedTreatmentController
    extends AbstractController<typeof emptyParameterDescription>
    implements Controller {

    private deliveredBolusIndexes = new Set<number>()

    constructor(
        private readonly basalSchedule: ProfileScheduleEntry[],
        private readonly tempBasals: TempBasalInterval[],
        private readonly boluses: BolusEvent[],
        private readonly utcOffsetMin: number,
    ) {
        super({ samplingTime: 1 })
    }

    getModelInfo(): ModuleProfile {
        return replayControllerProfile
    }

    getParameterDescription() {
        return emptyParameterDescription
    }

    getInputList(): Array<keyof Measurement> {
        return ['CGM']
    }

    getOutputList(): Array<keyof ControllerOutput> {
        return ['iir', 'ibolus']
    }

    override reset(t: Date): void {
        super.reset(t)
        this.deliveredBolusIndexes.clear()
    }

    update(t: Date, _s: TracedMeasurement): void {
        const basalRate = basalAt(t, this.basalSchedule, this.tempBasals, this.utcOffsetMin)
        const dueBoluses = this.boluses
            .map((bolus, index) => ({ bolus, index }))
            .filter(({ bolus, index }) => !this.deliveredBolusIndexes.has(index) && bolus.time <= t)
        const bolusU = dueBoluses.reduce((total, item) => total + item.bolus.insulin, 0)

        for (const item of dueBoluses) {
            this.deliveredBolusIndexes.add(item.index)
        }

        this.output = {
            iir: basalRate,
            ...(bolusU > 0 ? { ibolus: round(bolusU, 3) } : {}),
        }
        this.internals = {
            reason: [
                `basal=${round(basalRate, 3)} U/h`,
                bolusU > 0 ? `delivered recorded bolus=${round(bolusU, 3)} U` : 'no recorded bolus due',
            ],
        }
    }
}

function main() {
    const glucose = readJson<NightscoutGlucoseEntry[]>('glucose.json')
    const treatments = readJson<NightscoutTreatmentRecord[]>('treatments.json')
    const profiles = readJson<NightscoutProfileDocument[]>('profile.latest.json')
    const devicestatus = readJson<Record<string, unknown>[]>('devicestatus.json')
    const profile = profiles[0]
    const profileName = profile.defaultProfile
    const profileStore = profile.store[profileName]
    const utcOffsetMin = inferUtcOffsetMin(treatments)

    const boluses = buildBoluses(treatments)
    const tempBasals = buildTempBasalIntervals(treatments)
    const meals = inferMealsFromMealBoluses(treatments, profileStore, utcOffsetMin)

    const sim = new Simulator()
    const patient = new VirtualPatientDeichmann()
    const controller = new RecordedTreatmentController(
        profileStore.basal,
        tempBasals,
        boluses,
        utcOffsetMin,
    )

    sim.setPatient(patient)
    sim.setController(controller)
    sim.setSensor(new IdealCGM())
    sim.setActuator(new StaticInsulinPump())
    sim.setMeals(meals)
    sim.setExerciseUnits([])
    sim.setOptions({
        t0: simulationStart,
        tmax: simulationEnd,
        dt: 1,
        seed: 20260706,
    })

    const results = sim.runSimulation()
    const points = resultsToReplayPoints(results)
    const exportedPoints = samplePoints(points, exportIntervalMin)
    const benchmark = benchmarkAgainstRealGlucose(points, glucose)
    const entries = simulationToEntries(exportedPoints, 'LoopInsighT1 real-record scenario')
        .map(entry => ({
            ...entry,
            app: 'LoopInsighT1',
            device: 'LoopInsighT1 real-record scenario',
            utcOffset: utcOffsetMin,
            identifier: `loopinsight-sim-${entry.date}`,
            mills: entry.date,
        }))
    const normalizedTreatments = treatments
        .filter(treatment => Date.parse(treatment.created_at) >= simulationStart.valueOf())
        .filter(treatment => Date.parse(treatment.created_at) < simulationEnd.valueOf())
        .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
    const simulatedDevicestatus = buildDeviceStatus(exportedPoints)

    fs.mkdirSync(simulatedNsDir, { recursive: true })
    writeJson(simulatedNsDir, 'entries.json', entries)
    writeJson(simulatedNsDir, 'treatments.json', normalizedTreatments)
    writeJson(simulatedNsDir, 'profile.json', [profile])
    writeJson(simulatedNsDir, 'devicestatus.json', simulatedDevicestatus)
    writeJson(simulatedNsDir, 'bundle.json', {
        entries,
        treatments: normalizedTreatments,
        profile,
        devicestatus: simulatedDevicestatus,
    })
    writeJson(path.join(outputRoot, 'simulated-points.json'), exportedPoints)
    writeJson(path.join(outputRoot, 'benchmark.json'), benchmark)
    writeJson(path.join(outputRoot, 'scenario.json'), {
        window: {
            start: simulationStart.toISOString(),
            end: simulationEnd.toISOString(),
            simulator_dt_min: 1,
            nightscout_export_step_min: exportIntervalMin,
        },
        source: {
            glucose_entries: glucose.length,
            treatments: treatments.length,
            devicestatus: devicestatus.length,
            profile: profileName,
        },
        assumptions: [
            'Nightscout treatment records drive insulin delivery; real glucose entries are used only as benchmark data.',
            'Meal Bolus records have carbs=null, so meal carbohydrates are inferred as insulin * profile carbratio at the bolus time.',
            'Temp Basal records override the profile basal rate during their recorded duration; zero-duration records are treated as instant pump annotations and ignored for interval delivery.',
            'No exercise was added because the provided Nightscout records do not encode exercise events for this day.',
        ],
        counts: {
            boluses: boluses.length,
            meal_boluses: boluses.filter(bolus => bolus.eventType === 'Meal Bolus').length,
            correction_boluses: boluses.filter(bolus => bolus.eventType === 'Correction Bolus').length,
            temp_basal_intervals: tempBasals.length,
            inferred_meals: meals.length,
        },
        totals: {
            recorded_bolus_u: round(boluses.reduce((total, bolus) => total + bolus.insulin, 0), 2),
            inferred_carbs_g: round(meals.reduce((total, meal) => total + meal.carbs, 0), 1),
            simulated_entries: entries.length,
        },
        benchmark,
    })

    console.log('Wrote real-record scenario outputs to', outputRoot)
    console.log('Nightscout simulated output:', simulatedNsDir)
    console.log('Scenario summary:', {
        sourceGlucoseEntries: glucose.length,
        sourceTreatments: treatments.length,
        boluses: boluses.length,
        tempBasalIntervals: tempBasals.length,
        inferredMeals: meals.length,
        inferredCarbsG: round(meals.reduce((total, meal) => total + meal.carbs, 0), 1),
        exportedSgvEntries: entries.length,
        benchmark,
    })
}

function readJson<T>(fileName: string): T {
    return JSON.parse(fs.readFileSync(path.join(sourceDir, fileName), 'utf8')) as T
}

function writeJson(filePathOrDir: string, fileNameOrValue: string | unknown, maybeValue?: unknown) {
    const filePath = maybeValue === undefined
        ? filePathOrDir
        : path.join(filePathOrDir, fileNameOrValue as string)
    const value = maybeValue === undefined ? fileNameOrValue : maybeValue
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2))
}

function buildBoluses(treatments: NightscoutTreatmentRecord[]): BolusEvent[] {
    return treatments
        .filter(treatment => treatment.eventType === 'Meal Bolus' || treatment.eventType === 'Correction Bolus')
        .filter(treatment => (treatment.insulin ?? 0) > 0)
        .map(treatment => ({
            time: new Date(treatment.date ?? Date.parse(treatment.created_at)),
            insulin: treatment.insulin!,
            eventType: treatment.eventType as 'Meal Bolus' | 'Correction Bolus',
        }))
        .sort((a, b) => a.time.valueOf() - b.time.valueOf())
}

function buildTempBasalIntervals(treatments: NightscoutTreatmentRecord[]): TempBasalInterval[] {
    return treatments
        .filter(treatment => treatment.eventType === 'Temp Basal')
        .filter(treatment => Number.isFinite(treatment.date ?? Date.parse(treatment.created_at)))
        .map(treatment => {
            const start = new Date(treatment.date ?? Date.parse(treatment.created_at))
            const duration = treatment.duration ?? 0
            return {
                start,
                end: new Date(start.valueOf() + Math.max(duration, 0) * 60e3),
                rate: Number(treatment.rate ?? treatment.absolute ?? 0),
            }
        })
        .filter(interval => interval.end > interval.start)
        .sort((a, b) => a.start.valueOf() - b.start.valueOf())
}

function inferMealsFromMealBoluses(
    treatments: NightscoutTreatmentRecord[],
    profile: NightscoutProfileStore,
    utcOffsetMin: number,
): Meal[] {
    return treatments
        .filter(treatment => treatment.eventType === 'Meal Bolus')
        .filter(treatment => (treatment.insulin ?? 0) > 0)
        .map(treatment => {
            const start = new Date(treatment.date ?? Date.parse(treatment.created_at))
            const carbRatio = scheduleValueAt(start, profile.carbratio, utcOffsetMin)
            const recordedCarbs = treatment.carbs ?? 0
            const inferredCarbs = recordedCarbs > 0 ? recordedCarbs : treatment.insulin! * carbRatio
            return {
                start,
                duration: 45,
                carbs: round(inferredCarbs, 1),
                announcement: {
                    time: start,
                    start,
                    carbs: round(inferredCarbs, 1),
                },
            }
        })
        .sort((a, b) => a.start.valueOf() - b.start.valueOf())
}

function basalAt(
    t: Date,
    basalSchedule: ProfileScheduleEntry[],
    tempBasals: TempBasalInterval[],
    utcOffsetMin: number,
): number {
    const activeTempBasal = findLast(tempBasals, interval => t >= interval.start && t < interval.end)
    return activeTempBasal?.rate ?? scheduleValueAt(t, basalSchedule, utcOffsetMin)
}

function scheduleValueAt(t: Date, schedule: ProfileScheduleEntry[], utcOffsetMin: number): number {
    const local = new Date(t.valueOf() + utcOffsetMin * 60e3)
    const seconds = local.getUTCHours() * 3600 + local.getUTCMinutes() * 60 + local.getUTCSeconds()
    const sorted = [...schedule].sort((a, b) => a.timeAsSeconds - b.timeAsSeconds)
    return (findLast(sorted, item => item.timeAsSeconds <= seconds) ?? sorted[sorted.length - 1] ?? sorted[0]).value
}

function inferUtcOffsetMin(treatments: NightscoutTreatmentRecord[]): number {
    return treatments.find(treatment => Number.isFinite(treatment.utcOffset))?.utcOffset ?? 0
}

function resultsToReplayPoints(results: SimulationResult[]): ReplayPoint[] {
    return results.map((result, index) => {
        const previous = index > 0 ? results[index - 1] : undefined
        const dtMin = previous ? (result.t.valueOf() - previous.t.valueOf()) / 60e3 : 0
        const trend = previous && dtMin > 0 ? (result.y.Gp - previous.y.Gp) / dtMin : null
        return {
            time: result.t.toISOString(),
            glucose_mgdl: round(result.y.Gp, 2),
            carbs_g_per_min: round(result.u.carbs ?? 0, 3),
            exercise_percent: 0,
            insulin_u_per_hr: round(result.u.iir ?? 0, 3),
            basal_u_per_hr: round(result.c.iir ?? 0, 3),
            bolus_u: result.c.ibolus,
            agent_state: {
                time: result.t.toISOString(),
                current_glucose_mgdl: round(result.y.Gp, 2),
                trend_mgdl_per_min: trend === null ? null : round(trend, 3),
                trend: trend === null ? 'unknown' : trend > 1 ? 'rising' : trend < -1 ? 'falling' : 'stable',
                pending_meals: [],
                recent_bolus_u: result.c.ibolus ?? 0,
                minutes_since_last_bolus: null,
                data_quality: 'complete',
                recent_risk: [],
            },
        }
    })
}

function samplePoints(points: ReplayPoint[], intervalMin: number): ReplayPoint[] {
    const intervalMs = intervalMin * 60e3
    return points.filter(point => Date.parse(point.time) % intervalMs === 0)
}

function benchmarkAgainstRealGlucose(points: ReplayPoint[], realEntries: NightscoutGlucoseEntry[]) {
    const byMinute = new Map(points.map(point => [roundToMinute(Date.parse(point.time)), point]))
    const pairs = realEntries
        .map(real => {
            const point = byMinute.get(roundToMinute(real.date))
            return point ? {
                time: new Date(real.date).toISOString(),
                real_mgdl: real.sgv,
                simulated_mgdl: point.glucose_mgdl,
                error_mgdl: round(point.glucose_mgdl - real.sgv, 2),
            } : undefined
        })
        .filter((pair): pair is NonNullable<typeof pair> => Boolean(pair))
    const errors = pairs.map(pair => pair.error_mgdl)
    const mae = errors.reduce((total, error) => total + Math.abs(error), 0) / errors.length
    const bias = errors.reduce((total, error) => total + error, 0) / errors.length
    const rmse = Math.sqrt(errors.reduce((total, error) => total + error ** 2, 0) / errors.length)
    return {
        matched_real_points: pairs.length,
        source_real_points: realEntries.length,
        mae_mgdl: round(mae, 2),
        rmse_mgdl: round(rmse, 2),
        bias_mgdl: round(bias, 2),
        max_abs_error_mgdl: round(Math.max(...errors.map(error => Math.abs(error))), 2),
        first_pairs: pairs.slice(0, 8),
        last_pairs: pairs.slice(-8),
    }
}

function buildDeviceStatus(points: DemoPointForNightscout[]): NightscoutDeviceStatus[] {
    return points.map(point => ({
        device: 'LoopInsighT1 real-record scenario',
        created_at: point.time,
        date: Date.parse(point.time),
        openaps: {
            suggested: {
                timestamp: point.time,
                bg: Math.round(point.glucose_mgdl),
                tick: trendTick(point.agent_state?.trend_mgdl_per_min ?? null),
                eventualBG: null,
                targetBG: 100,
                insulinReq: point.bolus_u ? round(point.bolus_u, 2) : undefined,
                rate: round(point.insulin_u_per_hr ?? 0, 3),
                duration: 5,
                reason: 'Simulation driven by recorded Nightscout treatments.',
                safetyFlags: [],
            },
            enacted: {
                timestamp: point.time,
                rate: round(point.insulin_u_per_hr ?? 0, 3),
                duration: 5,
                bolus: point.bolus_u ? round(point.bolus_u, 2) : undefined,
                received: true,
                reason: 'Recorded treatment replay applied to simulator.',
            },
        },
    }))
}

function trendTick(trend: number | null): string {
    if (trend === null) return '?'
    const rounded = Math.round(trend)
    return rounded > 0 ? `+${rounded}` : `${rounded}`
}

function roundToMinute(ms: number): number {
    return Math.round(ms / 60e3) * 60e3
}

function round(value: number, digits = 2): number {
    const factor = 10 ** digits
    return Math.round(value * factor) / factor
}

function findLast<T>(items: T[], predicate: (item: T) => boolean): T | undefined {
    for (let index = items.length - 1; index >= 0; index -= 1) {
        if (predicate(items[index])) {
            return items[index]
        }
    }
    return undefined
}

main()
