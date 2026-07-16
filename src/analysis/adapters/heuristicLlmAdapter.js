// heuristic_no_solver LLM adapter (연구 기준서 §14.3–14.4, §16.1)
// 기존 detailedReview 흐름(프롬프트 빌드 → 프로바이더 호출 → validateDecisionReview)을
// 그대로 감싼다 — 컷오프·화이트리스트·금지 어휘·confidence cap의 단일 원천은 여전히
// detailedReview이고, 이 어댑터는 검증을 통과한 리뷰를 poker-analysis-result.v1
// envelope으로 옮겨 담기만 한다. 수치 fact는 snapshot의 deterministic replay 값
// (potOdds/SPR)만 싣고, baselineStrategy/exploitAdjustment는 mode 계약상 싣지 않는다.

import {
    PAYLOAD_SCHEMA_VERSION,
    buildDetailedReviewPayload,
    buildDecisionPrompt,
    validateDecisionReview,
} from '../../services/detailedReview.js';
import { callAI } from '../../services/aiService.js';
import { createAnalysisCapabilities } from '../contracts/capabilities.js';
import { ANALYSIS_RESULT_SCHEMA_VERSION } from '../contracts/analysisResult.js';
import { allowedFactRefsForSnapshot } from '../contracts/decisionSnapshot.js';
import { SNAPSHOT_BUILDER_VERSION } from '../snapshot/buildDecisionSnapshot.js';

export const HEURISTIC_ADAPTER_ID = 'heuristic-llm';
export const HEURISTIC_ADAPTER_VERSION = '1.0.0';

// 결과 provenance id (computedFacts.provenanceRef가 참조)
const PROVENANCE_HEURISTIC = 'heuristic:detailedReview';
const PROVENANCE_REPLAY = 'replay:detailedHandEngine';

// detailedReview factRef 어휘 → DecisionSnapshot factRef 어휘.
// 두 계약은 같은 replay에서 나오지만 필드 이름이 다르다 (§15.1 vs detailed-review-payload.v1).
const FACT_REF_MAP = {
    'state.potBefore': 'state.potBeforeAction',
    'state.currentBet': 'state.currentBetTo',
    'state.legalActions': 'state.legalOptions',
    'game.straddleCount': 'game.straddlePosts',
};
const ACTIVE_PLAYER_REF_PATTERN = /^activePlayers:seat:(\d+)$/;

// 게이트웨이가 §15.3 오류로 변환할 수 있도록 던지는 오류에 분류를 부착한다.
function annotate(error, code, stage, retryable = false) {
    const wrapped = error instanceof Error ? error : new Error(String(error));
    wrapped.analysisError = { code, stage, retryable: !!retryable };
    return wrapped;
}

function classifyProviderError(error) {
    // callAI가 모델 텍스트를 JSON.parse하다 실패하면 SyntaxError가 그대로 올라온다.
    if (error instanceof SyntaxError) {
        return { code: 'MALFORMED_MODEL_OUTPUT', stage: 'provider_call', retryable: true };
    }
    const message = error instanceof Error ? error.message : String(error);
    if (error?.name === 'AbortError' || /초과/.test(message)) {
        return { code: 'PROVIDER_TIMEOUT', stage: 'provider_call', retryable: true };
    }
    // §15.3에 범용 provider-error 코드가 없어, 외부 계산 자원 사용 불가로 분류한다.
    return { code: 'SIDECAR_UNAVAILABLE', stage: 'provider_call', retryable: true };
}

// review factRef 하나를 snapshot 어휘로 옮긴다. 대응 불가면 null.
function translateFactRef(ref, playerIdBySeat) {
    if (Object.prototype.hasOwnProperty.call(FACT_REF_MAP, ref)) return FACT_REF_MAP[ref];
    const activeMatch = ACTIVE_PLAYER_REF_PATTERN.exec(ref);
    if (activeMatch) {
        const playerId = playerIdBySeat.get(Number(activeMatch[1]));
        return playerId ? `players:${playerId}` : null;
    }
    return ref;
}

/**
 * 검증 통과한 heuristic 리뷰를 poker-analysis-result.v1 envelope으로 변환한다.
 * @param {object} snapshot 유효한 decision-snapshot.v1
 * @param {object} review validateDecisionReview 통과본
 * @param {number} totalMs 어댑터 전체 소요 시간
 * @returns {object} poker-analysis-result.v1 객체
 */
function envelopeFromReview(snapshot, review, totalMs) {
    const provenance = [
        {
            id: PROVENANCE_HEURISTIC,
            type: 'heuristic',
            engine: 'detailedReview',
            version: review.schemaVersion,
        },
        {
            id: PROVENANCE_REPLAY,
            type: 'deterministic_replay',
            engine: 'detailedHandEngine',
            version: SNAPSHOT_BUILDER_VERSION,
        },
    ];

    // 수치 fact는 payload가 이미 계산한 것(potOdds/SPR)만 — LLM 산수 없음 (§14.2).
    const computedFacts = {};
    if (snapshot.state.potOddsRequiredPct !== null) {
        computedFacts.potOddsRequiredPct = {
            value: snapshot.state.potOddsRequiredPct,
            method: 'deterministic_replay',
            provenanceRef: PROVENANCE_REPLAY,
        };
    }
    if (snapshot.state.heroSprBefore !== null) {
        computedFacts.heroSprBefore = {
            value: snapshot.state.heroSprBefore,
            method: 'deterministic_replay',
            provenanceRef: PROVENANCE_REPLAY,
        };
    }

    // 설명의 factRefs를 snapshot 어휘로 번역하고 화이트리스트와 교차 검증한다.
    // 번역 불가/비허용 참조가 남은 근거 항목은 조용히 버린다 (인용 조작 금지).
    const playerIdBySeat = new Map(snapshot.players.map(player => [player.seat, player.playerId]));
    const allowedRefs = new Set([
        ...allowedFactRefsForSnapshot(snapshot),
        ...provenance.map(entry => entry.id),
        ...Object.keys(computedFacts),
    ]);
    const reasoning = review.reasoning
        .map(item => ({
            text: item.text,
            factRefs: [...new Set(item.factRefs
                .map(ref => translateFactRef(ref, playerIdBySeat))
                .filter(ref => ref !== null && allowedRefs.has(ref)))],
        }))
        .filter(item => item.factRefs.length > 0);

    // heuristic 모드는 정답 판정이 없다: recommendation은 "검토 대상 액션"을 그대로 두고
    // (실제 액션 — snapshot 검증이 legal option임을 보장), 리뷰가 제시한 조건부 대안 중
    // legal option에 있는 것만 alternatives로 옮긴다.
    const legalActionSet = new Set(snapshot.state.legalOptions.map(option => option.action));
    const primaryAction = legalActionSet.has(snapshot.actualAction.action)
        ? snapshot.actualAction.action
        : 'all-in';
    const alternatives = [...new Set(
        review.alternatives.map(item => item.action).filter(action => legalActionSet.has(action)),
    )];

    return {
        schemaVersion: ANALYSIS_RESULT_SCHEMA_VERSION,
        requestId: snapshot.requestId ?? null,
        decisionId: snapshot.decisionId,
        inputHash: snapshot.provenance.inputHash,
        analysisMode: 'heuristic_no_solver',
        supportedScope: {
            variant: snapshot.game.variant,
            format: snapshot.game.format,
            street: snapshot.knowledgeCutoff.street,
            players: snapshot.players.length,
        },
        computedFacts,
        // mode 계약(§14.4): heuristic_no_solver는 baselineStrategy를 만들지 않고
        // exploit 주장도 하지 않는다 — baseline은 부재, exploit은 명시적 null.
        exploitAdjustment: null,
        recommendation: { primaryAction, alternatives },
        confidence: { overall: review.confidence.value },
        explanation: {
            headline: review.headline,
            reasoning,
            alternatives: review.alternatives,
            studyQuestions: review.reflectionQuestion ? [review.reflectionQuestion] : [],
        },
        unknowns: review.unknowns,
        provenance,
        timing: { totalMs },
    };
}

export const heuristicLlmAdapter = {
    // §14.3 capability 선언: heuristic 어댑터는 유니버설 폴백이다 — 모든 street/포지션,
    // 최대 10인, 사이드팟 허용, 대략값 금액 허용 (데이터 품질은 결과의 unknowns로 표면화).
    capabilities: createAnalysisCapabilities({
        adapterId: HEURISTIC_ADAPTER_ID,
        adapterVersion: HEURISTIC_ADAPTER_VERSION,
        modes: ['heuristic_no_solver'],
        variants: ['NLHE'],
        maxPlayers: 10,
        positions: null,
        stackDepthBb: null,
        supportsAnte: false,
        supportsRake: false,
        supportsSidePots: true,
        requiresExactAmounts: false,
        offline: false,
    }),
    // 캐시 키 구성 요소: 프롬프트는 payload 계약 버전에 결정론적으로 종속된다.
    promptVersion: PAYLOAD_SCHEMA_VERSION,

    /**
     * 결정 하나를 heuristic_no_solver로 분석한다.
     * @param {object} snapshot 유효한 decision-snapshot.v1 (게이트웨이가 검증 완료)
     * @param {object} context
     * @param {{provider?:string, apiKey?:string, model?:string, call?:Function}} context.ai
     *   프로바이더 옵션. call(prompt)→Promise<object>를 주입하면 aiService 대신 사용
     *   (테스트/커스텀 전송 경로).
     * @param {object} context.originalHand detailed HandRecord — 프롬프트 payload는
     *   항상 이 원본에서 재구성한다 (컷오프는 detailedReview 단일 구현).
     * @returns {Promise<{result: object, review: object}>} result는 envelope,
     *   review는 validateDecisionReview 통과본 (UI 배지용 사이드카 — 원문 아님)
     */
    async analyze(snapshot, { ai, originalHand } = {}) {
        const startedAt = Date.now();
        const decisionSeq = snapshot.knowledgeCutoff.decisionSeq;

        let shared;
        let reviewDecision;
        try {
            const payload = buildDetailedReviewPayload(originalHand, [{ decisionSeq }]);
            shared = payload.shared;
            reviewDecision = payload.decisions[0];
        } catch (error) {
            throw annotate(error, 'INVALID_LEDGER', 'computation', false);
        }

        // 단일 초크포인트: 프롬프트 직렬화는 buildDecisionPrompt(화이트리스트 + no-names)뿐.
        const prompt = buildDecisionPrompt(shared, reviewDecision);

        const callModel = typeof ai?.call === 'function'
            ? ai.call
            : (input) => callAI(input, ai || {});
        let raw;
        try {
            raw = await callModel(prompt);
        } catch (error) {
            const { code, stage, retryable } = classifyProviderError(error);
            throw annotate(error, code, stage, retryable);
        }

        let review;
        try {
            review = validateDecisionReview(raw, reviewDecision);
        } catch (error) {
            // 검증 실패한 모델 응답은 여기서 끝난다 — raw는 절대 밖으로 나가지 않는다.
            throw annotate(error, 'MALFORMED_MODEL_OUTPUT', 'result_validation', true);
        }

        return {
            result: envelopeFromReview(snapshot, review, Date.now() - startedAt),
            review,
        };
    },
};
