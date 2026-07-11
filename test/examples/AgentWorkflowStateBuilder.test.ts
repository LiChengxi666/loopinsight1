import { expect } from 'chai'
import {
    buildDeterministicGlucoseFeatures,
    classifyDetailedTrend,
} from '../../examples/AgentWorkflow/GlucoseStateBuilder.js'

describe('AgentWorkflow deterministic glucose state builder', () => {
    const now = new Date('2025-01-01T12:00:00.000Z')

    it('calculates trend from numeric readings rather than a text direction', () => {
        const readings = Array.from({ length: 7 }, (_, index) => ({
            time: new Date(now.valueOf() - (30 - index * 5) * 60e3),
            glucoseMgdl: 100 + index * 6,
        }))
        const result = buildDeterministicGlucoseFeatures(readings, now)
        expect(result.slope30Min).to.equal(1.2)
        expect(result.trend).to.equal('rising')
        expect(result.trendMethod).to.equal('linear_regression_30m')
        expect(result.projected30MinMgdl).to.equal(172)
        expect(result.dataQuality).to.equal('complete')
    })

    it('does not label a trend when fewer than three points exist', () => {
        const result = buildDeterministicGlucoseFeatures([
            { time: new Date(now.valueOf() - 5 * 60e3), glucoseMgdl: 100 },
            { time: now, glucoseMgdl: 110 },
        ], now)
        expect(result.slope30Min).to.equal(null)
        expect(result.trend).to.equal('unknown')
        expect(result.dataQuality).to.equal('missing_glucose')
    })

    it('uses explicit boundary values', () => {
        expect(classifyDetailedTrend(2)).to.equal('rapidly_rising')
        expect(classifyDetailedTrend(0.29)).to.equal('stable')
        expect(classifyDetailedTrend(-2)).to.equal('rapidly_falling')
    })
})
