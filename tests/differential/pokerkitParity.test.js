// PokerKit 차등 리플레이 게이트 (docs/DIFFERENTIAL_REPLAY.md).
// golden fixture 원장을 (1) 우리 detailedHandEngine 생산 경로로 재생하고
// (2) 커밋된 PokerKit 골든 트레이스와 결정 단위로 대조한다. Python 없이 항상 돈다 —
// 골든 재생성은 scripts/differential/pokerkit_replay.py (pokerkit==0.7.4).
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { driveFixture } from './lib/driveFixture.js';
import { compareTraces } from './lib/compareTraces.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, 'fixtures');
const goldenDir = join(here, 'golden', 'pokerkit');

const fixtures = readdirSync(fixtureDir)
    .filter(name => name.endsWith('.json'))
    .sort()
    .map(name => JSON.parse(readFileSync(join(fixtureDir, name), 'utf8')));

describe('PokerKit differential replay', () => {
    it('fixture와 골든 트레이스가 1:1로 존재한다', () => {
        expect(fixtures.length).toBeGreaterThanOrEqual(13);
        const goldens = readdirSync(goldenDir).filter(name => name.endsWith('.trace.json')).sort();
        expect(goldens).toEqual(fixtures.map(fixture => `${fixture.id}.trace.json`));
    });

    for (const fixture of fixtures) {
        it(`${fixture.id}: 팟·스택·합법액션·사이드팟이 PokerKit과 일치한다`, () => {
            const { trace } = driveFixture(fixture);
            const golden = JSON.parse(readFileSync(join(goldenDir, `${fixture.id}.trace.json`), 'utf8'));
            expect(golden.traceVersion).toBe(trace.traceVersion);
            const problems = compareTraces(fixture, trace, golden);
            expect(problems).toEqual([]);
        });
    }
});
