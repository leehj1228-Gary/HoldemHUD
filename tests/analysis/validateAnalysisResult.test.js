import { describe, expect, it, beforeAll } from 'vitest';
import { buildDecisionSnapshot } from '../../src/analysis/snapshot/buildDecisionSnapshot.js';
import { validateAnalysisResult } from '../../src/analysis/contracts/analysisResult.js';

function action(seq, street, seat, type, amountTo, amountAdded) {
    return {
        seq, street, seat,
        name: seat === 0 ? 'Hero Real Name' : 'Villain Real Name',
        position: seat === 0 ? 'BTN' : 'BB',
        type, raiseLevel: 0, amountTo, amountAdded, precision: 'exact', isAllIn: false,
    };
}

function smallHand() {
    return {
        id: 'hand_result',
        handNo: 1,
        dealerSeat: 0,
        straddleCount: 0,
        blinds: { sb: 1, bb: 2 },
        seats: [
            { seat: 0, name: 'Hero Real Name', position: 'BTN', sittingOut: false },
            { seat: 1, name: 'Villain Real Name', position: 'BB', sittingOut: false },
        ],
        actions: [
            action(0, 'preflop', 0, 'call', 2, 1),
            action(1, 'preflop', 1, 'check', 2, 0),
            action(2, 'flop', 1, 'bet', 4, 4),
            action(3, 'flop', 0, 'call', 4, 4),
        ],
        detailed: {
            enabled: true,
            heroSeat: 0,
            chipUnit: 1,
            startingStacks: { 0: 200, 1: 200 },
            street: 'flop',
            board: { flop: ['Qs', '7h', '2c'], turn: [], river: [] },
            heroCards: ['Ah', 'Qh'],
            reveals: [],
            completed: false,
            winners: [],
        },
    };
}

let snapshot;
beforeAll(async () => {
    snapshot = await buildDecisionSnapshot(smallHand(), 3);
});

// 현재 heuristic 리뷰 스타일의 안전한 결과 (수치 전략 주장 없음, 한국어, 근거 참조).
function safeHeuristicResult() {
    return {
        schemaVersion: 'poker-analysis-result.v1',
        decisionId: snapshot.decisionId,
        inputHash: snapshot.provenance.inputHash,
        analysisMode: 'heuristic_no_solver',
        computedFacts: {},
        baselineStrategy: [],
        exploitAdjustment: { applied: false },
        recommendation: { primaryAction: 'call', sizeTo: null, mixed: false, alternatives: ['fold'] },
        confidence: { overall: 0.4 },
        explanation: {
            headline: '콜은 팟오즈 기준으로 검토 가능한 선택입니다.',
            reasoning: [{
                text: '상대의 플랍 베팅 크기와 요구 승산을 함께 볼 필요가 있습니다.',
                factRefs: ['state.potOddsRequiredPct', 'priorActions:2'],
            }],
            alternatives: [],
            studyQuestions: ['당시 상대의 가치 범위를 어떻게 추정했나요?'],
        },
        unknowns: ['상대의 플랍 베팅 범위'],
        warnings: [],
        provenance: [],
        timing: null,
    };
}

describe('validateAnalysisResult — 구조 불변조건', () => {
    it('현재 스타일의 안전한 heuristic 결과를 통과시킨다', () => {
        expect(validateAnalysisResult(safeHeuristicResult(), snapshot)).toEqual({ ok: true, errors: [] });
    });

    it('snapshot legal option에 없는 추천 액션을 거부한다', () => {
        const result = safeHeuristicResult();
        result.recommendation.primaryAction = 'check';
        const { ok, errors } = validateAnalysisResult(result, snapshot);
        expect(ok).toBe(false);
        expect(errors.join('\n')).toMatch(/must be one of the snapshot legal options/);
    });

    it('legal bound 밖의 사이즈를 거부한다 (위/아래 모두)', () => {
        const tooBig = safeHeuristicResult();
        tooBig.recommendation = { primaryAction: 'raise', sizeTo: 500, mixed: false, alternatives: [] };
        expect(validateAnalysisResult(tooBig, snapshot).errors.join('\n')).toMatch(/above the legal maximum/);

        const tooSmall = safeHeuristicResult();
        tooSmall.recommendation = { primaryAction: 'raise', sizeTo: 5, mixed: false, alternatives: [] };
        expect(validateAnalysisResult(tooSmall, snapshot).errors.join('\n')).toMatch(/below the legal minimum/);
    });

    it('sizeTo는 bet/raise/all-in 외에는 허용되지 않는다', () => {
        const result = safeHeuristicResult();
        result.recommendation.sizeTo = 4; // primaryAction 'call'
        const { ok, errors } = validateAnalysisResult(result, snapshot);
        expect(ok).toBe(false);
        expect(errors.join('\n')).toMatch(/only allowed for bet\/raise\/all-in/);
    });

    it('inputHash/decisionId가 snapshot과 다르면 거부한다', () => {
        const wrongHash = safeHeuristicResult();
        wrongHash.inputHash = 'sha256:' + '0'.repeat(64);
        expect(validateAnalysisResult(wrongHash, snapshot).errors.join('\n'))
            .toMatch(/inputHash: must match/);

        const wrongDecision = safeHeuristicResult();
        wrongDecision.decisionId = 'other:seq:9';
        expect(validateAnalysisResult(wrongDecision, snapshot).errors.join('\n'))
            .toMatch(/decisionId: must match/);
    });

    it('whitelist 밖 factRef를 거부한다', () => {
        const result = safeHeuristicResult();
        result.explanation.reasoning[0].factRefs = ['showdown.cards'];
        const { ok, errors } = validateAnalysisResult(result, snapshot);
        expect(ok).toBe(false);
        expect(errors.join('\n')).toMatch(/reference is not allowed: showdown\.cards/);
    });

    it('수치 fact에는 선언된 provenance가 필요하다', () => {
        const result = safeHeuristicResult();
        result.analysisMode = 'calculator_exact';
        result.computedFacts = { outs: { value: 9, method: 'exact_enumeration' } };
        const { ok, errors } = validateAnalysisResult(result, snapshot);
        expect(ok).toBe(false);
        expect(errors.join('\n')).toMatch(/numeric fact requires a declared provenance entry/);

        result.computedFacts.outs.provenanceRef = 'calc:outs:1';
        result.provenance = [{ id: 'calc:outs:1', type: 'calculator', engine: 'internal', version: '0.1.0' }];
        expect(validateAnalysisResult(result, snapshot)).toEqual({ ok: true, errors: [] });
    });

    it('전략 frequency 합이 1에서 벗어나면 거부한다 (solver mode)', () => {
        const result = safeHeuristicResult();
        result.analysisMode = 'solver_calibrated';
        result.provenance = [{ id: 'solver:run:1', type: 'solver', engine: 'internal-river-solver', version: '0.3.0' }];
        result.baselineStrategy = [
            { action: 'fold', sizeTo: null, frequency: 0.6, evBb: 0, method: 'local_solver', provenanceRef: 'solver:run:1' },
            { action: 'call', sizeTo: null, frequency: 0.3, evBb: -0.03, method: 'local_solver', provenanceRef: 'solver:run:1' },
        ];
        const { ok, errors } = validateAnalysisResult(result, snapshot);
        expect(ok).toBe(false);
        expect(errors.join('\n')).toMatch(/frequencies must sum to 1/);

        result.baselineStrategy[1].frequency = 0.4;
        expect(validateAnalysisResult(result, snapshot)).toEqual({ ok: true, errors: [] });
    });

    it('알 수 없는 root 필드를 거부한다', () => {
        const result = safeHeuristicResult();
        result.evLoss = 12.5;
        const { ok, errors } = validateAnalysisResult(result, snapshot);
        expect(ok).toBe(false);
        expect(errors.join('\n')).toMatch(/result\.evLoss: field is not allowed/);
    });

    it('유효하지 않은 snapshot으로는 어떤 결과도 통과하지 못한다', () => {
        const broken = structuredClone(snapshot);
        broken.priorActions[0].seq = 99;
        const { ok, errors } = validateAnalysisResult(safeHeuristicResult(), broken);
        expect(ok).toBe(false);
        expect(errors.join('\n')).toMatch(/snapshot invalid/);
    });
});
