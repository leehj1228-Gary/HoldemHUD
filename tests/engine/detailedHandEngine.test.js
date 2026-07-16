import { describe, it, expect } from 'vitest';
import { createHand, createSeat, MAX_DETAILED_ACTIONS } from '../../src/engine/schema.js';
import { applyAction, positionsForHand } from '../../src/engine/handEngine.js';
import {
    enableDetailedTracking,
    chipUnitForBlinds,
    deriveDetailedState,
    legalDetailedActions,
    applyDetailedAction,
    advanceDetailedStreet,
    setDetailedCards,
    completeDetailedHand,
    undoDetailedStep,
    deriveSidePots,
} from '../../src/engine/detailedHandEngine.js';

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

function tracked(playerCount = 3, stacks = null, options = {}) {
    const hand = makeHand(playerCount, options);
    const startingStacks = stacks || Array.from({ length: playerCount }, () => 100);
    return enableDetailedTracking(hand, { heroSeat: 0, startingStacks, chipUnit: 1 });
}

function closeThreeHandedLimpPot(hand) {
    let next = applyDetailedAction(hand, 0, 'call');
    next = applyDetailedAction(next, 1, 'call');
    next = applyDetailedAction(next, 2, 'check');
    return next;
}

describe('enableDetailedTracking / v1 compatibility', () => {
    it('adds opt-in metadata without mutating the v1 hand', () => {
        const original = makeHand();
        const enabled = enableDetailedTracking(original, {
            heroSeat: 1,
            startingStacks: { 0: 100, 1: 80, 2: 60 },
            chipUnit: 0.5,
        });

        expect(enabled).not.toBe(original);
        expect(original.detailed).toBeUndefined();
        expect(enabled.detailed).toMatchObject({ enabled: true, heroSeat: 1, chipUnit: 0.5, street: 'preflop' });
        expect(enabled.detailed.startingStacks).toEqual({ 0: 100, 1: 80, 2: 60 });
        expect(enableDetailedTracking(enabled, {})).toBe(enabled);
    });

    it('normalizes legacy actions as unknown but preserves action-order turn derivation', () => {
        let legacy = makeHand();
        legacy = applyAction(legacy, 0, 'fold');
        const enabled = enableDetailedTracking(legacy, { startingStacks: [100, 100, 100] });
        const state = deriveDetailedState(enabled);

        expect(enabled.actions[0]).toMatchObject({
            seat: 0, type: 'fold', street: 'preflop', amountTo: null,
            amountAdded: null, precision: 'unknown', isAllIn: false,
        });
        expect(state.quality).toBe('unknown');
        expect(state.toActSeat).toBe(1);
        expect(state.pot).toBe(3);
    });

    it('keeps approximate starting stacks separate from exact pot quality', () => {
        const hand = enableDetailedTracking(makeHand(), {
            startingStacks: { 0: 100, 1: 100, 2: 100 },
            stackPrecisions: { 0: 'estimated', 1: 'estimated', 2: 'estimated' },
            chipUnit: 1,
        });
        const state = deriveDetailedState(hand);
        expect(state.potQuality).toBe('exact');
        expect(state.stackQuality).toBe('estimated');
        expect(state.players.every(player => player.startingStackPrecision === 'estimated')).toBe(true);
    });
});

describe('forced posts and automatic chip amounts', () => {
    it('derives blinds, pot, stacks, first actor, and legal commands', () => {
        const hand = tracked();
        const state = deriveDetailedState(hand);

        expect(state.quality).toBe('exact');
        expect(state.pot).toBe(3);
        expect(state.currentBet).toBe(2);
        expect(state.toActSeat).toBe(0);
        expect(state.toCall).toBe(2);
        expect(state.playerBySeat.get(1)).toMatchObject({ stack: 99, streetCommitted: 1, totalCommitted: 1 });
        expect(state.playerBySeat.get(2)).toMatchObject({ stack: 98, streetCommitted: 2, totalCommitted: 2 });
        expect(legalDetailedActions(hand, 0)).toEqual(['fold', 'call', 'raise', 'all-in']);
    });

    it('automatically computes calls and closes a limp/check preflop street', () => {
        const closed = closeThreeHandedLimpPot(tracked());
        const state = deriveDetailedState(closed);

        expect(closed.actions.map(a => [a.type, a.amountTo, a.amountAdded])).toEqual([
            ['call', 2, 2],
            ['call', 2, 1],
            ['check', 2, 0],
        ]);
        expect(state.streetClosed).toBe(true);
        expect(state.toActSeat).toBeNull();
        expect(state.pot).toBe(6);
        expect(state.players.map(p => p.stack)).toEqual([98, 98, 98]);
    });

    it('stores raise-to amounts and rejects non-all-in under-raises', () => {
        const hand = tracked();
        const illegal = applyDetailedAction(hand, 0, 'raise', { amountTo: 3 });
        expect(illegal).toBe(hand);

        const raised = applyDetailedAction(hand, 0, 'raise', { amountTo: 6 });
        expect(raised.actions[0]).toMatchObject({
            type: 'raise', amountTo: 6, amountAdded: 6, raiseLevel: 1,
            precision: 'exact', isAllIn: false,
        });
        const state = deriveDetailedState(raised);
        expect(state.currentBet).toBe(6);
        expect(state.minRaiseTo).toBe(10);
        expect(state.toActSeat).toBe(1);
        expect(state.toCall).toBe(5);
    });

    it('short calls are automatically marked all-in', () => {
        let hand = tracked(3, [100, 5, 100]);
        hand = applyDetailedAction(hand, 0, 'raise', { amountTo: 10 });
        hand = applyDetailedAction(hand, 1, 'call');
        expect(hand.actions[1]).toMatchObject({ type: 'call', amountTo: 5, amountAdded: 4, isAllIn: true });
        expect(deriveDetailedState(hand).playerBySeat.get(1).allIn).toBe(true);
    });
});

describe('precision propagation and unknown amounts', () => {
    it('keeps a numeric estimated ledger while degrading quality', () => {
        const hand = applyDetailedAction(tracked(), 0, 'raise', { amountTo: 6, precision: 'estimated' });
        const state = deriveDetailedState(hand);
        expect(state.pot).toBe(9);
        expect(state.potQuality).toBe('estimated');
        expect(state.quality).toBe('estimated');
    });

    it('allows an unknown raise to preserve action order without false chip precision', () => {
        const hand = applyDetailedAction(tracked(), 0, 'raise', { precision: 'unknown' });
        const state = deriveDetailedState(hand);
        expect(hand.actions[0]).toMatchObject({ amountTo: null, amountAdded: null, precision: 'unknown' });
        expect(state.toActSeat).toBe(1);
        expect(state.currentBet).toBeNull();
        expect(state.pot).toBeNull();
        expect(state.quality).toBe('unknown');
    });

    it('distinguishes an exact pot from unknown stack quality', () => {
        const hand = enableDetailedTracking(makeHand(), { startingStacks: { 0: 100, 1: 100 } });
        const state = deriveDetailedState(hand);
        expect(state.pot).toBe(3);
        expect(state.potQuality).toBe('exact');
        expect(state.stackQuality).toBe('unknown');
        expect(state.quality).toBe('unknown');
    });
});

describe('street transitions and postflop order', () => {
    it('does not advance an open street', () => {
        const hand = tracked();
        expect(advanceDetailedStreet(hand, ['Ah', 'Kd', '2c'])).toBe(hand);
    });

    it('advances with board cards and acts left of the button postflop', () => {
        const preflop = closeThreeHandedLimpPot(tracked());
        const flop = advanceDetailedStreet(preflop, ['Ah', 'Kd', '2c']);
        const state = deriveDetailedState(flop);

        expect(state.street).toBe('flop');
        expect(state.board.flop).toEqual(['Ah', 'Kd', '2c']);
        expect(state.currentBet).toBe(0);
        expect(state.toActSeat).toBe(1);
        expect(state.toCall).toBe(0);
        expect(legalDetailedActions(flop, 1)).toEqual(['check', 'bet', 'all-in']);
    });

    it('tracks postflop bet/call/fold and resets commitments next street', () => {
        let hand = advanceDetailedStreet(closeThreeHandedLimpPot(tracked()), ['Ah', 'Kd', '2c']);
        hand = applyDetailedAction(hand, 1, 'bet', { amountTo: 4 });
        hand = applyDetailedAction(hand, 2, 'call');
        hand = applyDetailedAction(hand, 0, 'fold');
        let state = deriveDetailedState(hand);
        expect(state.streetClosed).toBe(true);
        expect(state.pot).toBe(14);

        hand = advanceDetailedStreet(hand, ['7s']);
        state = deriveDetailedState(hand);
        expect(state.street).toBe('turn');
        expect(state.board.turn).toEqual(['7s']);
        expect(state.playerBySeat.get(1).streetCommitted).toBe(0);
        expect(state.playerBySeat.get(1).totalCommitted).toBe(6);
        expect(state.toActSeat).toBe(1);
    });
});

describe('raise reopening and all-ins', () => {
    it('a short all-in does not reopen raising for players who already acted', () => {
        let hand = tracked(4, [100, 15, 100, 100]);
        hand = applyDetailedAction(hand, 3, 'raise', { amountTo: 10 });
        hand = applyDetailedAction(hand, 0, 'call');
        hand = applyDetailedAction(hand, 1, 'all-in'); // to 15: short raise by 5, prior full raise was 8
        hand = applyDetailedAction(hand, 2, 'fold');

        const state = deriveDetailedState(hand);
        expect(state.toActSeat).toBe(3);
        expect(state.toCall).toBe(5);
        expect(state.raiseRights[3]).toBe(false);
        expect(legalDetailedActions(hand, 3)).toEqual(['fold', 'call']);
    });

    it('classifies the all-in command as bet/call/raise plus isAllIn', () => {
        let hand = tracked(3, [20, 10, 5]);
        hand = applyDetailedAction(hand, 0, 'all-in');
        hand = applyDetailedAction(hand, 1, 'all-in');
        hand = applyDetailedAction(hand, 2, 'all-in');
        expect(hand.actions.map(a => [a.type, a.isAllIn, a.amountTo])).toEqual([
            ['raise', true, 20],
            ['call', true, 10],
            ['call', true, 5],
        ]);
        const state = deriveDetailedState(hand);
        expect(state.streetClosed).toBe(true);
        expect(state.allRemainingAllIn).toBe(true);
    });
});

describe('cards', () => {
    it('sets hero/revealed cards and normalizes rank/suit case', () => {
        const hand = setDetailedCards(tracked(), {
            heroSeat: 0,
            heroCards: ['as', 'KD'],
            reveals: [{ seat: 1, cards: ['Qc', 'Jh'] }],
        });
        expect(hand.detailed.heroCards).toEqual(['As', 'Kd']);
        expect(hand.detailed.reveals).toEqual([{ seat: 1, cards: ['Qc', 'Jh'] }]);
    });

    it('immutably replaces past board streets through board or street/cards payloads', () => {
        const base = tracked();
        const flop = setDetailedCards(base, { board: { flop: ['ah', 'KD', '2c'] } });
        expect(flop).not.toBe(base);
        expect(base.detailed.board.flop).toEqual([]);
        expect(flop.detailed.board.flop).toEqual(['Ah', 'Kd', '2c']);

        const edited = setDetailedCards(flop, { street: 'flop', cards: ['Qs', 'Jd', 'Tc'] });
        expect(edited.detailed.board.flop).toEqual(['Qs', 'Jd', 'Tc']);
        expect(setDetailedCards(edited, { street: 'turn', cards: ['Qs'] })).toBe(edited);
    });

    it('rejects invalid and duplicate hole/board cards without mutation', () => {
        const base = setDetailedCards(tracked(), { heroSeat: 0, heroCards: ['As', 'Kd'] });
        expect(setDetailedCards(base, { heroCards: ['As', 'As'] })).toBe(base);

        const closed = closeThreeHandedLimpPot(base);
        expect(advanceDetailedStreet(closed, ['As', '7d', '2c'])).toBe(closed);
        expect(advanceDetailedStreet(closed, ['Ah', '7d'])).toBe(closed);
    });

    it('keeps cards attached to their seats when Hero changes', () => {
        const original = setDetailedCards(tracked(), {
            heroSeat: 0,
            heroCards: ['As', 'Kd'],
            reveals: [{ seat: 1, cards: ['Qc', 'Jh'] }],
        });
        const changed = setDetailedCards(original, { heroSeat: 1 });

        expect(changed.detailed.heroSeat).toBe(1);
        expect(changed.detailed.heroCards).toEqual(['Qc', 'Jh']);
        expect(changed.detailed.reveals).toEqual([{ seat: 0, cards: ['As', 'Kd'] }]);
    });

    it('rejects duplicate reveal seats and a reveal for the Hero seat', () => {
        const hand = tracked();
        expect(setDetailedCards(hand, { reveals: [
            { seat: 1, cards: ['As', 'Kd'] },
            { seat: 1, cards: ['Qc', 'Jh'] },
        ] })).toBe(hand);
        expect(setDetailedCards(hand, {
            heroCards: ['As', 'Kd'],
            reveals: [{ seat: 0, cards: ['Qc', 'Jh'] }],
        })).toBe(hand);
    });

    it('locks card edits after completion until completion is undone', () => {
        let hand = tracked();
        hand = applyDetailedAction(hand, 0, 'fold');
        hand = applyDetailedAction(hand, 1, 'fold');
        hand = completeDetailedHand(hand, {});

        expect(setDetailedCards(hand, { heroCards: ['As', 'Kd'] })).toBe(hand);
        const reopened = undoDetailedStep(hand);
        expect(setDetailedCards(reopened, { heroCards: ['As', 'Kd'] })).not.toBe(reopened);
    });
});

describe('side pots and completion', () => {
    function threeWayAllIn() {
        let hand = tracked(3, [100, 50, 20]);
        hand = applyDetailedAction(hand, 0, 'all-in');
        hand = applyDetailedAction(hand, 1, 'all-in');
        hand = applyDetailedAction(hand, 2, 'all-in');
        return hand;
    }

    it('derives main/side pots and an uncalled excess layer', () => {
        const side = deriveSidePots(threeWayAllIn());
        expect(side).toMatchObject({ quality: 'exact', total: 120 });
        expect(side.pots).toEqual([
            {
                index: 0, type: 'main', cap: 20, amount: 60,
                contributorSeats: [0, 1, 2], eligibleSeats: [0, 1, 2],
            },
            {
                index: 1, type: 'side', cap: 50, amount: 60,
                contributorSeats: [0, 1], eligibleSeats: [0, 1],
            },
        ]);
        expect(side.uncalledReturns).toEqual([{ seat: 0, amount: 50 }]);
    });

    it('records pot-specific winners only when every pot has an eligible winner', () => {
        const hand = threeWayAllIn();
        expect(completeDetailedHand(hand, { winners: [{ seat: 2, potIndex: 0 }] })).toBe(hand);

        const complete = completeDetailedHand(hand, {
            winners: [{ seat: 2, potIndex: 0 }, { seat: 1, potIndex: 1 }],
        });
        expect(complete.detailed.completed).toBe(true);
        expect(deriveDetailedState(complete).isComplete).toBe(true);
        expect(legalDetailedActions(complete, 0)).toEqual([]);
    });

    it('automatically records the lone non-folded player as winner', () => {
        let hand = tracked();
        hand = applyDetailedAction(hand, 0, 'fold');
        hand = applyDetailedAction(hand, 1, 'fold');
        const complete = completeDetailedHand(hand, {});
        expect(complete.detailed.completed).toBe(true);
        expect(complete.detailed.winners).toEqual([{ seat: 2, potIndex: null }]);
    });

    it('returns unknown side pots when any chip contribution is unresolved', () => {
        const hand = applyDetailedAction(tracked(), 0, 'raise', { precision: 'unknown' });
        expect(deriveSidePots(hand)).toEqual({
            quality: 'unknown', pots: [], uncalledReturns: [], pendingExcess: [], total: null,
        });
    });
});

describe('undoDetailedStep', () => {
    it('undoes completion before removing the final action', () => {
        let hand = tracked();
        hand = applyDetailedAction(hand, 0, 'fold');
        hand = applyDetailedAction(hand, 1, 'fold');
        hand = completeDetailedHand(hand, {});

        const reopened = undoDetailedStep(hand);
        expect(reopened.detailed.completed).toBe(false);
        expect(reopened.detailed.winners).toEqual([]);
        expect(reopened.actions).toHaveLength(2);

        const withoutFold = undoDetailedStep(reopened);
        expect(withoutFold.actions).toHaveLength(1);
        expect(deriveDetailedState(withoutFold).toActSeat).toBe(1);
    });

    it('rewinds an empty current street and clears only that street board', () => {
        const preflop = closeThreeHandedLimpPot(tracked());
        const flop = advanceDetailedStreet(preflop, ['Ah', 'Kd', '2c']);
        const rewound = undoDetailedStep(flop);

        expect(rewound.detailed.street).toBe('preflop');
        expect(rewound.detailed.board.flop).toEqual([]);
        expect(rewound.actions).toEqual(preflop.actions);
        expect(deriveDetailedState(rewound).streetClosed).toBe(true);
    });
});

describe('live edge cases', () => {
    it('uses raise, not bet, for the BB option after limps', () => {
        let hand = tracked();
        hand = applyDetailedAction(hand, 0, 'call');
        hand = applyDetailedAction(hand, 1, 'call');

        expect(deriveDetailedState(hand).toCall).toBe(0);
        expect(legalDetailedActions(hand, 2)).toEqual(['check', 'raise', 'all-in']);
        const raised = applyDetailedAction(hand, 2, 'raise', { amountTo: 4 });
        expect(raised).not.toBe(hand);
        expect(raised.actions.at(-1)).toMatchObject({ seat: 2, type: 'raise', amountTo: 4 });
    });

    it('derives a shared decimal chip unit and never deadlocks an odd-stack all-in', () => {
        expect(chipUnitForBlinds({ sb: 0.1, bb: 0.25 })).toBeCloseTo(0.05);
        let hand = enableDetailedTracking(makeHand(3, { blinds: { sb: 0.1, bb: 0.25 } }), {
            heroSeat: 0,
            startingStacks: { 0: 8.325, 1: 10, 2: 10 },
        });
        expect(hand.detailed.chipUnit).toBeCloseTo(0.05);

        const called = applyDetailedAction(hand, 0, 'call');
        expect(called.actions.at(-1)).toMatchObject({ type: 'call', amountTo: 0.25 });

        hand = applyDetailedAction(hand, 0, 'all-in');
        expect(hand.actions.at(-1)).toMatchObject({ type: 'raise', isAllIn: true, amountTo: 8.325 });
    });

    it('treats a sub-minimum opening all-in as non-reopening action', () => {
        let hand = tracked(3, [100, 100, 11], { blinds: { sb: 5, bb: 10 } });
        hand = applyDetailedAction(hand, 0, 'call');
        hand = applyDetailedAction(hand, 1, 'call');
        hand = applyDetailedAction(hand, 2, 'check');
        hand = advanceDetailedStreet(hand, []);
        hand = applyDetailedAction(hand, 1, 'check');
        hand = applyDetailedAction(hand, 2, 'all-in');

        const afterShortBet = deriveDetailedState(hand);
        expect(afterShortBet.currentBet).toBe(1);
        expect(afterShortBet.minRaiseTo).toBe(11);
        expect(afterShortBet.raiseRights[1]).toBe(false);
        expect(legalDetailedActions(hand, 0)).toEqual(['fold', 'call', 'raise', 'all-in']);

        hand = applyDetailedAction(hand, 0, 'call');
        expect(legalDetailedActions(hand, 1)).toEqual(['fold', 'call']);
    });

    it('requires all-in plus a full minimum bet to raise over a sub-minimum all-in bet', () => {
        // Robert's Rules/TDA: blinds 5/10, flop all-in bet of 1 -> min raise-to is 1 + 10 = 11.
        let hand = tracked(3, [100, 100, 11], { blinds: { sb: 5, bb: 10 } });
        hand = applyDetailedAction(hand, 0, 'call');
        hand = applyDetailedAction(hand, 1, 'call');
        hand = applyDetailedAction(hand, 2, 'check');
        hand = advanceDetailedStreet(hand, []);
        hand = applyDetailedAction(hand, 1, 'check');
        hand = applyDetailedAction(hand, 2, 'all-in'); // bet 1: below the 10 minimum

        expect(deriveDetailedState(hand).minRaiseTo).toBe(11);
        expect(applyDetailedAction(hand, 0, 'raise', { amountTo: 10 })).toBe(hand);

        const raised = applyDetailedAction(hand, 0, 'raise', { amountTo: 11 });
        expect(raised).not.toBe(hand);
        expect(raised.actions.at(-1)).toMatchObject({ seat: 0, type: 'raise', amountTo: 11 });
        expect(deriveDetailedState(raised).currentBet).toBe(11);
    });

    it('posts a straddle as a live blind with straddle-scaled min-raise and option', () => {
        let hand = tracked(4, [100, 100, 100, 100], { straddleCount: 1 });
        let state = deriveDetailedState(hand);

        expect(state.forcedPosts).toEqual([
            { seat: 1, type: 'smallBlind', amount: 1, nominalAmount: 1 },
            { seat: 2, type: 'bigBlind', amount: 2, nominalAmount: 2 },
            { seat: 3, type: 'straddle', amount: 4, nominalAmount: 4 },
        ]);
        expect(state.pot).toBe(7);
        expect(state.currentBet).toBe(4);
        expect(state.toActSeat).toBe(0);
        expect(state.toCall).toBe(4);
        expect(state.minRaiseTo).toBe(8); // straddle 4 + last full raise size 4, not bb-based
        expect(applyDetailedAction(hand, 0, 'raise', { amountTo: 7 })).toBe(hand);

        hand = applyDetailedAction(hand, 0, 'call');
        hand = applyDetailedAction(hand, 1, 'call');
        hand = applyDetailedAction(hand, 2, 'call');
        state = deriveDetailedState(hand);
        expect(state.toActSeat).toBe(3); // the straddler keeps the option
        expect(legalDetailedActions(hand, 3)).toEqual(['check', 'raise', 'all-in']);
    });

    it('reopens raising when cumulative short all-ins add up to a full raise', () => {
        let hand = tracked(4, [26, 100, 20, 100]);
        hand = applyDetailedAction(hand, 3, 'call');
        hand = applyDetailedAction(hand, 0, 'call');
        hand = applyDetailedAction(hand, 1, 'call');
        hand = applyDetailedAction(hand, 2, 'check');
        hand = advanceDetailedStreet(hand, []);

        hand = applyDetailedAction(hand, 1, 'bet', { amountTo: 10 });
        hand = applyDetailedAction(hand, 2, 'all-in'); // to 18: short raise of 8
        hand = applyDetailedAction(hand, 3, 'call');
        hand = applyDetailedAction(hand, 0, 'all-in'); // to 24: short raise of 6

        const state = deriveDetailedState(hand);
        expect(state.currentBet).toBe(24);
        expect(state.lastFullRaiseSize).toBe(10);
        expect(state.minRaiseTo).toBe(34);
        expect(state.toActSeat).toBe(1);
        // Seat 1 faces 24 - 10 = 14 >= 10 cumulatively: raising reopens for them...
        expect(state.raiseRights[1]).toBe(true);
        expect(legalDetailedActions(hand, 1)).toEqual(['fold', 'call', 'raise', 'all-in']);
        // ...but seat 3 faces only 24 - 18 = 6 < 10 and stays closed.
        expect(state.raiseRights[3]).toBe(false);

        hand = applyDetailedAction(hand, 1, 'call');
        expect(legalDetailedActions(hand, 3)).toEqual(['fold', 'call']);
    });

    it('runs the board without forcing a lone chips-behind player to act', () => {
        let hand = tracked(2, [10, 100]);
        hand = applyDetailedAction(hand, 0, 'all-in');
        hand = applyDetailedAction(hand, 1, 'call');
        hand = advanceDetailedStreet(hand, []);

        const flop = deriveDetailedState(hand);
        expect(flop.players.filter(player => player.active && !player.folded && !player.allIn)).toHaveLength(1);
        expect(flop.streetClosed).toBe(true);
        expect(flop.toActSeat).toBeNull();
        expect(advanceDetailedStreet(hand, [])).not.toBe(hand);
    });

    it('closes preflop when a blind all-in leaves nobody able to respond', () => {
        const hand = tracked(2, [1, 100]);
        const state = deriveDetailedState(hand);

        expect(state.playerBySeat.get(0).allIn).toBe(true);
        expect(state.streetClosed).toBe(true);
        expect(state.toActSeat).toBeNull();
        expect(legalDetailedActions(hand, 1)).toEqual([]);
        expect(applyDetailedAction(hand, 1, 'raise', { amountTo: 10 })).toBe(hand);
    });

    it('lets the sole chips-behind blind call or fold, but not raise into an all-in', () => {
        const hand = tracked(2, [100, 2]);
        const state = deriveDetailedState(hand);

        expect(state.toActSeat).toBe(0);
        expect(state.toCall).toBe(1);
        expect(legalDetailedActions(hand, 0)).toEqual(['fold', 'call']);
        expect(applyDetailedAction(hand, 0, 'raise', { amountTo: 10 })).toBe(hand);
    });

    it('records an unknown call after an unknown raise without inventing zero chips', () => {
        let hand = tracked();
        hand = applyDetailedAction(hand, 0, 'raise', { precision: 'unknown' });
        const invalidZero = applyDetailedAction(hand, 1, 'call', { amountTo: 0, precision: 'exact' });
        expect(invalidZero).toBe(hand);

        hand = applyDetailedAction(hand, 1, 'call', { precision: 'unknown' });
        expect(hand.actions.at(-1)).toMatchObject({ type: 'call', amountTo: null, amountAdded: null });
        expect(deriveDetailedState(hand).playerBySeat.get(1).streetCommitted).toBeNull();
    });

    it('records call or raise all-ins even when starting stacks are unknown', () => {
        let hand = tracked(3, [null, null, null]);
        expect(legalDetailedActions(hand, 0)).toContain('all-in');

        hand = applyDetailedAction(hand, 0, 'raise', { precision: 'unknown' });
        hand = applyDetailedAction(hand, 1, 'all-in', {
            precision: 'unknown',
            allInKind: 'call',
        });
        expect(hand.actions.at(-1)).toMatchObject({
            seat: 1, type: 'call', isAllIn: true, amountTo: null, precision: 'unknown',
        });
        expect(deriveDetailedState(hand).playerBySeat.get(1).allIn).toBe(true);

        hand = applyDetailedAction(hand, 2, 'all-in', {
            precision: 'unknown',
            allInKind: 'raise',
        });
        expect(hand.actions.at(-1)).toMatchObject({ seat: 2, type: 'raise', isAllIn: true, amountTo: null });
    });

    it('accepts an exact all-in total when the starting stack was unknown', () => {
        const hand = tracked(3, [null, null, null]);
        const allIn = applyDetailedAction(hand, 0, 'all-in', {
            amountTo: 10,
            precision: 'exact',
        });
        expect(allIn.actions.at(-1)).toMatchObject({
            type: 'raise', amountTo: 10, amountAdded: 10, precision: 'exact', isAllIn: true,
        });
    });

    it('rejects ghost, duplicate, and pot-ineligible winner assignments', () => {
        let hand = tracked(3, [100, 50, 20]);
        hand = applyDetailedAction(hand, 0, 'all-in');
        hand = applyDetailedAction(hand, 1, 'all-in');
        hand = applyDetailedAction(hand, 2, 'all-in');

        expect(completeDetailedHand(hand, { winners: [
            { seat: 2, potIndex: 0 }, { seat: 1, potIndex: 1 }, { seat: 0, potIndex: 99 },
        ] })).toBe(hand);
        expect(completeDetailedHand(hand, { winners: [
            { seat: 2, potIndex: null }, { seat: 1, potIndex: null },
        ] })).toBe(hand);
        expect(completeDetailedHand(hand, { winners: [
            { seat: 2, potIndex: 0 }, { seat: 2, potIndex: 0 }, { seat: 1, potIndex: 1 },
        ] })).toBe(hand);

        expect(completeDetailedHand(hand, { winners: [
            { seat: 2, potIndex: 0 }, { seat: 1, potIndex: 1 },
        ] }).detailed.completed).toBe(true);
    });

    it('keeps minimum raise unknown after an unknown wager increment', () => {
        let hand = tracked();
        hand = applyDetailedAction(hand, 0, 'raise', { precision: 'unknown' });
        hand = applyDetailedAction(hand, 1, 'raise', { amountTo: 10, precision: 'exact' });

        const state = deriveDetailedState(hand);
        expect(state.currentBet).toBe(10);
        expect(state.currentBetPrecision).toBe('exact');
        expect(state.lastFullRaiseSizeKnown).toBe(false);
        expect(state.minRaiseTo).toBeNull();
    });

    it('stops appending actions at the persisted ledger cap with an unchanged reference', () => {
        // Legal alternating unknown-amount raises can grow forever; the producer must
        // stop at MAX_DETAILED_ACTIONS so the loader never destroys the hand.
        const unknownRaises = count => Array.from({ length: count }, (_, i) => ({
            seq: i,
            seat: i % 2,
            name: `P${i % 2}`,
            position: null,
            type: 'raise',
            raiseLevel: i + 1,
            street: 'preflop',
            amountTo: null,
            amountAdded: null,
            precision: 'unknown',
            isAllIn: false,
        }));
        const nearCap = { ...tracked(2, [null, null]), actions: unknownRaises(MAX_DETAILED_ACTIONS - 1) };

        const grown = applyDetailedAction(nearCap, 1, 'raise', { precision: 'unknown' });
        expect(grown).not.toBe(nearCap);
        expect(grown.actions).toHaveLength(MAX_DETAILED_ACTIONS);

        // Still seat 0's turn with legal moves, yet every append is refused at the cap.
        expect(legalDetailedActions(grown, 0)).toContain('raise');
        expect(applyDetailedAction(grown, 0, 'raise', { precision: 'unknown' })).toBe(grown);
        expect(applyDetailedAction(grown, 0, 'fold')).toBe(grown);
    });

    it('propagates estimated wager precision into calls while preserving exact stacks', () => {
        let hand = tracked();
        expect(deriveDetailedState(hand).playerBySeat.get(0).stackPrecision).toBe('exact');

        hand = applyDetailedAction(hand, 0, 'raise', { amountTo: 6, precision: 'estimated' });
        let state = deriveDetailedState(hand);
        expect(state.toCall).toBe(5);
        expect(state.toCallQuality).toBe('estimated');

        hand = applyDetailedAction(hand, 1, 'call');
        expect(hand.actions.at(-1).precision).toBe('estimated');
        state = deriveDetailedState(hand);
        expect(state.playerBySeat.get(1).stackPrecision).toBe('estimated');
    });

    it('does not turn an estimated stack cap into an automatic all-in', () => {
        let hand = enableDetailedTracking(makeHand(3), {
            heroSeat: 0,
            startingStacks: { 0: 200, 1: 200, 2: 500 },
            stackPrecisions: { 0: 'exact', 1: 'estimated', 2: 'exact' },
            chipUnit: 1,
        });
        hand = applyDetailedAction(hand, 0, 'all-in');
        hand = applyDetailedAction(hand, 1, 'call');

        expect(hand.actions.at(-1)).toMatchObject({
            seat: 1, type: 'call', amountAdded: 199, isAllIn: false,
        });
        const state = deriveDetailedState(hand);
        expect(state.playerBySeat.get(1)).toMatchObject({
            allIn: false,
            stack: null,
            stackPrecision: 'unknown',
        });
        expect(state.toActSeat).toBe(2);
    });

    it('does not cap forced posts at an estimated starting stack', () => {
        const hand = enableDetailedTracking(makeHand(2), {
            startingStacks: { 0: 1, 1: 1 },
            stackPrecisions: { 0: 'estimated', 1: 'estimated' },
            chipUnit: 1,
        });
        const state = deriveDetailedState(hand);

        expect(state.forcedPosts.map(post => post.amount)).toEqual([1, 2]);
        expect(state.players.every(player => !player.allIn)).toBe(true);
        expect(state.playerBySeat.get(1).stack).toBeNull();
    });
});
