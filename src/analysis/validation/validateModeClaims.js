// mode별 주장 한계 검증 (연구 기준서 §14.4 표 + §11.3 현재 금지 주장)
// heuristic_no_solver 행은 detailedReview의 기존 validator와 동일한 금지 어휘/캡을 재사용한다
// (재선언 금지 — FORBIDDEN_PROSE_PATTERN/CONFIDENCE_CAP은 detailedReview가 단일 원천).
// 새 mode는 이 표에 행을 추가하는 것으로 확장한다.

import { CONFIDENCE_CAP, FORBIDDEN_PROSE_PATTERN } from '../../services/detailedReview.js';
import { ANALYSIS_MODES } from '../contracts/capabilities.js';

const EXACT_PERCENT_PATTERN = /\d+(?:\.\d+)?\s*%/;
// solver 근거 없이 최적성/정답을 단정하는 표현 (미래 mode 행에서 재사용).
const OPTIMAL_CLAIM_PATTERN = /\b(?:gto|solver)\b|지티오|솔버|최적(?:이다|입니다|임)?|정답|오답/i;

/**
 * mode → 주장 규칙 행. §14.4의 "가능한 주장/금지 주장"을 구조 검사 가능한 플래그로 옮긴 표.
 * implemented=false 행은 forward-compat 계약 선언이며 gateway가 아직 선택하면 안 된다.
 */
export const MODE_CLAIM_RULES = {
    heuristic_no_solver: {
        implemented: true,
        confidenceCap: CONFIDENCE_CAP,
        forbidNumericEquity: true,        // §15.2: equity 수치 생성 금지
        forbidNumericEv: true,            // §15.2: EV 수치 생성 금지
        forbidNumericFrequency: true,     // §15.2: 전략 frequency 생성 금지
        forbidExploitAdjustment: true,    // 상대 모델 없는 mode — exploit 주장 금지
        forbiddenProse: FORBIDDEN_PROSE_PATTERN,
        forbidExactPercentInProse: true,
        requireRangeRefForEquity: false,
        requireSolverProvenanceForNumbers: false,
        requireEvidenceForAdjustment: false,
    },
    calculator_exact: {
        implemented: false,
        confidenceCap: null,
        forbidNumericEquity: false,       // exact enumeration은 허용
        forbidNumericEv: true,
        forbidNumericFrequency: true,
        forbidExploitAdjustment: true,
        forbiddenProse: OPTIMAL_CLAIM_PATTERN, // 상대 range 없이 strategy optimal 주장 금지
        forbidExactPercentInProse: false,
        requireRangeRefForEquity: false,
        requireSolverProvenanceForNumbers: false,
        requireEvidenceForAdjustment: false,
    },
    range_estimated: {
        implemented: false,
        confidenceCap: null,
        forbidNumericEquity: false,
        forbidNumericEv: true,
        forbidNumericFrequency: true,
        forbidExploitAdjustment: true,
        forbiddenProse: OPTIMAL_CLAIM_PATTERN, // range를 사실이라고 단정 금지 (구조 검사 한계 — 최소한 최적성 단정 금지)
        forbidExactPercentInProse: false,
        requireRangeRefForEquity: true,   // §15.2: equity에는 range ID·sensitivity 필요
        requireSolverProvenanceForNumbers: false,
        requireEvidenceForAdjustment: false,
    },
    solver_calibrated: {
        implemented: false,
        confidenceCap: null,
        forbidNumericEquity: false,
        forbidNumericEv: false,
        forbidNumericFrequency: false,
        forbidExploitAdjustment: true,    // baseline mode — exploit은 exploit_adjusted로 분리
        forbiddenProse: null,
        forbidExactPercentInProse: false,
        requireRangeRefForEquity: true,
        requireSolverProvenanceForNumbers: true, // §15.2: EV/frequency에는 engine/config/version 필요
        requireEvidenceForAdjustment: false,
    },
    exploit_adjusted: {
        implemented: false,
        confidenceCap: null,
        forbidNumericEquity: false,
        forbidNumericEv: false,
        forbidNumericFrequency: false,
        forbidExploitAdjustment: false,
        forbiddenProse: null,
        forbidExactPercentInProse: false,
        requireRangeRefForEquity: true,
        requireSolverProvenanceForNumbers: true,
        requireEvidenceForAdjustment: true, // §14.4: 작은 표본 무제한 exploit 금지 — 근거·cap 필수
    },
};

function isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

// 설명 prose 문자열만 수집한다. 기계 참조 필드(factRefs 등)는 어휘 검사 대상이 아니다.
const NON_PROSE_KEYS = new Set(['factRefs', 'candidateId', 'action', 'provenanceRef', 'evidenceRefs']);

function collectProse(value, out, parentKey = null) {
    if (typeof value === 'string') {
        if (!NON_PROSE_KEYS.has(parentKey)) out.push(value);
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value) collectProse(item, out, parentKey);
        return;
    }
    if (!isObject(value)) return;
    for (const [key, entry] of Object.entries(value)) {
        if (NON_PROSE_KEYS.has(key)) continue;
        collectProse(entry, out, key);
    }
}

function numericValue(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (isObject(value) && typeof value.value === 'number' && Number.isFinite(value.value)) return value.value;
    return null;
}

/**
 * AnalysisResult(v1 형태)의 mode별 주장 한계 검증. throw하지 않고 {ok, errors} 반환.
 * @param {object} result poker-analysis-result.v1 형태의 객체
 * @param {string} [mode] 생략하면 result.analysisMode
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateModeClaims(result, mode = result?.analysisMode) {
    const errors = [];
    if (!isObject(result)) return { ok: false, errors: ['result: object required'] };
    if (!ANALYSIS_MODES.includes(mode)) {
        return { ok: false, errors: [`result.analysisMode: must be one of: ${ANALYSIS_MODES.join(', ')}`] };
    }
    const rules = MODE_CLAIM_RULES[mode];

    // 1) confidence cap
    if (rules.confidenceCap !== null && isObject(result.confidence)) {
        for (const key of ['overall', 'value']) {
            const value = result.confidence[key];
            if (typeof value === 'number' && Number.isFinite(value) && value > rules.confidenceCap) {
                errors.push(`result.confidence.${key}: must not exceed ${rules.confidenceCap} in mode ${mode}`);
            }
        }
    }

    const facts = isObject(result.computedFacts) ? result.computedFacts : {};
    const baseline = Array.isArray(result.baselineStrategy) ? result.baselineStrategy : [];
    const provenanceById = new Map(
        (Array.isArray(result.provenance) ? result.provenance : [])
            .filter(entry => isObject(entry) && typeof entry.id === 'string')
            .map(entry => [entry.id, entry]),
    );

    // 2) 수치 주장 금지 플래그
    if (rules.forbidNumericEquity && numericValue(facts.equity) !== null) {
        errors.push(`result.computedFacts.equity: numeric equity is not allowed in mode ${mode}`);
    }
    if (rules.forbidNumericEv) {
        if (numericValue(facts.evLoss) !== null || numericValue(facts.ev) !== null) {
            errors.push(`result.computedFacts: numeric EV claims are not allowed in mode ${mode}`);
        }
        baseline.forEach((entry, index) => {
            if (isObject(entry) && numericValue(entry.evBb) !== null) {
                errors.push(`result.baselineStrategy[${index}].evBb: numeric EV is not allowed in mode ${mode}`);
            }
        });
    }
    if (rules.forbidNumericFrequency) {
        baseline.forEach((entry, index) => {
            if (isObject(entry) && numericValue(entry.frequency) !== null) {
                errors.push(`result.baselineStrategy[${index}].frequency: strategy frequency is not allowed in mode ${mode}`);
            }
        });
    }
    if (rules.forbidExploitAdjustment && isObject(result.exploitAdjustment)
        && result.exploitAdjustment.applied === true) {
        errors.push(`result.exploitAdjustment: exploit adjustment is not allowed in mode ${mode}`);
    }

    // 3) prose 금지 어휘/정확 퍼센트
    if (rules.forbiddenProse || rules.forbidExactPercentInProse) {
        const prose = [];
        collectProse(result.explanation, prose);
        prose.forEach(text => {
            if (rules.forbiddenProse && rules.forbiddenProse.test(text)) {
                errors.push(`result.explanation: forbidden claim vocabulary in mode ${mode}: "${text.slice(0, 60)}"`);
            }
            if (rules.forbidExactPercentInProse && EXACT_PERCENT_PATTERN.test(text)) {
                errors.push(`result.explanation: exact percentage claims are not allowed in mode ${mode}: "${text.slice(0, 60)}"`);
            }
        });
    }

    // 4) 수치에 필요한 근거 (provenance / range / evidence)
    if (rules.requireRangeRefForEquity && numericValue(facts.equity) !== null) {
        const rangeIds = new Set(
            (Array.isArray(result.rangeAssumptions) ? result.rangeAssumptions : [])
                .filter(entry => isObject(entry) && typeof entry.rangeId === 'string')
                .map(entry => entry.rangeId),
        );
        const against = isObject(facts.equity) ? facts.equity.againstRangeId : null;
        if (typeof against !== 'string' || !rangeIds.has(against)) {
            errors.push('result.computedFacts.equity.againstRangeId: must reference a declared rangeAssumption');
        }
    }
    if (rules.requireSolverProvenanceForNumbers) {
        baseline.forEach((entry, index) => {
            if (!isObject(entry)) return;
            if (numericValue(entry.frequency) === null && numericValue(entry.evBb) === null) return;
            const ref = typeof entry.provenanceRef === 'string' ? provenanceById.get(entry.provenanceRef) : null;
            if (!ref || typeof ref.engine !== 'string' || typeof ref.version !== 'string') {
                errors.push(`result.baselineStrategy[${index}]: numeric frequency/EV requires provenance with engine and version`);
            }
        });
    }
    if (rules.requireEvidenceForAdjustment && isObject(result.exploitAdjustment)
        && result.exploitAdjustment.applied === true) {
        const evidence = result.exploitAdjustment.evidenceRefs;
        if (!Array.isArray(evidence) || evidence.length === 0) {
            errors.push('result.exploitAdjustment.evidenceRefs: applied adjustment requires non-empty evidence');
        }
        if (numericValue(result.exploitAdjustment.maximumShift) === null) {
            errors.push('result.exploitAdjustment.maximumShift: applied adjustment requires a finite shift cap');
        }
    }

    return { ok: errors.length === 0, errors };
}
