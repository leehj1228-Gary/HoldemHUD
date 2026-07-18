// 트레이스 비교기 — 필드 단위로 대조하고, fixture가 선언한 expectedDivergences만
// 통과시킨다. 선언 없는 불일치도, 더 이상 재현되지 않는 선언(스테일)도 모두 실패다:
// 두 엔진의 규칙 경계가 어느 쪽으로든 소리 없이 움직이는 것을 막는 게 목적이다.

const DECISION_FIELDS = [
    'street', 'actorSeat', 'pot', 'currentBet', 'toCall',
    'canFold', 'canCheckOrCall', 'canWager', 'wagerMinTo', 'wagerMaxTo',
    'stacks', 'streetCommitted',
];
const FINAL_FIELDS = ['street', 'wentToShowdown', 'pots', 'netCommitted', 'finalStacks'];

function canonical(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    const keys = Object.keys(value).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function sameValue(a, b) {
    return canonical(a) === canonical(b);
}

function describeValue(value) {
    return canonical(value);
}

/**
 * @returns {string[]} 문제 목록 (비어 있으면 완전 일치)
 */
export function compareTraces(fixture, jsTrace, pokerkitTrace) {
    const problems = [];
    const divergences = (fixture.expectedDivergences ?? []).map(entry => ({ entry, used: false }));

    const findDivergence = (decision, field, jsValue, pokerkitValue) => {
        for (const candidate of divergences) {
            const { entry } = candidate;
            if (entry.decision === decision && entry.field === field
                && sameValue(entry.js, jsValue) && sameValue(entry.pokerkit, pokerkitValue)) {
                candidate.used = true;
                return true;
            }
        }
        return false;
    };

    const compareField = (where, decision, field, jsValue, pokerkitValue) => {
        if (sameValue(jsValue, pokerkitValue)) {
            const stale = divergences.find(({ entry }) => entry.decision === decision && entry.field === field);
            if (stale) {
                problems.push(`${where}.${field}: 선언된 divergence가 더 이상 재현되지 않는다 (양쪽 모두 ${describeValue(jsValue)})`);
                stale.used = true;
            }
            return;
        }
        if (!findDivergence(decision, field, jsValue, pokerkitValue)) {
            problems.push(`${where}.${field}: js=${describeValue(jsValue)} pokerkit=${describeValue(pokerkitValue)} — 선언되지 않은 불일치`);
        }
    };

    if (jsTrace.decisions.length !== pokerkitTrace.decisions.length) {
        problems.push(`decision 수 불일치: js=${jsTrace.decisions.length} pokerkit=${pokerkitTrace.decisions.length}`);
        return problems;
    }
    for (let i = 0; i < jsTrace.decisions.length; i += 1) {
        for (const field of DECISION_FIELDS) {
            compareField(`decision[${i}]`, i, field, jsTrace.decisions[i][field], pokerkitTrace.decisions[i][field]);
        }
    }
    for (const field of FINAL_FIELDS) {
        compareField('final', 'final', field, jsTrace.final[field], pokerkitTrace.final[field]);
    }
    for (const { entry, used } of divergences) {
        if (!used) {
            problems.push(`expectedDivergences 항목이 소비되지 않았다: decision=${entry.decision} field=${entry.field}`);
        }
    }
    return problems;
}

export { DECISION_FIELDS, FINAL_FIELDS };
