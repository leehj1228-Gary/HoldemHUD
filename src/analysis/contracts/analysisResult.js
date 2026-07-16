// AnalysisResult v1 계약 (연구 기준서 §15.2 — poker-analysis-result.v1)
// result 불변조건을 solver 없이 구조적으로 검사 가능한 범위에서 전부 강제한다:
// 추천은 snapshot의 legal option 안, size는 replay bound 안, 수치에는 provenance,
// mode 금지 주장은 validateModeClaims 표가 담당.

import { ANALYSIS_MODES } from './capabilities.js';
import { allowedFactRefsForSnapshot, validateDecisionSnapshot } from './decisionSnapshot.js';
import { validateModeClaims } from '../validation/validateModeClaims.js';

export const ANALYSIS_RESULT_SCHEMA_VERSION = 'poker-analysis-result.v1';

const FREQUENCY_SUM_TOLERANCE = 0.02;

const ROOT_KEYS = [
    'schemaVersion', 'requestId', 'decisionId', 'inputHash', 'analysisMode', 'supportedScope',
    'computedFacts', 'rangeAssumptions', 'baselineStrategy', 'exploitAdjustment',
    'recommendation', 'confidence', 'explanation', 'unknowns', 'warnings', 'provenance', 'timing',
];
const RECOMMENDATION_KEYS = ['primaryAction', 'sizeTo', 'mixed', 'alternatives'];
const EXPLANATION_KEYS = ['headline', 'reasoning', 'alternatives', 'studyQuestions'];

function isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isAmount(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function checkKeys(value, allowed, path, errors) {
    for (const key of Object.keys(value)) {
        if (!allowed.includes(key)) errors.push(`${path}.${key}: field is not allowed`);
    }
}

function optionByAction(snapshot, action) {
    return snapshot.state.legalOptions.find(option => option.action === action) ?? null;
}

function checkActionLegality(action, snapshot, path, errors) {
    const actions = new Set(snapshot.state.legalOptions.map(option => option.action));
    if (typeof action !== 'string' || !actions.has(action)) {
        errors.push(`${path}: must be one of the snapshot legal options`);
        return false;
    }
    return true;
}

// size는 authoritative replay bound 안이어야 한다 (§15.2 result 불변조건 2).
function checkSizeBounds(action, sizeTo, snapshot, path, errors) {
    if (sizeTo === null || sizeTo === undefined) return;
    if (!isAmount(sizeTo)) {
        errors.push(`${path}: amount or null required`);
        return;
    }
    if (action !== 'bet' && action !== 'raise' && action !== 'all-in') {
        errors.push(`${path}: sizeTo is only allowed for bet/raise/all-in`);
        return;
    }
    const option = optionByAction(snapshot, action);
    if (!option) return;
    if (isAmount(option.minTo) && sizeTo < option.minTo) {
        errors.push(`${path}: below the legal minimum (${option.minTo})`);
    }
    if (isAmount(option.maxTo) && sizeTo > option.maxTo) {
        errors.push(`${path}: above the legal maximum (${option.maxTo})`);
    }
}

/**
 * AnalysisResult v1 구조 검증. snapshot은 유효한 DecisionSnapshot v1이어야 한다.
 * throw하지 않고 {ok, errors} 반환.
 * @param {object} result
 * @param {object} snapshot
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateAnalysisResult(result, snapshot) {
    const errors = [];
    if (!isObject(result)) return { ok: false, errors: ['result: object required'] };
    const snapshotCheck = validateDecisionSnapshot(snapshot);
    if (!snapshotCheck.ok) {
        return { ok: false, errors: snapshotCheck.errors.map(message => `snapshot invalid: ${message}`) };
    }

    checkKeys(result, ROOT_KEYS, 'result', errors);
    if (result.schemaVersion !== ANALYSIS_RESULT_SCHEMA_VERSION) {
        errors.push(`result.schemaVersion: must equal ${ANALYSIS_RESULT_SCHEMA_VERSION}`);
    }
    if (result.requestId !== undefined && result.requestId !== null
        && (typeof result.requestId !== 'string' || !result.requestId.trim())) {
        errors.push('result.requestId: non-empty string or null required');
    }
    if (result.decisionId !== snapshot.decisionId) {
        errors.push('result.decisionId: must match the snapshot decisionId');
    }
    if (result.inputHash !== snapshot.provenance.inputHash) {
        errors.push('result.inputHash: must match snapshot.provenance.inputHash');
    }
    if (!ANALYSIS_MODES.includes(result.analysisMode)) {
        errors.push(`result.analysisMode: must be one of: ${ANALYSIS_MODES.join(', ')}`);
    }
    if (result.supportedScope !== undefined && !isObject(result.supportedScope)) {
        errors.push('result.supportedScope: object required when present');
    }
    if (result.computedFacts !== undefined && !isObject(result.computedFacts)) {
        errors.push('result.computedFacts: object required when present');
    }

    // provenance 목록 + 수치 fact의 근거 (§15.2: 모든 수치에는 provenance)
    const provenanceIds = new Set();
    if (result.provenance !== undefined) {
        if (!Array.isArray(result.provenance)) {
            errors.push('result.provenance: array required');
        } else {
            result.provenance.forEach((entry, index) => {
                const path = `result.provenance[${index}]`;
                if (!isObject(entry) || typeof entry.id !== 'string' || !entry.id.trim()) {
                    errors.push(`${path}.id: non-empty string required`);
                    return;
                }
                if (provenanceIds.has(entry.id)) errors.push(`${path}.id: duplicate provenance id`);
                provenanceIds.add(entry.id);
            });
        }
    }
    if (isObject(result.computedFacts)) {
        for (const [key, fact] of Object.entries(result.computedFacts)) {
            const path = `result.computedFacts.${key}`;
            if (fact === null) continue;
            if (!isObject(fact)) {
                errors.push(`${path}: object or null required`);
                continue;
            }
            const numeric = typeof fact.value === 'number' && Number.isFinite(fact.value);
            if (numeric) {
                if (typeof fact.method !== 'string' || !fact.method.trim()) {
                    errors.push(`${path}.method: numeric fact requires a method`);
                }
                if (typeof fact.provenanceRef !== 'string' || !provenanceIds.has(fact.provenanceRef)) {
                    errors.push(`${path}.provenanceRef: numeric fact requires a declared provenance entry`);
                }
            }
        }
    }

    // baselineStrategy (§15.2: frequency 합 ≈ 1, action 합법, size bound, provenance)
    if (result.baselineStrategy !== undefined) {
        if (!Array.isArray(result.baselineStrategy)) {
            errors.push('result.baselineStrategy: array required');
        } else {
            let frequencySum = 0;
            let frequencyCount = 0;
            result.baselineStrategy.forEach((entry, index) => {
                const path = `result.baselineStrategy[${index}]`;
                if (!isObject(entry)) {
                    errors.push(`${path}: object required`);
                    return;
                }
                if (checkActionLegality(entry.action, snapshot, `${path}.action`, errors)) {
                    checkSizeBounds(entry.action, entry.sizeTo ?? null, snapshot, `${path}.sizeTo`, errors);
                }
                if (entry.frequency !== null && entry.frequency !== undefined) {
                    if (typeof entry.frequency !== 'number' || !Number.isFinite(entry.frequency)
                        || entry.frequency < 0 || entry.frequency > 1) {
                        errors.push(`${path}.frequency: number between 0 and 1 or null required`);
                    } else {
                        frequencySum += entry.frequency;
                        frequencyCount += 1;
                    }
                }
                if (typeof entry.method !== 'string' || !entry.method.trim()) {
                    errors.push(`${path}.method: non-empty string required`);
                }
                if (entry.provenanceRef !== undefined && entry.provenanceRef !== null
                    && !provenanceIds.has(entry.provenanceRef)) {
                    errors.push(`${path}.provenanceRef: must reference a declared provenance entry`);
                }
            });
            if (frequencyCount > 0 && frequencyCount === result.baselineStrategy.length
                && Math.abs(frequencySum - 1) > FREQUENCY_SUM_TOLERANCE) {
                errors.push('result.baselineStrategy: strategy frequencies must sum to 1 within tolerance');
            }
        }
    }

    // exploitAdjustment는 baseline과 분리 유지 (§15.2)
    if (result.exploitAdjustment !== undefined && result.exploitAdjustment !== null) {
        if (!isObject(result.exploitAdjustment)) {
            errors.push('result.exploitAdjustment: object or null required');
        } else if (typeof result.exploitAdjustment.applied !== 'boolean') {
            errors.push('result.exploitAdjustment.applied: boolean required');
        }
    }

    // recommendation (§15.2: 추천 action은 snapshot legal option 안)
    if (!isObject(result.recommendation)) {
        errors.push('result.recommendation: object required');
    } else {
        const recommendation = result.recommendation;
        checkKeys(recommendation, RECOMMENDATION_KEYS, 'result.recommendation', errors);
        if (checkActionLegality(recommendation.primaryAction, snapshot, 'result.recommendation.primaryAction', errors)) {
            checkSizeBounds(recommendation.primaryAction, recommendation.sizeTo ?? null, snapshot,
                'result.recommendation.sizeTo', errors);
        }
        if (recommendation.mixed !== undefined && typeof recommendation.mixed !== 'boolean') {
            errors.push('result.recommendation.mixed: boolean required');
        }
        if (recommendation.alternatives !== undefined) {
            if (!Array.isArray(recommendation.alternatives)) {
                errors.push('result.recommendation.alternatives: array required');
            } else {
                recommendation.alternatives.forEach((action, index) => {
                    checkActionLegality(action, snapshot, `result.recommendation.alternatives[${index}]`, errors);
                });
            }
        }
    }

    // confidence: 모든 축은 0..1
    if (!isObject(result.confidence)) {
        errors.push('result.confidence: object required');
    } else {
        for (const [key, value] of Object.entries(result.confidence)) {
            if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
                errors.push(`result.confidence.${key}: number between 0 and 1 required`);
            }
        }
    }

    // explanation + fact reference whitelist (§15.2: 설명의 사실은 참조 필요)
    if (!isObject(result.explanation)) {
        errors.push('result.explanation: object required');
    } else {
        const explanation = result.explanation;
        checkKeys(explanation, EXPLANATION_KEYS, 'result.explanation', errors);
        if (explanation.headline !== null && (typeof explanation.headline !== 'string' || !explanation.headline.trim())) {
            errors.push('result.explanation.headline: non-empty string or null required');
        }
        const allowedRefs = new Set([
            ...allowedFactRefsForSnapshot(snapshot),
            ...provenanceIds,
            ...(isObject(result.computedFacts) ? Object.keys(result.computedFacts) : []),
        ]);
        if (!Array.isArray(explanation.reasoning)) {
            errors.push('result.explanation.reasoning: array required');
        } else {
            explanation.reasoning.forEach((item, index) => {
                const path = `result.explanation.reasoning[${index}]`;
                if (!isObject(item) || typeof item.text !== 'string' || !item.text.trim()) {
                    errors.push(`${path}.text: non-empty string required`);
                    return;
                }
                if (!Array.isArray(item.factRefs) || item.factRefs.length === 0) {
                    errors.push(`${path}.factRefs: non-empty array required`);
                    return;
                }
                item.factRefs.forEach((ref, refIndex) => {
                    if (typeof ref !== 'string' || !allowedRefs.has(ref)) {
                        errors.push(`${path}.factRefs[${refIndex}]: reference is not allowed: ${String(ref)}`);
                    }
                });
            });
        }
        for (const key of ['alternatives', 'studyQuestions']) {
            if (explanation[key] !== undefined && !Array.isArray(explanation[key])) {
                errors.push(`result.explanation.${key}: array required when present`);
            }
        }
    }

    for (const key of ['unknowns', 'warnings']) {
        if (result[key] !== undefined
            && (!Array.isArray(result[key]) || result[key].some(item => typeof item !== 'string' || !item.trim()))) {
            errors.push(`result.${key}: array of non-empty strings required when present`);
        }
    }
    if (result.timing !== undefined && result.timing !== null) {
        if (!isObject(result.timing)
            || Object.values(result.timing).some(value => !isAmount(value) && value !== null)) {
            errors.push('result.timing: object of non-negative numbers required when present');
        }
    }

    // mode별 금지 주장 (표 기반 — §14.4)
    if (ANALYSIS_MODES.includes(result.analysisMode)) {
        const claims = validateModeClaims(result);
        errors.push(...claims.errors);
    }

    return { ok: errors.length === 0, errors };
}
