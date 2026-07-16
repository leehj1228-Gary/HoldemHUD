// 분석 게이트웨이 + capability registry + heuristic adapter 통합 테스트
// 계약: 반환은 항상 {result,...} 또는 poker-analysis-error.v1 {error} 하나.
// 검증 실패 시 adapter/LLM 미호출, 검증 실패 응답(raw)은 절대 반환되지 않는다.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { analyzeDecision } from '../../src/analysis/gateway/analysisGateway.js';
import {
    selectAdapter,
    registeredAnalysisAdapters,
    capabilityMismatchReasons,
} from '../../src/analysis/gateway/capabilityRegistry.js';
import { heuristicLlmAdapter, HEURISTIC_ADAPTER_ID } from '../../src/analysis/adapters/heuristicLlmAdapter.js';
import { createAnalysisCapabilities } from '../../src/analysis/contracts/capabilities.js';
import { validateAnalysisResult } from '../../src/analysis/contracts/analysisResult.js';
import { buildDecisionSnapshot } from '../../src/analysis/snapshot/buildDecisionSnapshot.js';
import { pseudonymFor } from '../../src/analysis/pseudonyms.js';
import {
    setAnalysisCacheStorageAdapter,
    getCachedAnalysis,
} from '../../src/storage/analysisCache.js';

const VILLAIN_ID = pseudonymFor('Villain Real Name');

// ── in-memory localStorage mock (node 환경엔 localStorage 없음) ──────────────
function memoryStorage() {
    const map = new Map();
    return {
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => { map.set(k, String(v)); },
        removeItem: (k) => { map.delete(k); },
        _map: map,
    };
}

beforeEach(() => {
    setAnalysisCacheStorageAdapter(memoryStorage());
});

afterEach(() => {
    setAnalysisCacheStorageAdapter(null);
});

// ── 픽스처: buildDecisionSnapshot.test.js와 같은 2인 상세 핸드 (결정 seq 3 = flop call) ──
function action(seq, street, seat, type, amountTo, amountAdded, extra = {}) {
    return {
        seq,
        street,
        seat,
        name: seat === 0 ? 'Hero Real Name' : 'Villain Real Name',
        position: seat === 0 ? 'BTN' : 'BB',
        type,
        raiseLevel: 0,
        amountTo,
        amountAdded,
        precision: 'exact',
        isAllIn: false,
        ...extra,
    };
}

function completedHand() {
    return {
        id: 'hand_gateway_fixture',
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
            action(4, 'turn', 1, 'check', 0, 0),
        ],
        detailed: {
            enabled: true,
            heroSeat: 0,
            chipUnit: 1,
            startingStacks: { 0: 200, 1: 200 },
            street: 'turn',
            board: { flop: ['Qs', '7h', '2c'], turn: ['9h'], river: [] },
            heroCards: ['Ah', 'Qh'],
            reveals: [],
            completed: true,
            winners: [],
        },
    };
}

// snapshot에 대해 validateAnalysisResult를 통과하는 최소 envelope
function minimalResult(snapshot) {
    return {
        schemaVersion: 'poker-analysis-result.v1',
        decisionId: snapshot.decisionId,
        inputHash: snapshot.provenance.inputHash,
        analysisMode: 'heuristic_no_solver',
        recommendation: { primaryAction: snapshot.state.legalOptions[0].action },
        confidence: { overall: 0.3 },
        explanation: { headline: '휴리스틱 복기 결과입니다.', reasoning: [], alternatives: [], studyQuestions: [] },
    };
}

function stubAdapter({ id = 'stub-adapter', capabilities = {}, analyze } = {}) {
    return {
        capabilities: createAnalysisCapabilities({
            adapterId: id,
            adapterVersion: '0.0.1',
            modes: ['heuristic_no_solver'],
            maxPlayers: 10,
            supportsSidePots: true,
            ...capabilities,
        }),
        promptVersion: 'stub-prompt.v1',
        analyze,
    };
}

// detailedReview 검증을 통과하는 정상 모델 응답 (decisionId는 :aN 형식)
function validRawReview() {
    return {
        analysisMode: 'heuristic_no_solver',
        decisionId: 'hand_gateway_fixture:a3',
        assessment: 'plausible',
        confidence: { value: 0.3 },
        headline: '팟 오즈 기준으로 무난한 콜입니다',
        reasoning: [
            { text: '필요 지분 대비 콜 금액이 부담스럽지 않습니다', factRefs: ['state.potOddsRequiredPct'] },
            { text: '상대의 플랍 베팅에 대한 대응입니다', factRefs: ['priorActions:2', 'activePlayers:seat:1'] },
        ],
        alternatives: [
            { action: 'raise', condition: '보드가 히어로에게 유리하게 읽히면', why: '주도권을 가져올 수 있습니다' },
        ],
        unknowns: ['상대 성향 정보가 없습니다'],
        reflectionQuestion: null,
    };
}

describe('analysisGateway.analyzeDecision', () => {
    it('캐시 미스 → adapter 1회 → 같은 입력의 두 번째 호출은 캐시 히트로 adapter 미호출', async () => {
        const hand = completedHand();
        const snapshot = await buildDecisionSnapshot(hand, 3);
        let calls = 0;
        const adapter = stubAdapter({
            analyze: async (snap) => {
                calls += 1;
                return { result: minimalResult(snap), review: { assessment: 'plausible', street: 'flop' } };
            },
        });

        const first = await analyzeDecision({ hand, decisionSeq: 3, ai: {}, adapters: [adapter] });
        expect(first.error).toBeUndefined();
        expect(first.cached).toBe(false);
        expect(first.adapterId).toBe('stub-adapter');
        expect(calls).toBe(1);
        expect(validateAnalysisResult(first.result, snapshot)).toEqual({ ok: true, errors: [] });

        const second = await analyzeDecision({ hand, decisionSeq: 3, ai: {}, adapters: [adapter] });
        expect(second.error).toBeUndefined();
        expect(second.cached).toBe(true);
        expect(second.result).toEqual(first.result);
        expect(second.review).toEqual({ assessment: 'plausible', street: 'flop' });
        expect(calls).toBe(1); // adapter는 정확히 1회

        // bypassCache(재분석)는 캐시를 건너뛰고 다시 호출한다
        const third = await analyzeDecision({ hand, decisionSeq: 3, ai: {}, adapters: [adapter], bypassCache: true });
        expect(third.cached).toBe(false);
        expect(calls).toBe(2);
    });

    it('snapshot 빌드 실패는 adapter 호출 전에 구조화 오류로 끝난다', async () => {
        const hand = completedHand();
        let calls = 0;
        const adapter = stubAdapter({ analyze: async () => { calls += 1; return {}; } });

        // seq 2는 상대 액션 — 결정 snapshot이 만들어지지 않는다
        const outcome = await analyzeDecision({ hand, decisionSeq: 2, ai: {}, adapters: [adapter] });
        expect(outcome.result).toBeUndefined();
        expect(outcome.error).toMatchObject({
            schemaVersion: 'poker-analysis-error.v1',
            code: 'INVALID_LEDGER',
            stage: 'snapshot_build',
            decisionId: 'hand_gateway_fixture:seq:2',
        });
        expect(/[가-힣]/.test(outcome.error.userMessageKo)).toBe(true);
        expect(calls).toBe(0);

        // 핸드 자체가 없어도 동일하게 구조화 오류
        const noHand = await analyzeDecision({ hand: null, decisionSeq: 3, ai: {}, adapters: [adapter] });
        expect(noHand.error.code).toBe('INVALID_LEDGER');
        expect(calls).toBe(0);
    });

    it('claim 검증 실패 → CLAIM_VALIDATION_FAILED, 결과 미반환·캐시 미저장', async () => {
        const hand = completedHand();
        let calls = 0;
        const adapter = stubAdapter({
            analyze: async (snap) => {
                calls += 1;
                const bad = minimalResult(snap);
                bad.confidence = { overall: 0.9 }; // heuristic cap(0.45) 위반
                bad.explanation.headline = '이 액션이 GTO 최적입니다.'; // 금지 어휘
                return { result: bad, review: null };
            },
        });

        const outcome = await analyzeDecision({ hand, decisionSeq: 3, ai: {}, adapters: [adapter] });
        expect(outcome.result).toBeUndefined();
        expect(outcome.error).toMatchObject({
            schemaVersion: 'poker-analysis-error.v1',
            code: 'CLAIM_VALIDATION_FAILED',
            stage: 'result_validation',
        });
        // 사용자 메시지에 모델 원문이 섞이지 않는다
        expect(outcome.error.userMessageKo).not.toContain('GTO');

        // 실패 결과는 캐시되지 않는다 → 두 번째 호출도 adapter를 다시 호출
        await analyzeDecision({ hand, decisionSeq: 3, ai: {}, adapters: [adapter] });
        expect(calls).toBe(2);
        const snapshot = await buildDecisionSnapshot(hand, 3);
        expect(getCachedAnalysis(snapshot.provenance.inputHash, 'stub-adapter', 'stub-prompt.v1')).toBeNull();
    });

    it('범위 밖 snapshot은 UNSUPPORTED_SCOPE 구조화 오류 (adapter 미호출)', async () => {
        const hand = completedHand();
        let calls = 0;
        const narrow = stubAdapter({
            id: 'river-only',
            capabilities: { streets: ['river'] }, // 결정은 flop
            analyze: async () => { calls += 1; return {}; },
        });

        const outcome = await analyzeDecision({ hand, decisionSeq: 3, ai: {}, adapters: [narrow] });
        expect(outcome.result).toBeUndefined();
        expect(outcome.error).toMatchObject({
            schemaVersion: 'poker-analysis-error.v1',
            code: 'UNSUPPORTED_SCOPE',
            stage: 'capability_selection',
            decisionId: 'hand_gateway_fixture:seq:3',
            retryable: false,
        });
        expect(outcome.error.diagnosticRefs.some(ref => ref.startsWith('river-only:'))).toBe(true);
        expect(calls).toBe(0);
    });

    it('adapter가 던진 오류는 분류(annotation)에 따라 §15.3 코드로 매핑된다', async () => {
        const hand = completedHand();

        // heuristic adapter + 타임아웃 형태의 provider 오류
        const timeout = await analyzeDecision({
            hand,
            decisionSeq: 3,
            ai: { call: async () => { throw new Error('AI 요청이 60초를 초과했습니다. 잠시 후 다시 시도하세요.'); } },
            adapters: [heuristicLlmAdapter],
        });
        expect(timeout.error).toMatchObject({ code: 'PROVIDER_TIMEOUT', stage: 'provider_call', retryable: true });

        // 검증 불가 응답(raw)은 MALFORMED_MODEL_OUTPUT — 원문은 반환되지 않는다
        const malformed = await analyzeDecision({
            hand,
            decisionSeq: 3,
            ai: { call: async () => ({ hello: 'not a review' }) },
            adapters: [heuristicLlmAdapter],
        });
        expect(malformed.result).toBeUndefined();
        expect(malformed.error).toMatchObject({ code: 'MALFORMED_MODEL_OUTPUT', stage: 'result_validation' });
        expect(JSON.stringify(malformed.error)).not.toContain('not a review');
    });
});

describe('heuristicLlmAdapter (게이트웨이 경유 end-to-end, 모델 호출 stub)', () => {
    it('검증 통과 리뷰를 poker-analysis-result.v1 envelope으로 변환한다', async () => {
        const hand = completedHand();
        const prompts = [];
        const outcome = await analyzeDecision({
            hand,
            decisionSeq: 3,
            ai: { call: async (prompt) => { prompts.push(prompt); return validRawReview(); } },
            adapters: [heuristicLlmAdapter],
        });

        expect(outcome.error).toBeUndefined();
        const result = outcome.result;
        const snapshot = await buildDecisionSnapshot(hand, 3);
        expect(validateAnalysisResult(result, snapshot)).toEqual({ ok: true, errors: [] });

        expect(result.analysisMode).toBe('heuristic_no_solver');
        expect(result.decisionId).toBe('hand_gateway_fixture:seq:3');
        expect(result.inputHash).toBe(snapshot.provenance.inputHash);
        // 수치 fact는 deterministic replay 값만, provenance와 method 필수
        expect(result.computedFacts.potOddsRequiredPct).toMatchObject({
            value: snapshot.state.potOddsRequiredPct,
            method: 'deterministic_replay',
        });
        expect(result.computedFacts.heroSprBefore.method).toBe('deterministic_replay');
        // mode 계약: baseline 부재, exploit null, confidence는 리뷰 값(≤0.45)
        expect(result.baselineStrategy).toBeUndefined();
        expect(result.exploitAdjustment).toBeNull();
        expect(result.confidence.overall).toBe(0.3);
        // factRef 어휘 번역: activePlayers:seat:1 → players:<가명 ID>
        expect(result.explanation.reasoning[0].factRefs).toContain('state.potOddsRequiredPct');
        expect(result.explanation.reasoning[1].factRefs).toContain(`players:${VILLAIN_ID}`);
        // recommendation은 검토 대상(실제) 액션 + 리뷰가 제시한 legal 대안
        expect(result.recommendation.primaryAction).toBe('call');
        expect(result.recommendation.alternatives).toEqual(['raise']);
        expect(result.provenance.some(entry => entry.engine === 'detailedReview')).toBe(true);
        expect(outcome.review.assessment).toBe('plausible');

        // 가명 불변식: 프롬프트에도 결과에도 실명이 없다
        expect(prompts).toHaveLength(1);
        expect(prompts[0]).not.toContain('Hero Real Name');
        expect(prompts[0]).not.toContain('Villain Real Name');
        expect(JSON.stringify(result)).not.toContain('Real Name');

        // 같은 입력의 재호출은 캐시 히트
        const again = await analyzeDecision({
            hand,
            decisionSeq: 3,
            ai: { call: async () => { throw new Error('호출되면 안 됩니다'); } },
            adapters: [heuristicLlmAdapter],
        });
        expect(again.cached).toBe(true);
        expect(again.result).toEqual(result);
    });
});

describe('capabilityRegistry', () => {
    it('기본 레지스트리에는 heuristic adapter가 유니버설 폴백으로 등록되어 있다', async () => {
        const adapters = registeredAnalysisAdapters();
        expect(adapters.some(adapter => adapter.capabilities.adapterId === HEURISTIC_ADAPTER_ID)).toBe(true);

        const snapshot = await buildDecisionSnapshot(completedHand(), 3);
        const selection = selectAdapter(snapshot);
        expect(selection.error).toBeNull();
        expect(selection.adapter.capabilities.adapterId).toBe(HEURISTIC_ADAPTER_ID);
    });

    it('capability 필드가 기계적으로 매칭된다 (변형/street/인원/포지션/사이드팟/정밀도)', async () => {
        const snapshot = await buildDecisionSnapshot(completedHand(), 3);

        expect(capabilityMismatchReasons(heuristicLlmAdapter.capabilities, snapshot)).toEqual([]);

        const narrow = createAnalysisCapabilities({
            adapterId: 'narrow',
            adapterVersion: '0.0.1',
            modes: ['heuristic_no_solver'],
            streets: ['river'],
            positions: ['SB'],
            maxPlayers: 2,
            stackDepthBb: { min: 300, max: 400 },
            requiresExactAmounts: true,
            supportsSidePots: false,
        });
        const reasons = capabilityMismatchReasons(narrow, snapshot);
        expect(reasons.some(reason => reason.startsWith('street:'))).toBe(true);   // flop ∉ [river]
        expect(reasons.some(reason => reason.startsWith('position:'))).toBe(true); // BTN ∉ [SB]
        expect(reasons.some(reason => reason.startsWith('stackDepthBb:'))).toBe(true); // 99bb ∉ [300,400]
    });

    it('아직 구현되지 않은 mode만 선언한 adapter는 선택되지 않는다', async () => {
        const snapshot = await buildDecisionSnapshot(completedHand(), 3);
        const futureOnly = {
            capabilities: createAnalysisCapabilities({
                adapterId: 'solver-future',
                adapterVersion: '0.0.1',
                modes: ['solver_calibrated'], // forward-compat 선언만 존재
            }),
            promptVersion: 'future.v1',
            analyze: async () => ({}),
        };
        const selection = selectAdapter(snapshot, [futureOnly]);
        expect(selection.adapter).toBeNull();
        expect(selection.error.code).toBe('UNSUPPORTED_SCOPE');
    });
});
