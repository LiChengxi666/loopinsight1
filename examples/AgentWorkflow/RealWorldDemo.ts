import * as fs from 'node:fs'
import * as path from 'node:path'
import { buildDeterministicGlucoseFeatures } from './GlucoseStateBuilder.js'

type NightscoutEntry = {
    _id?: string
    date?: number
    dateString?: string
    sgv?: number
    type?: string
}

type NightscoutTreatment = {
    _id?: string
    created_at?: string
    timestamp?: string
    eventType?: string
    insulin?: number
    carbs?: number
}

const baseUrl = (process.env.DEMO_NIGHTSCOUT_URL || '').replace(/\/$/, '')
if (!baseUrl) {
    throw new Error('DEMO_NIGHTSCOUT_URL is required; real patient data must remain local.')
}
const startIso = process.env.DEMO_START || ''
const endIso = process.env.DEMO_END || ''
const outputDir = path.join(process.cwd(), 'examples', 'AgentWorkflow', 'output', 'real-world-demo')

async function main() {
    const start = new Date(startIso)
    const end = new Date(endIso)
    if (!Number.isFinite(start.valueOf()) || !Number.isFinite(end.valueOf()) || start >= end) {
        throw new Error('DEMO_START and DEMO_END must be a valid increasing ISO time range')
    }

    const [rawEntries, rawTreatments] = await Promise.all([
        fetchJson<NightscoutEntry[]>(entriesUrl(start, end)),
        fetchJson<NightscoutTreatment[]>(treatmentsUrl(start, end)),
    ])
    const entries = normalizeEntries(rawEntries, start, end)
    const treatments = normalizeTreatments(rawTreatments, start, end)
    if (!entries.length) throw new Error('Nightscout returned no valid glucose entries')

    const readings = entries.map(entry => ({
        time: new Date(entry.date!),
        glucoseMgdl: entry.sgv!,
    }))
    const values = readings.map(reading => reading.glucoseMgdl)
    const expectedReadings = Math.round((end.valueOf() - start.valueOf()) / (5 * 60e3))
    const mean = average(values)
    const stdDev = Math.sqrt(average(values.map(value => Math.pow(value - mean, 2))))
    const features = buildDeterministicGlucoseFeatures(readings, readings.at(-1)!.time)
    const summary = {
        schemaVersion: 'real-world-demo-v1',
        source: {
            kind: 'nightscout',
            baseUrl,
            start: start.toISOString(),
            end: end.toISOString(),
            timezoneInterpretation: 'UTC range exactly as provided',
        },
        dataQuality: {
            expectedFiveMinuteReadings: expectedReadings,
            validReadings: entries.length,
            coveragePercent: round(entries.length / expectedReadings * 100, 1),
            duplicateTimestampsRemoved: rawEntries.length - entries.length,
            longestGapMin: longestGapMinutes(readings),
        },
        glucose: {
            meanMgdl: round(mean, 1),
            standardDeviationMgdl: round(stdDev, 1),
            cvPercent: round(stdDev / mean * 100, 1),
            minMgdl: Math.min(...values),
            maxMgdl: Math.max(...values),
            tirPercent: percent(values, value => value >= 70 && value <= 180),
            tbrPercent: percent(values, value => value < 70),
            tarPercent: percent(values, value => value > 180),
            endOfWindowFeatures: features,
        },
        treatments: summarizeTreatments(treatments),
        simulationBoundary: {
            calibratedVirtualPatient: false,
            note: 'This dataset is suitable for historical replay and Agent state/report demos. It must not be presented as a calibrated patient simulation without parameter identification and validation.',
        },
    }

    fs.mkdirSync(outputDir, { recursive: true })
    fs.writeFileSync(path.join(outputDir, 'entries.json'), JSON.stringify(entries, null, 2))
    fs.writeFileSync(path.join(outputDir, 'treatments.json'), JSON.stringify(treatments, null, 2))
    fs.writeFileSync(path.join(outputDir, 'summary.json'), JSON.stringify(summary, null, 2))
    fs.writeFileSync(path.join(outputDir, 'bundle.json'), JSON.stringify({ summary, entries, treatments }, null, 2))

    console.log(JSON.stringify({
        outputDir,
        entries: entries.length,
        treatments: treatments.length,
        coveragePercent: summary.dataQuality.coveragePercent,
        validation: 'passed',
    }, null, 2))
}

function entriesUrl(start: Date, end: Date): URL {
    const url = new URL(`${baseUrl}/api/v1/entries.json`)
    url.searchParams.set('find[date][$gte]', String(start.valueOf()))
    url.searchParams.set('find[date][$lt]', String(end.valueOf()))
    url.searchParams.set('count', '288')
    return url
}

function treatmentsUrl(start: Date, end: Date): URL {
    const url = new URL(`${baseUrl}/api/v1/treatments.json`)
    url.searchParams.set('find[created_at][$gte]', start.toISOString())
    url.searchParams.set('find[created_at][$lt]', end.toISOString())
    return url
}

async function fetchJson<T>(url: URL): Promise<T> {
    const response = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!response.ok) throw new Error(`Nightscout request failed with HTTP ${response.status}`)
    const value: unknown = await response.json()
    if (!Array.isArray(value)) throw new Error('Nightscout response is not a JSON array')
    return value as T
}

function normalizeEntries(
    raw: NightscoutEntry[],
    start: Date,
    end: Date,
): NightscoutEntry[] {
    const byDate = new Map<number, NightscoutEntry>()
    for (const entry of raw) {
        const date = Number(entry.date) || Date.parse(entry.dateString ?? '')
        const sgv = Number(entry.sgv)
        if (
            !Number.isFinite(date)
            || !Number.isFinite(sgv)
            || sgv < 20
            || sgv > 600
            || date < start.valueOf()
            || date >= end.valueOf()
        ) continue
        byDate.set(date, { ...entry, date, sgv })
    }
    return [...byDate.values()].sort((a, b) => a.date! - b.date!)
}

function normalizeTreatments(
    raw: NightscoutTreatment[],
    start: Date,
    end: Date,
): NightscoutTreatment[] {
    return raw.filter(item => {
        const date = Date.parse(item.created_at || item.timestamp || '')
        return Number.isFinite(date) && date >= start.valueOf() && date < end.valueOf()
    })
}

function summarizeTreatments(treatments: NightscoutTreatment[]) {
    const byEventType: Record<string, number> = {}
    let insulinTotalU = 0
    let carbsTotalG = 0
    for (const item of treatments) {
        const eventType = item.eventType || 'Unknown'
        byEventType[eventType] = (byEventType[eventType] ?? 0) + 1
        if (Number.isFinite(Number(item.insulin))) insulinTotalU += Number(item.insulin)
        if (Number.isFinite(Number(item.carbs))) carbsTotalG += Number(item.carbs)
    }
    return {
        validRecords: treatments.length,
        insulinTotalU: round(insulinTotalU, 2),
        carbsTotalG: round(carbsTotalG, 1),
        byEventType,
    }
}

function longestGapMinutes(readings: Array<{ time: Date }>): number | null {
    if (readings.length < 2) return null
    let longest = 0
    for (let index = 1; index < readings.length; index += 1) {
        longest = Math.max(longest, (readings[index].time.valueOf() - readings[index - 1].time.valueOf()) / 60e3)
    }
    return round(longest, 1)
}

function average(values: number[]): number {
    return values.reduce((sum, value) => sum + value, 0) / values.length
}

function percent(values: number[], predicate: (value: number) => boolean): number {
    return round(values.filter(predicate).length / values.length * 100, 1)
}

function round(value: number, digits: number): number {
    const factor = Math.pow(10, digits)
    return Math.round(value * factor) / factor
}

main().catch(error => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
})
