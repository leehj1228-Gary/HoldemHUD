// analyzer capability registry (연구 기준서 §14.3)
// adapter는 자신이 처리 가능한 범위를 analysis-capabilities.v1로 기계 선언하고,
// 게이트웨이는 snapshot과 선언이 일치하는 첫 번째 adapter만 후보에 올린다.
// 일치하는 adapter가 없으면 §15.3 UNSUPPORTED_SCOPE 구조화 오류를 돌려준다.

import {
    CAPABILITIES_SCHEMA_VERSION,
    IMPLEMENTED_ANALYSIS_MODES,
    createAnalysisCapabilities,
} from '../contracts/capabilities.js';
import { createAnalysisError } from '../contracts/analysisError.js';
import { heuristicLlmAdapter } from '../adapters/heuristicLlmAdapter.js';

/**
 * snapshot이 capability 선언 범위 밖인 이유 목록. 빈 배열이면 매칭.
 * 검사는 전부 선언 필드에서 기계적으로 도출한다 — adapter별 특수 분기 금지 (§14.3).
 * @param {object} capabilities analysis-capabilities.v1 객체
 * @param {object} snapshot 유효한 decision-snapshot.v1
 * @returns {string[]} 불일치 이유 (진단용)
 */
export function capabilityMismatchReasons(capabilities, snapshot) {
    const reasons = [];
    if (!capabilities.modes.some(mode => IMPLEMENTED_ANALYSIS_MODES.includes(mode))) {
        reasons.push('modes: 구현된 분석 mode가 없음');
    }
    if (!capabilities.variants.includes(snapshot.game.variant)) {
        reasons.push(`variant: ${snapshot.game.variant} 미지원`);
    }
    if (!capabilities.streets.includes(snapshot.knowledgeCutoff.street)) {
        reasons.push(`street: ${snapshot.knowledgeCutoff.street} 미지원`);
    }
    if (capabilities.maxPlayers !== null && snapshot.players.length > capabilities.maxPlayers) {
        reasons.push(`players: ${snapshot.players.length} > maxPlayers ${capabilities.maxPlayers}`);
    }
    if (capabilities.positions !== null
        && (snapshot.hero.position === null || !capabilities.positions.includes(snapshot.hero.position))) {
        reasons.push(`position: ${snapshot.hero.position ?? 'unknown'} 미지원`);
    }
    if (capabilities.stackDepthBb !== null) {
        const bigBlind = snapshot.game.bigBlind;
        const heroStack = snapshot.state.heroStackBefore;
        const depthBb = bigBlind !== null && bigBlind > 0 && heroStack !== null ? heroStack / bigBlind : null;
        if (depthBb === null || depthBb < capabilities.stackDepthBb.min || depthBb > capabilities.stackDepthBb.max) {
            reasons.push(`stackDepthBb: ${depthBb === null ? 'unknown' : depthBb} 범위 밖`);
        }
    }
    if (!capabilities.supportsSidePots && snapshot.state.contestablePots.length > 1) {
        reasons.push('sidePots: 미지원');
    }
    if (!capabilities.supportsAnte && snapshot.game.ante !== 0) {
        reasons.push('ante: 미지원');
    }
    if (!capabilities.supportsRake && snapshot.game.rake !== null) {
        reasons.push('rake: 미지원');
    }
    if (capabilities.requiresExactAmounts
        && (snapshot.dataQuality.overall !== 'exact' || snapshot.dataQuality.estimatedFields.length > 0)) {
        reasons.push(`amounts: ${snapshot.dataQuality.overall} (exact 필요)`);
    }
    return reasons;
}

// 기본 레지스트리 (등록 순서 = 선택 우선순위)
const defaultRegistry = [];

/**
 * adapter 등록. 잘못된 선언은 등록 시점에 fail-fast (§14.3).
 * @param {{capabilities: object, promptVersion: string, analyze: Function}} adapter
 * @param {Array<object>} [adapters] 대상 레지스트리 (기본: 모듈 기본 레지스트리)
 * @returns {object} 등록된 adapter
 */
export function registerAnalysisAdapter(adapter, adapters = defaultRegistry) {
    if (!adapter || typeof adapter.analyze !== 'function') {
        throw new TypeError('adapter.analyze: function required');
    }
    if (typeof adapter.promptVersion !== 'string' || !adapter.promptVersion.trim()) {
        throw new TypeError('adapter.promptVersion: non-empty string required');
    }
    if (adapter.capabilities?.schemaVersion !== CAPABILITIES_SCHEMA_VERSION) {
        throw new TypeError(`adapter.capabilities.schemaVersion: must equal ${CAPABILITIES_SCHEMA_VERSION}`);
    }
    createAnalysisCapabilities(adapter.capabilities); // 선언 필드 재검증 (fail-fast)
    if (adapters.some(existing => existing.capabilities.adapterId === adapter.capabilities.adapterId)) {
        throw new TypeError(`adapter.capabilities.adapterId: duplicate id ${adapter.capabilities.adapterId}`);
    }
    adapters.push(adapter);
    return adapter;
}

/** 현재 기본 레지스트리 사본 (등록 순서 유지). */
export function registeredAnalysisAdapters() {
    return [...defaultRegistry];
}

/**
 * snapshot 범위와 일치하는 첫 번째 adapter를 고른다.
 * @param {object} snapshot 유효한 decision-snapshot.v1
 * @param {Array<object>} [adapters] 후보 목록 (기본: 기본 레지스트리 — heuristic이 폴백)
 * @returns {{adapter: object|null, error: object|null}}
 *   일치 adapter가 없으면 error에 poker-analysis-error.v1 (UNSUPPORTED_SCOPE)
 */
export function selectAdapter(snapshot, adapters = defaultRegistry) {
    const mismatches = [];
    for (const adapter of adapters) {
        const reasons = capabilityMismatchReasons(adapter.capabilities, snapshot);
        if (reasons.length === 0) return { adapter, error: null };
        mismatches.push(...reasons.map(reason => `${adapter.capabilities.adapterId}: ${reason}`));
    }
    return {
        adapter: null,
        error: createAnalysisError({
            requestId: snapshot.requestId ?? null,
            decisionId: snapshot.decisionId ?? null,
            code: 'UNSUPPORTED_SCOPE',
            stage: 'capability_selection',
            retryable: false,
            safeFallbackMode: null,
            userMessageKo: '이 결정을 지원하는 분석 엔진이 없습니다.',
            diagnosticRefs: mismatches.slice(0, 12),
        }),
    };
}

// 기본 등록: heuristic adapter는 유니버설 폴백으로 항상 마지막(현재는 유일)에 둔다.
registerAnalysisAdapter(heuristicLlmAdapter);
