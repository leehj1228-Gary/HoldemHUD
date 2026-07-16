import { describe, expect, it } from 'vitest';
import {
    createHand,
    createSeat,
    normalizeDetailedHandRecord,
} from '../../src/engine/schema.js';
import {
    advanceDetailedStreet,
    applyDetailedAction,
    deriveDetailedState,
    enableDetailedTracking,
    setDetailedCards,
} from '../../src/engine/detailedHandEngine.js';

function makeDetailedHand() {
    const seats = [createSeat(0, 'Hero'), createSeat(1, 'Villain')];
    const hand = createHand({
        handNo: 1,
        dealerSeat: 0,
        straddleCount: 0,
        blinds: { sb: 1, bb: 2 },
        seats,
        positions: new Map([[0, 'BTN'], [1, 'BB']]),
        startedAt: 1000,
    });
    let detailed = enableDetailedTracking(hand, {
        heroSeat: 0,
        chipUnit: 1,
        startingStacks: { 0: 100, 1: 100 },
        stackPrecisions: { 0: 'exact', 1: 'estimated' },
    });
    detailed = setDetailedCards(detailed, {
        heroCards: ['Ah', 'Kd'],
        reveals: [{ seat: 1, cards: ['Jc', 'Td'] }],
    });
    detailed = applyDetailedAction(detailed, 0, 'call', { precision: 'exact' });
    detailed = applyDetailedAction(detailed, 1, 'check', { precision: 'exact' });
    detailed = advanceDetailedStreet(detailed, ['Qs', '7h', '2c']);
    return { ...detailed, schemaVersion: 2, captureLevel: 'detailed' };
}

function corrupted(mutator) {
    const hand = structuredClone(makeDetailedHand());
    mutator(hand);
    return hand;
}

describe('normalizeDetailedHandRecord', () => {
    it('deep-clones a canonical engine record without changing its data', () => {
        const hand = makeDetailedHand();
        const normalized = normalizeDetailedHandRecord(hand);

        expect(normalized).toEqual(hand);
        expect(normalized).not.toBe(hand);
        expect(normalized.detailed).not.toBe(hand.detailed);
        expect(normalized.actions).not.toBe(hand.actions);
        expect(normalized.detailed.reveals[0].cards).not.toBe(hand.detailed.reveals[0].cards);
        expect(() => deriveDetailedState(normalized)).not.toThrow();
    });

    it('fills omitted optional persisted fields with conservative replay-safe defaults', () => {
        const hand = makeDetailedHand();
        hand.actions = [];
        delete hand.detailed.street;
        delete hand.detailed.board;
        delete hand.detailed.heroCards;
        delete hand.detailed.reveals;
        delete hand.detailed.winners;
        delete hand.detailed.completed;
        delete hand.detailed.startingStacks;
        delete hand.detailed.startingStackPrecisions;

        const normalized = normalizeDetailedHandRecord(hand);

        expect(normalized.detailed).toMatchObject({
            street: 'preflop',
            board: { flop: [], turn: [], river: [] },
            heroCards: [],
            reveals: [],
            winners: [],
            completed: false,
            startingStacks: { 0: null, 1: null },
            startingStackPrecisions: { 0: 'unknown', 1: 'unknown' },
        });
        expect(() => deriveDetailedState(normalized)).not.toThrow();
    });

    it('canonicalizes persisted card case and supported reveal/winner shorthand', () => {
        const hand = makeDetailedHand();
        hand.detailed.heroCards = ['ah', 'kD'];
        hand.detailed.reveals = { 1: ['jc', 'tD'] };
        hand.detailed.winners = [1];
        hand.detailed.completed = true;

        const normalized = normalizeDetailedHandRecord(hand);

        expect(normalized.detailed.heroCards).toEqual(['Ah', 'Kd']);
        expect(normalized.detailed.reveals).toEqual([{ seat: 1, cards: ['Jc', 'Td'] }]);
        expect(normalized.detailed.winners).toEqual([{ seat: 1, potIndex: null }]);
        expect(() => deriveDetailedState(normalized)).not.toThrow();
    });

    it('repairs duplicate action seq values by renumbering in array order', () => {
        // seq는 다운스트림 식별자(React key·decisionId·AI 리뷰): 중복 레코드는 거부가
        // 아니라 0..n-1 재부여로 복구되어야 한다.
        const hand = corrupted(h => { h.actions[1].seq = h.actions[0].seq; });
        const normalized = normalizeDetailedHandRecord(hand);
        expect(normalized).not.toBeNull();
        expect(normalized.actions.map(action => action.seq)).toEqual([0, 1]);
        expect(() => deriveDetailedState(normalized)).not.toThrow();
    });

    it('passes unique (even non-contiguous) seq values through unchanged', () => {
        const hand = corrupted(h => {
            h.actions[0].seq = 3;
            h.actions[1].seq = 7;
        });
        const normalized = normalizeDetailedHandRecord(hand);
        expect(normalized.actions.map(action => action.seq)).toEqual([3, 7]);
    });

    it.each([
        ['reveal cards are not an array', hand => { hand.detailed.reveals = [{ seat: 1, cards: null }]; }],
        ['a reveal seat is unknown', hand => { hand.detailed.reveals = [{ seat: 9, cards: ['Jc', 'Td'] }]; }],
        ['the hero is also listed as an opponent reveal', hand => {
            hand.detailed.reveals = [{ seat: 0, cards: ['Jc', 'Td'] }];
        }],
        ['the flop has the wrong cardinality', hand => { hand.detailed.board.flop = ['Qs', '7h']; }],
        ['a card array is sparse', hand => { hand.detailed.board.flop = Array(3); }],
        ['a card is duplicated across private and public cards', hand => { hand.detailed.board.flop[0] = 'Ah'; }],
        ['a starting stack is negative', hand => { hand.detailed.startingStacks[0] = -1; }],
        ['a stack precision is invalid', hand => { hand.detailed.startingStackPrecisions[0] = 'roughly'; }],
        ['an action entry is null', hand => { hand.actions[0] = null; }],
        ['an action amount is a string', hand => { hand.actions[0].amountTo = '2'; }],
        ['an action street is invalid', hand => { hand.actions[0].street = 'showdown'; }],
        ['actions go backwards across streets', hand => {
            hand.actions = [
                { ...hand.actions[0], street: 'flop' },
                { ...hand.actions[1], street: 'preflop' },
            ];
        }],
        ['a winner entry is malformed', hand => { hand.detailed.winners = [null]; }],
        ['a winner references an unknown seat', hand => { hand.detailed.winners = [{ seat: 9, potIndex: null }]; }],
        ['a winner references an impossible side pot', hand => { hand.detailed.winners = [{ seat: 1, potIndex: 2 }]; }],
        ['a completed record has no winner', hand => {
            hand.detailed.completed = true;
            hand.detailed.winners = [];
        }],
        ['an incomplete record already declares a winner', hand => {
            hand.detailed.completed = false;
            hand.detailed.winners = [{ seat: 0, potIndex: null }];
        }],
    ])('rejects the whole record when %s', (_label, mutate) => {
        const hand = corrupted(mutate);
        expect(() => normalizeDetailedHandRecord(hand)).not.toThrow();
        expect(normalizeDetailedHandRecord(hand)).toBeNull();
    });

    it('bounds corrupted ledger sizes before any replay work', () => {
        const hand = makeDetailedHand();
        hand.actions = Array.from({ length: 513 }, (_, seq) => ({
            ...hand.actions[0],
            seq,
        }));

        expect(normalizeDetailedHandRecord(hand)).toBeNull();
    });

    it('returns null instead of throwing for non-record and hostile nested values', () => {
        expect(normalizeDetailedHandRecord(null)).toBeNull();
        expect(normalizeDetailedHandRecord({ detailed: { enabled: true }, seats: 'bad', actions: [] })).toBeNull();
        expect(normalizeDetailedHandRecord(corrupted(hand => {
            hand.detailed.startingStacks = '100bb';
        }))).toBeNull();
    });
});
