export type GlucoseReading = {
    time: Date
    glucoseMgdl: number
}

export type DeterministicGlucoseFeatures = {
    currentGlucoseMgdl: number | null
    currentAt: string | null
    slope15Min: number | null
    slope30Min: number | null
    slope60Min: number | null
    trend: 'rising' | 'falling' | 'stable' | 'unknown'
    trendDetail:
        | 'rapidly_rising'
        | 'rising'
        | 'gently_rising'
        | 'stable'
        | 'gently_falling'
        | 'falling'
        | 'rapidly_falling'
        | 'unknown'
    trendMethod: 'linear_regression_30m'
    trendSampleCount: number
    projected30MinMgdl: number | null
    dataQuality: 'complete' | 'stale' | 'missing_glucose'
}

export function buildDeterministicGlucoseFeatures(
    readings: GlucoseReading[],
    now: Date,
): DeterministicGlucoseFeatures {
    const valid = readings
        .filter(reading =>
            Number.isFinite(reading.glucoseMgdl)
            && reading.glucoseMgdl >= 20
            && reading.glucoseMgdl <= 600
            && reading.time <= now,
        )
        .sort((a, b) => a.time.valueOf() - b.time.valueOf())
        .filter((reading, index, values) =>
            index === values.length - 1
            || reading.time.valueOf() !== values[index + 1].time.valueOf(),
        )

    const current = valid.at(-1) ?? null
    const points15 = withinMinutes(valid, now, 15)
    const points30 = withinMinutes(valid, now, 30)
    const points60 = withinMinutes(valid, now, 60)
    const slope15 = regressionSlope(points15)
    const slope30 = regressionSlope(points30)
    const slope60 = regressionSlope(points60)
    const trendDetail = classifyDetailedTrend(slope30)
    const latestAgeMin = current
        ? (now.valueOf() - current.time.valueOf()) / 60e3
        : null

    return {
        currentGlucoseMgdl: current?.glucoseMgdl ?? null,
        currentAt: current?.time.toISOString() ?? null,
        slope15Min: slope15,
        slope30Min: slope30,
        slope60Min: slope60,
        trend: simplifyTrend(trendDetail),
        trendDetail,
        trendMethod: 'linear_regression_30m',
        trendSampleCount: points30.length,
        projected30MinMgdl:
            current && slope30 !== null
                ? round(current.glucoseMgdl + slope30 * 30, 1)
                : null,
        dataQuality:
            !current || points30.length < 3
                ? 'missing_glucose'
                : (latestAgeMin ?? Infinity) > 15
                    ? 'stale'
                    : 'complete',
    }
}

export function classifyDetailedTrend(
    slopeMgdlPerMin: number | null,
): DeterministicGlucoseFeatures['trendDetail'] {
    if (slopeMgdlPerMin === null) return 'unknown'
    if (slopeMgdlPerMin >= 2) return 'rapidly_rising'
    if (slopeMgdlPerMin >= 1) return 'rising'
    if (slopeMgdlPerMin >= 0.3) return 'gently_rising'
    if (slopeMgdlPerMin > -0.3) return 'stable'
    if (slopeMgdlPerMin > -1) return 'gently_falling'
    if (slopeMgdlPerMin > -2) return 'falling'
    return 'rapidly_falling'
}

function withinMinutes(
    readings: GlucoseReading[],
    now: Date,
    minutes: number,
): GlucoseReading[] {
    const cutoff = now.valueOf() - minutes * 60e3
    return readings.filter(reading => reading.time.valueOf() >= cutoff)
}

function regressionSlope(readings: GlucoseReading[]): number | null {
    if (readings.length < 3) return null
    const origin = readings[0].time.valueOf()
    const xs = readings.map(reading => (reading.time.valueOf() - origin) / 60e3)
    const ys = readings.map(reading => reading.glucoseMgdl)
    const meanX = xs.reduce((sum, value) => sum + value, 0) / xs.length
    const meanY = ys.reduce((sum, value) => sum + value, 0) / ys.length
    let numerator = 0
    let denominator = 0
    for (let index = 0; index < readings.length; index += 1) {
        numerator += (xs[index] - meanX) * (ys[index] - meanY)
        denominator += Math.pow(xs[index] - meanX, 2)
    }
    return denominator === 0 ? null : numerator / denominator
}

function simplifyTrend(
    detail: DeterministicGlucoseFeatures['trendDetail'],
): DeterministicGlucoseFeatures['trend'] {
    if (detail.includes('rising')) return 'rising'
    if (detail.includes('falling')) return 'falling'
    if (detail === 'stable') return 'stable'
    return 'unknown'
}

function round(value: number, digits: number): number {
    const factor = Math.pow(10, digits)
    return Math.round(value * factor) / factor
}
