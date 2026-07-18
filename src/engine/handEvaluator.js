// NLHE 쇼다운 핸드 평가기 + 자동 승자 판정 (순수 모듈 — React·storage import 금지).
// 목적: 상세 기록 완료 시 보드 5장과 생존자 홀카드가 모두 알려져 있으면
// 팟별 승자를 사람이 고르지 않아도 되게 한다 (docs/DIFFERENTIAL_REPLAY.md의
// 차등 하네스가 PokerKit 자체 쇼다운 평가와 이 모듈의 판정을 교차 검증한다).
import { normalizeCard } from './schema.js';
import { deriveDetailedState, deriveSidePots } from './detailedHandEngine.js';

const RANK_VALUES = Object.fromEntries('23456789TJQKA'.split('').map((rank, i) => [rank, i + 2]));

export const HAND_CATEGORIES = [
    'high_card', 'pair', 'two_pair', 'trips', 'straight',
    'flush', 'full_house', 'quads', 'straight_flush',
];

const CATEGORY_LABELS_KO = {
    high_card: '하이카드',
    pair: '원페어',
    two_pair: '투페어',
    trips: '트리플',
    straight: '스트레이트',
    flush: '플러시',
    full_house: '풀하우스',
    quads: '포카드',
    straight_flush: '스트레이트 플러시',
};

function descending(values) {
    return [...values].sort((a, b) => b - a);
}

// 중복 제거된 내림차순 값 목록에서 최고 스트레이트 탑 랭크 (휠 A-5 포함), 없으면 null
function straightHigh(uniqueDescValues) {
    const values = new Set(uniqueDescValues);
    if (values.has(14)) values.add(1); // 휠에서 A는 1로도 쓰인다
    let run = 0;
    let previous = null;
    let best = null;
    for (const value of descending([...values])) {
        run = previous !== null && previous - value === 1 ? run + 1 : 1;
        previous = value;
        if (run >= 5) {
            best = value + 4;
            break; // 내림차순이므로 처음 완성된 5연속이 최고 스트레이트다
        }
    }
    return best;
}

/**
 * 5~7장의 카드에서 최선의 5장 조합을 평가한다.
 * @returns {{category: string, ranks: number[]}|null}
 *   ranks[0]은 카테고리 서열(0~8), 이후는 동카테고리 타이브레이크 값 —
 *   배열 사전식 비교만으로 우열이 갈린다. 잘못된 입력은 null.
 */
export function evaluateBestHand(cards) {
    if (!Array.isArray(cards) || cards.length < 5 || cards.length > 7) return null;
    const normalized = cards.map(normalizeCard);
    if (!normalized.every(Boolean) || new Set(normalized).size !== normalized.length) return null;

    const values = normalized.map(card => RANK_VALUES[card[0]]);
    const suits = new Map();
    normalized.forEach((card, index) => {
        const suit = card[1];
        if (!suits.has(suit)) suits.set(suit, []);
        suits.get(suit).push(values[index]);
    });
    const counts = new Map();
    for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
    // 같은 매수끼리는 높은 값 우선 정렬
    const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
    const uniqueDesc = descending([...counts.keys()]);
    const kickersExcluding = (excluded, take) =>
        uniqueDesc.filter(value => !excluded.includes(value)).slice(0, take);

    const result = (category, tiebreaks) => ({
        category,
        ranks: [HAND_CATEGORIES.indexOf(category), ...tiebreaks],
    });

    const flushValues = [...suits.values()].find(list => list.length >= 5) || null;
    if (flushValues) {
        const sfHigh = straightHigh(descending([...new Set(flushValues)]));
        if (sfHigh !== null) return result('straight_flush', [sfHigh]);
    }

    const [topValue, topCount] = groups[0];
    if (topCount === 4) {
        return result('quads', [topValue, ...kickersExcluding([topValue], 1)]);
    }
    if (topCount === 3) {
        const pairValue = groups.slice(1).find(([, count]) => count >= 2)?.[0];
        if (pairValue !== undefined) return result('full_house', [topValue, pairValue]);
    }
    if (flushValues) return result('flush', descending(flushValues).slice(0, 5));
    const straightTop = straightHigh(uniqueDesc);
    if (straightTop !== null) return result('straight', [straightTop]);
    if (topCount === 3) {
        return result('trips', [topValue, ...kickersExcluding([topValue], 2)]);
    }
    if (topCount === 2) {
        const secondPair = groups[1]?.[1] === 2 ? groups[1][0] : null;
        if (secondPair !== null) {
            return result('two_pair', [topValue, secondPair, ...kickersExcluding([topValue, secondPair], 1)]);
        }
        return result('pair', [topValue, ...kickersExcluding([topValue], 3)]);
    }
    return result('high_card', uniqueDesc.slice(0, 5));
}

/** 양수: a 승, 음수: b 승, 0: 동률(스플릿). */
export function compareEvaluations(a, b) {
    const length = Math.max(a.ranks.length, b.ranks.length);
    for (let i = 0; i < length; i += 1) {
        const delta = (a.ranks[i] ?? 0) - (b.ranks[i] ?? 0);
        if (delta !== 0) return delta;
    }
    return 0;
}

export function describeEvaluation(evaluation) {
    if (!evaluation) return null;
    if (evaluation.category === 'straight_flush' && evaluation.ranks[1] === 14) return '로열 플러시';
    return CATEGORY_LABELS_KO[evaluation.category] || evaluation.category;
}

/**
 * 완료 가능한 상세 핸드의 쇼다운 승자를 팟별로 자동 판정한다.
 *
 * 판정 가능 조건: 생존자(폴드 안 한 액티브) 2명 이상, 보드 5장 전부 알려짐,
 * 모든 생존자의 홀카드가 알려짐(hero 또는 reveals). 하나라도 어긋나면 null —
 * 호출자는 null이면 기존 수동 승자 선택으로 폴백한다. 동률은 해당 팟에
 * 여러 승자(스플릿)로 표현되며 completeDetailedHand의 winners 입력형과 호환된다.
 */
export function determineShowdownWinners(hand) {
    const state = deriveDetailedState(hand);
    if (!state.enabled) return null;
    const live = state.players.filter(player => player.active && !player.folded);
    if (live.length < 2) return null;
    const board = [...state.board.flop, ...state.board.turn, ...state.board.river];
    if (board.length !== 5) return null;

    const holeBySeat = new Map();
    if (state.heroSeat !== null && state.heroCards.length === 2) {
        holeBySeat.set(state.heroSeat, state.heroCards);
    }
    for (const reveal of state.reveals) {
        if (reveal.cards.length === 2) holeBySeat.set(reveal.seat, reveal.cards);
    }
    const evaluations = new Map();
    for (const player of live) {
        const hole = holeBySeat.get(player.seat);
        if (!hole) return null;
        const evaluation = evaluateBestHand([...hole, ...board]);
        if (!evaluation) return null;
        evaluations.set(player.seat, evaluation);
    }

    const side = deriveSidePots(hand);
    if (side.pots.length === 0) return null;
    const winners = [];
    const pots = [];
    for (const pot of side.pots) {
        const eligible = pot.eligibleSeats.filter(seat => evaluations.has(seat));
        if (eligible.length === 0) return null;
        let winnerSeats = [];
        for (const seat of eligible) {
            if (winnerSeats.length === 0) {
                winnerSeats = [seat];
                continue;
            }
            const delta = compareEvaluations(evaluations.get(seat), evaluations.get(winnerSeats[0]));
            if (delta > 0) winnerSeats = [seat];
            else if (delta === 0) winnerSeats.push(seat);
        }
        winners.push(...winnerSeats.map(seat => ({ seat, potIndex: pot.index })));
        pots.push({
            index: pot.index,
            type: pot.type,
            amount: pot.amount,
            winnerSeats,
        });
    }
    return {
        winners,
        pots,
        evaluations: Object.fromEntries([...evaluations].map(([seat, evaluation]) => [seat, {
            category: evaluation.category,
            label: describeEvaluation(evaluation),
            ranks: evaluation.ranks,
        }])),
    };
}
