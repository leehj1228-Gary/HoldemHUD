// 분석 capability 계약 (연구 기준서 §14.3–14.4 — analysis-capabilities.v1)
// 순수 모듈: React·DOM·storage import 금지. adapter가 자신이 처리 가능한 범위를 기계적으로 선언한다.

import { DETAILED_STREETS } from '../../engine/schema.js';

export const CAPABILITIES_SCHEMA_VERSION = 'analysis-capabilities.v1';

/** 연구 기준서 §14.4의 5개 분석 mode. 계약은 5개 전부를 알지만 구현은 아래 IMPLEMENTED만. */
export const ANALYSIS_MODES = [
    'heuristic_no_solver',
    'calculator_exact',
    'range_estimated',
    'solver_calibrated',
    'exploit_adjusted',
];

/** 현재 실제로 구현된 mode. gateway는 이 밖의 mode를 선택하면 안 된다. */
export const IMPLEMENTED_ANALYSIS_MODES = ['heuristic_no_solver'];

function fail(path, message) {
    throw new TypeError(`${path}: ${message}`);
}

function requireString(value, path) {
    if (typeof value !== 'string' || !value.trim()) fail(path, 'non-empty string required');
    return value.trim();
}

function requireStringArray(value, allowed, path) {
    if (!Array.isArray(value) || value.length === 0) fail(path, 'non-empty array required');
    for (const item of value) {
        if (allowed && !allowed.includes(item)) fail(path, `must be one of: ${allowed.join(', ')}`);
        if (!allowed && (typeof item !== 'string' || !item.trim())) fail(path, 'string items required');
    }
    if (new Set(value).size !== value.length) fail(path, 'duplicate values are not allowed');
    return [...value];
}

/**
 * capability 선언 factory. 잘못된 선언은 등록 전에 fail-fast.
 * @param {object} spec
 * @returns {object} analysis-capabilities.v1 객체
 */
export function createAnalysisCapabilities(spec) {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) fail('capabilities', 'object required');
    const stackDepthBb = spec.stackDepthBb ?? null;
    if (stackDepthBb !== null) {
        const ok = typeof stackDepthBb === 'object'
            && Number.isFinite(stackDepthBb.min) && Number.isFinite(stackDepthBb.max)
            && stackDepthBb.min >= 0 && stackDepthBb.min <= stackDepthBb.max;
        if (!ok) fail('capabilities.stackDepthBb', '{min, max} with 0 <= min <= max required');
    }
    const maxPlayers = spec.maxPlayers ?? null;
    if (maxPlayers !== null && (!Number.isInteger(maxPlayers) || maxPlayers < 2 || maxPlayers > 10)) {
        fail('capabilities.maxPlayers', 'integer between 2 and 10 or null required');
    }
    return {
        schemaVersion: CAPABILITIES_SCHEMA_VERSION,
        adapterId: requireString(spec.adapterId, 'capabilities.adapterId'),
        adapterVersion: requireString(spec.adapterVersion, 'capabilities.adapterVersion'),
        modes: requireStringArray(spec.modes, ANALYSIS_MODES, 'capabilities.modes'),
        variants: requireStringArray(spec.variants ?? ['NLHE'], ['NLHE'], 'capabilities.variants'),
        maxPlayers,
        positions: spec.positions == null ? null : requireStringArray(spec.positions, null, 'capabilities.positions'),
        stackDepthBb: stackDepthBb === null ? null : { min: stackDepthBb.min, max: stackDepthBb.max },
        streets: requireStringArray(spec.streets ?? [...DETAILED_STREETS], [...DETAILED_STREETS], 'capabilities.streets'),
        supportsAnte: !!spec.supportsAnte,
        supportsRake: !!spec.supportsRake,
        supportsSidePots: !!spec.supportsSidePots,
        requiresExactAmounts: !!spec.requiresExactAmounts,
        offline: !!spec.offline,
    };
}
