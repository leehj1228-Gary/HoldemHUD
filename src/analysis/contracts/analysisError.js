// 구조화 분석 오류 계약 (연구 기준서 §15.3 — poker-analysis-error.v1)
// 분석 실패도 자유형 문자열 대신 이 구조로만 표면화한다.

import { ANALYSIS_MODES } from './capabilities.js';

export const ANALYSIS_ERROR_SCHEMA_VERSION = 'poker-analysis-error.v1';

/** 연구 기준서 §15.3의 필수 error code 11종. */
export const ANALYSIS_ERROR_CODES = [
    'INVALID_LEDGER',
    'REPLAY_DISAGREEMENT',
    'FUTURE_INFORMATION_DETECTED',
    'UNSUPPORTED_SCOPE',
    'INSUFFICIENT_RANGE_INFORMATION',
    'SOLVER_TIMEOUT',
    'SIDECAR_UNAVAILABLE',
    'PROVIDER_TIMEOUT',
    'MALFORMED_MODEL_OUTPUT',
    'CLAIM_VALIDATION_FAILED',
    'COST_BUDGET_EXCEEDED',
];

/** 오류가 발생한 파이프라인 단계. */
export const ANALYSIS_ERROR_STAGES = [
    'snapshot_build',
    'snapshot_validation',
    'capability_selection',
    'computation',
    'provider_call',
    'result_validation',
];

const HANGUL_PATTERN = /[가-힣]/;

function fail(path, message) {
    throw new TypeError(`${path}: ${message}`);
}

/**
 * 구조화 오류 factory. 잘못된 필드는 생성 시점에 fail-fast.
 * @param {object} fields
 * @returns {object} poker-analysis-error.v1 객체
 */
export function createAnalysisError({
    requestId = null,
    decisionId = null,
    code,
    stage,
    retryable = false,
    safeFallbackMode = null,
    userMessageKo,
    diagnosticRefs = [],
} = {}) {
    if (!ANALYSIS_ERROR_CODES.includes(code)) {
        fail('error.code', `must be one of: ${ANALYSIS_ERROR_CODES.join(', ')}`);
    }
    if (!ANALYSIS_ERROR_STAGES.includes(stage)) {
        fail('error.stage', `must be one of: ${ANALYSIS_ERROR_STAGES.join(', ')}`);
    }
    if (requestId !== null && (typeof requestId !== 'string' || !requestId.trim())) {
        fail('error.requestId', 'non-empty string or null required');
    }
    if (decisionId !== null && (typeof decisionId !== 'string' || !decisionId.trim())) {
        fail('error.decisionId', 'non-empty string or null required');
    }
    if (safeFallbackMode !== null && !ANALYSIS_MODES.includes(safeFallbackMode)) {
        fail('error.safeFallbackMode', `must be null or one of: ${ANALYSIS_MODES.join(', ')}`);
    }
    if (typeof userMessageKo !== 'string' || !userMessageKo.trim() || !HANGUL_PATTERN.test(userMessageKo)) {
        fail('error.userMessageKo', 'Korean user message required');
    }
    if (!Array.isArray(diagnosticRefs) || diagnosticRefs.some(ref => typeof ref !== 'string' || !ref.trim())) {
        fail('error.diagnosticRefs', 'array of non-empty strings required');
    }
    return {
        schemaVersion: ANALYSIS_ERROR_SCHEMA_VERSION,
        requestId,
        decisionId,
        code,
        stage,
        retryable: !!retryable,
        safeFallbackMode,
        userMessageKo: userMessageKo.trim(),
        diagnosticRefs: [...diagnosticRefs],
    };
}

/** 구조 검증 (수신 측용): {ok, errors} 반환. */
export function validateAnalysisError(error) {
    const errors = [];
    if (!error || typeof error !== 'object' || Array.isArray(error)) {
        return { ok: false, errors: ['error: object required'] };
    }
    if (error.schemaVersion !== ANALYSIS_ERROR_SCHEMA_VERSION) {
        errors.push(`error.schemaVersion: must equal ${ANALYSIS_ERROR_SCHEMA_VERSION}`);
    }
    try {
        createAnalysisError(error);
    } catch (thrown) {
        errors.push(thrown.message);
    }
    return { ok: errors.length === 0, errors };
}
