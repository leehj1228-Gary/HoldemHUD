// 분석 게이트웨이 (연구 기준서 §14.1, §16.1)
// snapshot 빌드 → 계약 검증 → capability 선택 → 캐시 → adapter 실행 → 결과/주장 검증 → 캐시 저장.
// 계약: 반환은 항상 {result, ...} 또는 {error}이고, error는 poker-analysis-error.v1 하나뿐이다.
// 검증(불변조건 10 포함)에 실패하면 adapter/LLM은 호출되지 않고, 검증을 통과하지 못한
// 모델 응답(raw text)은 어떤 경로로도 반환되지 않는다.

import { buildDecisionSnapshot } from '../snapshot/buildDecisionSnapshot.js';
import { validateDecisionSnapshot, isAnalyzableSnapshot } from '../contracts/decisionSnapshot.js';
import { validateAnalysisResult } from '../contracts/analysisResult.js';
import { validateModeClaims } from '../validation/validateModeClaims.js';
import {
    ANALYSIS_ERROR_CODES,
    ANALYSIS_ERROR_STAGES,
    createAnalysisError,
} from '../contracts/analysisError.js';
import { selectAdapter } from './capabilityRegistry.js';
import { getCachedAnalysis, putCachedAnalysis } from '../../storage/analysisCache.js';

// 코드별 사용자 안내문 (§15.3 userMessageKo — 진단 문자열은 diagnosticRefs로 분리)
const USER_MESSAGES_KO = {
    INVALID_LEDGER: '핸드 기록이 분석 계약을 만족하지 않아 분석하지 못했습니다.',
    REPLAY_DISAGREEMENT: '기록 리플레이가 일치하지 않아 이 결정은 분석하지 않습니다.',
    UNSUPPORTED_SCOPE: '이 결정을 지원하는 분석 엔진이 없습니다.',
    PROVIDER_TIMEOUT: 'AI 응답이 제한 시간을 초과했습니다. 잠시 후 다시 시도하세요.',
    SIDECAR_UNAVAILABLE: 'AI 호출에 실패했습니다. 네트워크와 API 키 설정을 확인하세요.',
    MALFORMED_MODEL_OUTPUT: 'AI 응답이 형식 검증을 통과하지 못했습니다. 다시 시도해 주세요.',
    CLAIM_VALIDATION_FAILED: 'AI 응답이 분석 mode의 주장 한계 검증을 통과하지 못해 표시하지 않습니다.',
};
const FALLBACK_MESSAGE_KO = 'AI 분석에 실패했습니다.';

function diagnosticsFrom(strings) {
    return strings
        .filter(item => typeof item === 'string' && item.trim())
        .slice(0, 8)
        .map(item => item.slice(0, 300));
}

function gatewayError({ decisionId, code, stage, retryable = false, diagnosticRefs = [] }) {
    return {
        error: createAnalysisError({
            decisionId,
            code,
            stage,
            retryable,
            safeFallbackMode: null,
            userMessageKo: USER_MESSAGES_KO[code] ?? FALLBACK_MESSAGE_KO,
            diagnosticRefs: diagnosticsFrom(diagnosticRefs),
        }),
    };
}

// adapter가 던진(annotate된) 오류 → 구조화 오류. 분류가 없으면 provider_call 단계로 본다.
function errorFromThrown(caught, decisionId) {
    const annotation = caught?.analysisError;
    const code = ANALYSIS_ERROR_CODES.includes(annotation?.code) ? annotation.code : 'MALFORMED_MODEL_OUTPUT';
    const stage = ANALYSIS_ERROR_STAGES.includes(annotation?.stage) ? annotation.stage : 'provider_call';
    const message = caught instanceof Error ? caught.message : String(caught ?? '');
    return gatewayError({
        decisionId,
        code,
        stage,
        retryable: !!annotation?.retryable,
        diagnosticRefs: message ? [message] : [],
    });
}

/**
 * Hero 결정 하나를 분석한다 (게이트웨이 단일 진입점 — 화면은 provider를 직접 알지 않는다).
 *
 * @param {object} args
 * @param {object} args.hand detailed tracking이 완료된 HandRecord
 * @param {number} args.decisionSeq 분석할 Hero 액션의 seq
 * @param {{provider?:string, apiKey?:string, model?:string, call?:Function}} args.ai
 *   프로바이더 옵션 (adapter로 그대로 전달; call 주입 시 테스트/커스텀 전송)
 * @param {{modelId?:string, asOfHandId?:string|null, includedHands?:number|null}} [args.opponentStatsAsOf]
 *   상대 모델 참조 — asOfHandId는 모델에 "포함된 마지막" 핸드여야 하며 현재 핸드면 거부된다 (§12.1)
 * @param {string} [args.salt] 가명화 salt (buildDecisionSnapshot과 동일 규칙)
 * @param {boolean} [args.bypassCache] true면 캐시 조회를 건너뛴다 (재분석) — 저장은 그대로 수행
 * @param {Array<object>} [args.adapters] adapter 후보 목록 (기본: capabilityRegistry 기본 레지스트리)
 * @returns {Promise<{result: object, review: object|null, snapshot: object, cached: boolean,
 *   adapterId: string}|{error: object}>}
 *   성공: 검증 통과한 poker-analysis-result.v1(+검증 통과 review 사이드카, snapshot, 캐시 여부)
 *   실패: poker-analysis-error.v1 하나
 */
export async function analyzeDecision({
    hand,
    decisionSeq,
    ai,
    opponentStatsAsOf = null,
    salt = '',
    bypassCache = false,
    adapters,
} = {}) {
    const fallbackDecisionId = hand && typeof hand.id === 'string' && hand.id.trim() && Number.isInteger(decisionSeq)
        ? `${hand.id}:seq:${decisionSeq}`
        : null;

    // 1) snapshot 빌드 — 컷오프/가명화/inputHash는 빌더 단일 경로
    let snapshot;
    try {
        snapshot = await buildDecisionSnapshot(hand, decisionSeq, { opponentStatsAsOf, salt });
    } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught ?? '');
        const code = /ledger disagreement|not legal at the replayed cutoff/.test(message)
            ? 'REPLAY_DISAGREEMENT'
            : 'INVALID_LEDGER';
        return gatewayError({
            decisionId: fallbackDecisionId,
            code,
            stage: 'snapshot_build',
            diagnosticRefs: message ? [message] : [],
        });
    }

    // 2) 계약 검증 + 불변조건 10 gate — 실패하면 adapter/LLM 호출 없음
    const snapshotCheck = validateDecisionSnapshot(snapshot);
    if (!snapshotCheck.ok) {
        return gatewayError({
            decisionId: snapshot.decisionId ?? fallbackDecisionId,
            code: 'INVALID_LEDGER',
            stage: 'snapshot_validation',
            diagnosticRefs: snapshotCheck.errors,
        });
    }
    if (!isAnalyzableSnapshot(snapshot)) {
        return gatewayError({
            decisionId: snapshot.decisionId,
            code: 'REPLAY_DISAGREEMENT',
            stage: 'snapshot_validation',
            diagnosticRefs: snapshot.dataQuality.validationErrors,
        });
    }

    // 3) capability 선택 (§14.3) — 없으면 UNSUPPORTED_SCOPE
    const selection = adapters === undefined ? selectAdapter(snapshot) : selectAdapter(snapshot, adapters);
    if (!selection.adapter) return { error: selection.error };
    const adapter = selection.adapter;
    const adapterId = adapter.capabilities.adapterId;
    const adapterVersion = adapter.capabilities.adapterVersion;
    const promptVersion = adapter.promptVersion;
    const inputHash = snapshot.provenance.inputHash;

    // 4) 캐시 조회 — 같은 canonical 입력 + 같은 adapter/prompt 버전이면 재호출 금지
    if (!bypassCache) {
        const cachedEntry = getCachedAnalysis(inputHash, adapterId, promptVersion);
        if (cachedEntry && cachedEntry.decisionId === snapshot.decisionId) {
            return {
                result: cachedEntry.result,
                review: cachedEntry.review ?? null,
                snapshot,
                cached: true,
                adapterId,
            };
        }
    }

    // 5) adapter 실행
    let analyzed;
    try {
        analyzed = await adapter.analyze(snapshot, { ai, originalHand: hand });
    } catch (caught) {
        return errorFromThrown(caught, snapshot.decisionId);
    }
    const result = analyzed?.result;
    const review = analyzed?.review ?? null;

    // 6) 결과 계약 + mode 주장 검증 — 실패한 응답은 절대 반환하지 않는다
    const resultCheck = validateAnalysisResult(result, snapshot);
    const claimCheck = resultCheck.ok ? validateModeClaims(result) : { ok: true, errors: [] };
    const validationErrors = [...new Set([...resultCheck.errors, ...claimCheck.errors])];
    if (validationErrors.length > 0) {
        return gatewayError({
            decisionId: snapshot.decisionId,
            code: 'CLAIM_VALIDATION_FAILED',
            stage: 'result_validation',
            retryable: true,
            diagnosticRefs: validationErrors,
        });
    }

    // 7) 캐시 저장 (실패는 조용히 무시 — putCachedAnalysis는 절대 throw하지 않는다)
    putCachedAnalysis({
        inputHash,
        adapterId,
        adapterVersion,
        promptVersion,
        decisionId: snapshot.decisionId,
        handId: snapshot.handId,
        result,
        review,
        createdAt: new Date().toISOString(),
    });

    return { result, review, snapshot, cached: false, adapterId };
}
