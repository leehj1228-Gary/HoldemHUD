import { describe, it, expect } from 'vitest';
import { createHand, createSeat } from '../../src/engine/schema.js';
import { positionsForHand } from '../../src/engine/handEngine.js';
import {
    enableDetailedTracking,
    applyDetailedAction,
    setDetailedCards,
    advanceDetailedStreet,
    checkDownStreet,
    dealRunoutBoard,
} from '../../src/engine/detailedHandEngine.js';
import {
    evaluateBestHand,
    compareEvaluations,
    describeEvaluation,
    determineShowdownWinners,
} from '../../src/engine/handEvaluator.js';

function makeHand(playerCount = 3, { dealerSeat = 0, blinds = { sb: 1, bb: 2 }, straddleCount = 0 } = {}) {
    const seats = Array.from({ length: playerCount }, (_, seat) => createSeat(seat, `P${seat}`));
    return createHand({
        handNo: 1,
        dealerSeat,
        straddleCount,
        blinds,
        seats,
        positions: positionsForHand(seats, dealerSeat),
        startedAt: 1,
    });
}

function tracked(playerCount, stacks, options = {}) {
    return enableDetailedTracking(makeHand(playerCount, options), {
        heroSeat: 0,
        startingStacks: stacks,
        chipUnit: 1,
    });
}

describe('evaluateBestHand', () => {
    const evalOf = (cards) => evaluateBestHand(cards);

    it('orders every category correctly', () => {
        const ladder = [
            evalOf(['Ah', 'Kd', 'Qc', '9s', '7h', '4d', '2c']), // high card
            evalOf(['Ah', 'Ad', 'Qc', '9s', '7h', '4d', '2c']), // pair
            evalOf(['Ah', 'Ad', 'Qc', 'Qs', '7h', '4d', '2c']), // two pair
            evalOf(['Ah', 'Ad', 'Ac', 'Qs', '7h', '4d', '2c']), // trips
            evalOf(['Ah', 'Kd', 'Qc', 'Js', 'Th', '4d', '2c']), // straight
            evalOf(['Ah', 'Jh', '8h', '5h', '2h', 'Kd', 'Qc']), // flush
            evalOf(['Ah', 'Ad', 'Ac', 'Ks', 'Kh', '4d', '2c']), // full house
            evalOf(['Ah', 'Ad', 'Ac', 'As', 'Kh', '4d', '2c']), // quads
            evalOf(['9h', '8h', '7h', '6h', '5h', 'Kd', 'Ac']), // straight flush
        ];
        for (let i = 1; i < ladder.length; i += 1) {
            expect(compareEvaluations(ladder[i], ladder[i - 1])).toBeGreaterThan(0);
        }
        expect(ladder.map(e => e.category)).toEqual([
            'high_card', 'pair', 'two_pair', 'trips', 'straight',
            'flush', 'full_house', 'quads', 'straight_flush',
        ]);
    });

    it('recognizes the wheel and ranks it below a six-high straight', () => {
        const wheel = evalOf(['Ah', '2c', '3d', '4s', '5h', '9c', 'Kd']);
        const sixHigh = evalOf(['2h', '3c', '4d', '5s', '6h', '9c', 'Kd']);
        expect(wheel.category).toBe('straight');
        expect(wheel.ranks[1]).toBe(5);
        expect(compareEvaluations(sixHigh, wheel)).toBeGreaterThan(0);
    });

    it('finds a steel wheel as a straight flush', () => {
        const steelWheel = evalOf(['Ah', '2h', '3h', '4h', '5h', 'Kc', 'Kd']);
        expect(steelWheel.category).toBe('straight_flush');
        expect(steelWheel.ranks[1]).toBe(5);
    });

    it('labels a broadway straight flush as 로열 플러시', () => {
        const royal = evalOf(['Ah', 'Kh', 'Qh', 'Jh', 'Th', '2c', '3d']);
        expect(describeEvaluation(royal)).toBe('로열 플러시');
        expect(describeEvaluation(evalOf(['Ah', 'Ad', 'Qc', '9s', '7h']))).toBe('원페어');
    });

    it('compares flushes by all five cards', () => {
        const higher = evalOf(['Ah', 'Jh', '9h', '7h', '2h', '3c', '4d']);
        const lower = evalOf(['As', 'Js', '9s', '6s', '5s', '3c', '4d']);
        expect(compareEvaluations(higher, lower)).toBeGreaterThan(0);
    });

    it('builds the best full house from two sets', () => {
        const evaluation = evalOf(['7h', '7c', '7d', '8h', '8c', '8d', 'Kc']);
        expect(evaluation.category).toBe('full_house');
        expect(evaluation.ranks.slice(1)).toEqual([8, 7]);
    });

    it('keeps only the top two pairs plus the best kicker', () => {
        const evaluation = evalOf(['Ah', 'Ac', 'Kh', 'Kc', 'Qh', 'Qc', 'Jd']);
        expect(evaluation.category).toBe('two_pair');
        expect(evaluation.ranks.slice(1)).toEqual([14, 13, 12]);
    });

    it('uses exactly one kicker for quads and three for a pair', () => {
        expect(evalOf(['9h', '9c', '9d', '9s', 'Ac', 'Kd', '2c']).ranks.slice(1)).toEqual([9, 14]);
        expect(evalOf(['9h', '9c', 'Ad', 'Ks', 'Qc', '2d', '3c']).ranks.slice(1)).toEqual([9, 14, 13, 12]);
    });

    it('ties when the board plays for both hands', () => {
        const board = ['Ah', 'Kh', 'Qh', 'Jh', 'Th'];
        const a = evalOf([...board, '2c', '3c']);
        const b = evalOf([...board, '4d', '5d']);
        expect(compareEvaluations(a, b)).toBe(0);
    });

    it('rejects malformed input', () => {
        expect(evaluateBestHand(['Ah', 'Ah', 'Qc', '9s', '7h'])).toBeNull();
        expect(evaluateBestHand(['Ah', 'Kd', 'Qc', '9s'])).toBeNull();
        expect(evaluateBestHand(['Xx', 'Kd', 'Qc', '9s', '7h'])).toBeNull();
        expect(evaluateBestHand(null)).toBeNull();
    });
});

describe('determineShowdownWinners', () => {
    // HU 올인 → 런아웃 → 카드 공개 → 자동 판정까지의 대표 경로
    function headsUpShowdown({ heroCards, villainCards, board }) {
        let hand = tracked(2, [50, 50]);
        hand = applyDetailedAction(hand, 0, 'all-in');
        hand = applyDetailedAction(hand, 1, 'call');
        hand = dealRunoutBoard(hand, board);
        hand = setDetailedCards(hand, {
            heroSeat: 0,
            heroCards,
            reveals: [{ seat: 1, cards: villainCards }],
        });
        return hand;
    }

    it('is null until the full board and all live hole cards are known', () => {
        let hand = tracked(2, [50, 50]);
        hand = applyDetailedAction(hand, 0, 'all-in');
        hand = applyDetailedAction(hand, 1, 'call');
        expect(determineShowdownWinners(hand)).toBeNull(); // 보드 없음

        hand = dealRunoutBoard(hand, { flop: ['2c', '7d', '9h'], turn: ['Th'], river: ['3s'] });
        expect(determineShowdownWinners(hand)).toBeNull(); // 카드 미공개

        hand = setDetailedCards(hand, { heroSeat: 0, heroCards: ['Ah', 'Ad'] });
        expect(determineShowdownWinners(hand)).toBeNull(); // 상대 카드 미공개
    });

    it('awards the single pot to the better hand with a Korean label', () => {
        const hand = headsUpShowdown({
            heroCards: ['Ah', 'Ad'],
            villainCards: ['Ks', 'Kd'],
            board: { flop: ['2c', '7d', '9h'], turn: ['Th'], river: ['3s'] },
        });
        const result = determineShowdownWinners(hand);
        expect(result.winners).toEqual([{ seat: 0, potIndex: 0 }]);
        expect(result.pots).toEqual([{ index: 0, type: 'main', amount: 100, winnerSeats: [0] }]);
        expect(result.evaluations[0].label).toBe('원페어');
        expect(result.evaluations[1].label).toBe('원페어');
    });

    it('splits a pot on identical hands', () => {
        const hand = headsUpShowdown({
            heroCards: ['Ah', 'Kc'],
            villainCards: ['Ad', 'Ks'],
            board: { flop: ['Qs', 'Jd', '7c'], turn: ['7h'], river: ['2s'] },
        });
        const result = determineShowdownWinners(hand);
        expect(result.winners).toEqual([
            { seat: 0, potIndex: 0 },
            { seat: 1, potIndex: 0 },
        ]);
        expect(result.pots[0].winnerSeats).toEqual([0, 1]);
    });

    it('assigns layered pots to different winners and excludes folded seats', () => {
        // 3인: seat0 숏올인 20, seat1 올인 50, seat2 콜 → 메인(60)+사이드(60)
        let hand = tracked(3, [20, 50, 50]);
        hand = applyDetailedAction(hand, 0, 'all-in');
        hand = applyDetailedAction(hand, 1, 'all-in');
        hand = applyDetailedAction(hand, 2, 'call');
        hand = dealRunoutBoard(hand, { flop: ['2c', '7d', '9h'], turn: ['Th'], river: ['3s'] });
        hand = setDetailedCards(hand, {
            heroSeat: 0,
            heroCards: ['Ah', 'Ad'],
            reveals: [
                { seat: 1, cards: ['Ks', 'Kd'] },
                { seat: 2, cards: ['Qs', 'Qd'] },
            ],
        });
        const result = determineShowdownWinners(hand);
        expect(result.winners).toEqual([
            { seat: 0, potIndex: 0 },
            { seat: 1, potIndex: 1 },
        ]);
        expect(result.pots).toEqual([
            { index: 0, type: 'main', amount: 60, winnerSeats: [0] },
            { index: 1, type: 'side', amount: 60, winnerSeats: [1] },
        ]);
    });

    it('ignores a folded seat even when its cards are revealed', () => {
        // 3인: seat0 폴드(카드 공개 상태) — 남은 두 명만 판정 대상
        let hand = tracked(3, [100, 100, 100]);
        hand = applyDetailedAction(hand, 0, 'call');
        hand = applyDetailedAction(hand, 1, 'call');
        hand = applyDetailedAction(hand, 2, 'raise', { amountTo: 8 });
        hand = applyDetailedAction(hand, 0, 'fold');
        hand = applyDetailedAction(hand, 1, 'call');
        expect(dealRunoutBoard(hand, {})).toBe(hand); // 응수 가능 2명 — 런아웃 배치는 거부

        hand = advanceDetailedStreet(hand, ['2c', '7d', '9h']);
        hand = checkDownStreet(hand);
        hand = advanceDetailedStreet(hand, ['Th']);
        hand = checkDownStreet(hand);
        hand = advanceDetailedStreet(hand, ['3s']);
        hand = checkDownStreet(hand);
        hand = setDetailedCards(hand, {
            heroSeat: 0,
            heroCards: ['Ah', 'Ad'],
            reveals: [
                { seat: 1, cards: ['Ks', 'Kd'] },
                { seat: 2, cards: ['Qs', 'Qd'] },
            ],
        });
        const result = determineShowdownWinners(hand);
        expect(result.winners.every(winner => winner.seat !== 0)).toBe(true);
        // seat0의 폴드 커밋(2)은 자격 집합을 바꾸지 못하므로 팟은 하나로 병합된다
        expect(result.winners).toEqual([{ seat: 1, potIndex: 0 }]);
        expect(result.pots).toEqual([{ index: 0, type: 'main', amount: 18, winnerSeats: [1] }]);
        expect(result.evaluations[0]).toBeUndefined();
    });
});
