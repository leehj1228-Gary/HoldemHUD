import { describe, expect, it } from 'vitest';
import { MODE_CLAIM_RULES, validateModeClaims } from '../../src/analysis/validation/validateModeClaims.js';
import { ANALYSIS_MODES, IMPLEMENTED_ANALYSIS_MODES } from '../../src/analysis/contracts/capabilities.js';

// 현재 heuristic 리뷰 스타일의 안전한 결과 형태 (detailedReview validator가 통과시키는 종류).
function safeResult() {
    return {
        schemaVersion: 'poker-analysis-result.v1',
        analysisMode: 'heuristic_no_solver',
        computedFacts: {},
        baselineStrategy: [],
        exploitAdjustment: { applied: false },
        recommendation: { primaryAction: 'call', sizeTo: null, mixed: false, alternatives: [] },
        confidence: { overall: 0.42 },
        explanation: {
            headline: '콜은 검토 가능한 휴리스틱 선택입니다.',
            reasoning: [{
                text: '결정 직전 팟오즈와 실제 액션을 함께 확인해야 합니다.',
                factRefs: ['state.potOddsRequiredPct'],
            }],
            alternatives: [{ action: 'raise', condition: '상대의 베팅 범위가 매우 넓다고 판단될 때', factRefs: [] }],
            studyQuestions: ['콜 당시 상대의 가치 범위를 어떻게 예상했나요?'],
        },
        provenance: [],
    };
}

describe('MODE_CLAIM_RULES 표', () => {
    it('연구 §14.4의 5개 mode 전부에 행이 있고, 구현 표시는 heuristic뿐이다', () => {
        expect(Object.keys(MODE_CLAIM_RULES).sort()).toEqual([...ANALYSIS_MODES].sort());
        const implemented = Object.entries(MODE_CLAIM_RULES)
            .filter(([, rules]) => rules.implemented)
            .map(([mode]) => mode);
        expect(implemented).toEqual(IMPLEMENTED_ANALYSIS_MODES);
    });

    it('heuristic 행은 detailedReview와 같은 confidence cap(0.45)을 쓴다', () => {
        expect(MODE_CLAIM_RULES.heuristic_no_solver.confidenceCap).toBe(0.45);
    });
});

describe('validateModeClaims — heuristic_no_solver', () => {
    it('현재 스타일의 안전한 결과를 통과시킨다', () => {
        expect(validateModeClaims(safeResult())).toEqual({ ok: true, errors: [] });
    });

    it('금지 주장 클래스를 각각 거부한다: GTO/솔버 어휘', () => {
        const gto = safeResult();
        gto.explanation.headline = '이 콜은 GTO 관점에서 완벽합니다.';
        expect(validateModeClaims(gto).errors.join('\n')).toMatch(/forbidden claim vocabulary/);

        const solver = safeResult();
        solver.explanation.reasoning[0].text = '솔버 기준으로 확인된 라인입니다.';
        expect(validateModeClaims(solver).ok).toBe(false);
    });

    it('금지 주장 클래스를 각각 거부한다: 에쿼티/기대값(EV) 어휘', () => {
        const equity = safeResult();
        equity.explanation.reasoning[0].text = '이 콜의 에쿼티는 충분합니다.';
        expect(validateModeClaims(equity).ok).toBe(false);

        const ev = safeResult();
        ev.explanation.reasoning[0].text = '기대값이 높은 선택입니다.';
        expect(validateModeClaims(ev).ok).toBe(false);
    });

    it('금지 주장 클래스를 각각 거부한다: 정확한 퍼센트', () => {
        const percent = safeResult();
        percent.explanation.reasoning[0].text = '상대의 블러프는 45% 정도입니다.';
        expect(validateModeClaims(percent).errors.join('\n')).toMatch(/exact percentage/);
    });

    it('금지 주장 클래스를 각각 거부한다: 수치 equity/EV/frequency', () => {
        const equity = safeResult();
        equity.computedFacts.equity = { value: 0.42, method: 'guess' };
        expect(validateModeClaims(equity).errors.join('\n')).toMatch(/numeric equity is not allowed/);

        const ev = safeResult();
        ev.baselineStrategy = [{ action: 'call', frequency: null, evBb: -0.3, method: 'guess' }];
        expect(validateModeClaims(ev).errors.join('\n')).toMatch(/numeric EV is not allowed/);

        const frequency = safeResult();
        frequency.baselineStrategy = [{ action: 'call', frequency: 0.5, evBb: null, method: 'guess' }];
        expect(validateModeClaims(frequency).errors.join('\n')).toMatch(/strategy frequency is not allowed/);
    });

    it('금지 주장 클래스를 각각 거부한다: exploit 적용과 confidence cap 초과', () => {
        const exploit = safeResult();
        exploit.exploitAdjustment = { applied: true, evidenceRefs: ['stat:1'], maximumShift: 0.1 };
        expect(validateModeClaims(exploit).errors.join('\n')).toMatch(/exploit adjustment is not allowed/);

        const confident = safeResult();
        confident.confidence.overall = 0.9;
        expect(validateModeClaims(confident).errors.join('\n')).toMatch(/must not exceed 0\.45/);
    });

    it('기계 참조 필드(factRefs)는 어휘 검사 대상이 아니다', () => {
        const result = safeResult();
        result.explanation.reasoning[0].factRefs = ['state.heroSprBefore']; // 'ev' 유사 substring 없음이 보장될 필요 없음
        expect(validateModeClaims(result).ok).toBe(true);
    });
});

describe('validateModeClaims — forward-compat 행', () => {
    it('range_estimated: equity 수치에는 선언된 rangeId가 필요하다', () => {
        const result = safeResult();
        result.analysisMode = 'range_estimated';
        result.computedFacts.equity = { value: 0.31, method: 'monte_carlo', againstRangeId: 'range:v:1' };
        result.rangeAssumptions = [];
        expect(validateModeClaims(result).errors.join('\n')).toMatch(/againstRangeId/);

        result.rangeAssumptions = [{ rangeId: 'range:v:1', source: 'action_likelihood_model', confidence: 0.5 }];
        expect(validateModeClaims(result).ok).toBe(true);
    });

    it('solver_calibrated: frequency/EV 수치에는 engine/version provenance가 필요하다', () => {
        const result = safeResult();
        result.analysisMode = 'solver_calibrated';
        result.baselineStrategy = [
            { action: 'fold', frequency: 0.7, evBb: 0, method: 'local_solver', provenanceRef: 'solver:1' },
        ];
        result.provenance = [{ id: 'solver:1', type: 'solver' }]; // engine/version 누락
        expect(validateModeClaims(result).errors.join('\n')).toMatch(/requires provenance with engine and version/);

        result.provenance = [{ id: 'solver:1', type: 'solver', engine: 'internal-river-solver', version: '0.3.0' }];
        expect(validateModeClaims(result).ok).toBe(true);
    });

    it('exploit_adjusted: 적용된 조정에는 근거와 shift cap이 필요하다', () => {
        const result = safeResult();
        result.analysisMode = 'exploit_adjusted';
        result.exploitAdjustment = { applied: true, evidenceRefs: [], maximumShift: null };
        const { errors } = validateModeClaims(result);
        expect(errors.join('\n')).toMatch(/non-empty evidence/);
        expect(errors.join('\n')).toMatch(/finite shift cap/);

        result.exploitAdjustment = { applied: true, evidenceRefs: ['stat:river_bluff:1'], maximumShift: 0.1 };
        expect(validateModeClaims(result).ok).toBe(true);
    });

    it('알 수 없는 mode는 거부한다', () => {
        const result = safeResult();
        result.analysisMode = 'magic_oracle';
        expect(validateModeClaims(result).ok).toBe(false);
    });
});
