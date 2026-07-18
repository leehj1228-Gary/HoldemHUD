// PokerKit 차등 리플레이 — JS쪽 드라이버 (docs/DIFFERENTIAL_REPLAY.md).
// fixture 원장을 detailedHandEngine "생산 경로"(applyDetailedAction 등)로 재생해
// 결정 시점 트레이스를 만든다. 리플레이 전용 경로가 아니라 생산 경로를 쓰는 이유:
// fixture의 모든 액션이 우리 엔진의 합법성 게이트를 실제로 통과함을 함께 증명하기 위해서다.
import {
    enableDetailedTracking,
    setDetailedCards,
    applyDetailedAction,
    advanceDetailedStreet,
    completeDetailedHand,
    deriveDetailedState,
    deriveSidePots,
    legalDetailedActions,
} from '../../../src/engine/detailedHandEngine.js';
import { normalizeDetailedHandRecord, DETAILED_STREETS } from '../../../src/engine/schema.js';
import { determineShowdownWinners } from '../../../src/engine/handEvaluator.js';

export const TRACE_VERSION = 'pokerkit-diff.v1';

class FixtureError extends Error {
    constructor(fixtureId, step, message) {
        super(`[${fixtureId}] ${step}: ${message}`);
        this.name = 'FixtureError';
    }
}

function fail(fixture, step, message) {
    throw new FixtureError(fixture.id, step, message);
}

function finite(value) {
    return typeof value === 'number' && Number.isFinite(value);
}

function seatKeyed(players, pick) {
    const result = {};
    for (const p of players.filter(x => x.active)) result[p.seat] = pick(p);
    return result;
}

function buildHand(fixture) {
    return {
        id: fixture.id,
        handNo: 1,
        startedAt: null,
        endedAt: null,
        dealerSeat: fixture.dealerSeat,
        straddleCount: fixture.game.straddleCount ?? 0,
        blinds: { sb: fixture.game.sb, bb: fixture.game.bb },
        seats: fixture.seats.map(s => ({
            seat: s.seat,
            name: s.name ?? `P${s.seat}`,
            sittingOut: false,
            position: null,
        })),
        actions: [],
    };
}

function fixtureBoardFor(fixture, street) {
    const cards = fixture.board?.[street] ?? [];
    const expected = street === 'flop' ? 3 : 1;
    if (cards.length !== expected) return null;
    return cards;
}

// 결정 시점 스냅샷 — 양쪽(우리/PokerKit)이 같은 스키마로 방출해 필드 단위 비교한다.
function captureDecision(fixture, state, legal, seq) {
    const actor = state.playerBySeat.get(state.toActSeat);
    if (!actor) fail(fixture, `decision ${seq}`, 'no actor player');
    if (!finite(actor.stack)) fail(fixture, `decision ${seq}`, 'actor stack unknown (fixtures must stay exact)');
    if (!finite(state.pot)) fail(fixture, `decision ${seq}`, 'pot unknown');

    const toCall = state.toCall ?? 0;
    const checkCallAmount = Math.min(toCall, actor.stack);
    const hasWagerVocab = legal.includes('bet') || legal.includes('raise');
    // all-in 어휘가 wager(상대가 응수해야 하는 베팅)로 해석되는 조건: 노벳이면 벳,
    // 벳 직면 상태에서 스택이 콜 금액을 초과하면 레이즈. (콜 올인은 wager가 아니다.)
    const allInWagers = legal.includes('all-in')
        && (state.currentBet === 0 || actor.stack > toCall);
    const canWager = hasWagerVocab || allInWagers;
    const wagerMaxTo = canWager ? actor.streetCommitted + actor.stack : null;
    const wagerMinTo = canWager
        ? Math.min(finite(state.minRaiseTo) ? state.minRaiseTo : wagerMaxTo, wagerMaxTo)
        : null;

    return {
        seq,
        street: state.street,
        actorSeat: state.toActSeat,
        pot: state.pot,
        currentBet: state.currentBet,
        toCall: checkCallAmount,
        canFold: legal.includes('fold'),
        canCheckOrCall: legal.includes('check') || legal.includes('call'),
        canWager,
        wagerMinTo,
        wagerMaxTo,
        stacks: seatKeyed(state.players, p => p.stack),
        streetCommitted: seatKeyed(state.players, p => p.streetCommitted),
    };
}

// 인접한 동일 eligible 팟 레이어를 병합한다. 우리 엔진은 폴드한 좌석의 커밋 경계마다
// 레이어를 쪼개고 PokerKit은 같은 자격 집합을 하나로 합치므로, 비교는 병합 형태로 한다.
export function mergePotLayers(pots) {
    const merged = [];
    for (const pot of pots) {
        const eligible = [...pot.eligibleSeats].sort((a, b) => a - b);
        const previous = merged[merged.length - 1];
        if (previous && previous.eligibleSeats.length === eligible.length
            && previous.eligibleSeats.every((seat, i) => seat === eligible[i])) {
            previous.amount += pot.amount;
        } else {
            merged.push({ amount: pot.amount, eligibleSeats: eligible });
        }
    }
    return merged;
}

function payoutBySeat(fixture, state, side, winners) {
    const result = {};
    for (const p of state.players.filter(x => x.active)) result[p.seat] = 0;
    for (const entry of side.uncalledReturns) result[entry.seat] += entry.amount;
    for (const pot of side.pots) {
        const candidates = winners.filter(w => w.potIndex === null || w.potIndex === pot.index);
        if (candidates.length === 0) fail(fixture, 'final', `pot ${pot.index} has no winner`);
        const share = pot.amount / candidates.length;
        if (!Number.isInteger(share)) {
            fail(fixture, 'final', `pot ${pot.index} split ${pot.amount}/${candidates.length} is fractional — golden fixtures must avoid odd-chip splits`);
        }
        for (const w of candidates) result[w.seat] += share;
    }
    return result;
}

/**
 * fixture를 우리 엔진으로 재생해 { hand, trace }를 돌려준다.
 * 어느 단계든 엔진이 액션을 거부(no-op)하면 FixtureError를 던진다 — 차등 리플레이에서
 * "우리 엔진이 이 원장을 합법으로 보지 않음" 자체가 비교 실패 신호다.
 */
export function driveFixture(fixture) {
    let hand = buildHand(fixture);
    hand = enableDetailedTracking(hand, {
        chipUnit: fixture.game.chipUnit ?? 1,
        startingStacks: Object.fromEntries(fixture.seats.map(s => [s.seat, s.stack])),
        heroSeat: fixture.heroSeat ?? fixture.seats[0].seat,
    });
    if (!hand.detailed?.enabled) fail(fixture, 'setup', 'enableDetailedTracking failed');

    const holeCards = fixture.holeCards ?? {};
    const heroSeat = fixture.heroSeat ?? fixture.seats[0].seat;
    const reveals = Object.entries(holeCards)
        .map(([seat, cards]) => ({ seat: Number(seat), cards }))
        .filter(r => r.seat !== heroSeat);
    const withCards = setDetailedCards(hand, {
        heroSeat,
        heroCards: holeCards[heroSeat] ?? [],
        reveals,
    });
    if (withCards === hand && Object.keys(holeCards).length > 0) {
        fail(fixture, 'setup', 'setDetailedCards rejected fixture hole cards');
    }
    hand = withCards;

    const decisions = [];
    const actions = fixture.actions ?? [];
    for (let i = 0; i < actions.length; i += 1) {
        const action = actions[i];
        let state = deriveDetailedState(hand);
        while (state.street !== action.street) {
            if (!state.streetClosed || state.handOver) {
                fail(fixture, `action ${i}`, `cannot advance from ${state.street} to ${action.street}`);
            }
            const nextIndex = DETAILED_STREETS.indexOf(state.street) + 1;
            const nextStreet = DETAILED_STREETS[nextIndex];
            const cards = fixtureBoardFor(fixture, nextStreet);
            if (!cards) fail(fixture, `action ${i}`, `fixture board missing ${nextStreet} cards`);
            const advanced = advanceDetailedStreet(hand, cards);
            if (advanced === hand) fail(fixture, `action ${i}`, `advanceDetailedStreet to ${nextStreet} rejected`);
            hand = advanced;
            state = deriveDetailedState(hand);
        }
        if (state.toActSeat !== action.seat) {
            fail(fixture, `action ${i}`, `engine expects seat ${state.toActSeat} to act, fixture says seat ${action.seat}`);
        }
        decisions.push(captureDecision(fixture, state, legalDetailedActions(hand, action.seat), i));
        const applied = applyDetailedAction(hand, action.seat, action.type,
            action.amountTo === undefined ? {} : { amountTo: action.amountTo });
        if (applied === hand) {
            fail(fixture, `action ${i}`, `engine rejected ${action.type}${action.amountTo !== undefined ? ` to ${action.amountTo}` : ''} by seat ${action.seat}`);
        }
        hand = applied;
    }

    // 올인 런아웃: 남은 보드를 깔아 리버까지 진행한다.
    let state = deriveDetailedState(hand);
    while (!state.handOver && state.streetClosed && !state.isComplete && state.street !== 'river') {
        const nextStreet = DETAILED_STREETS[DETAILED_STREETS.indexOf(state.street) + 1];
        const cards = fixtureBoardFor(fixture, nextStreet);
        if (!cards) fail(fixture, 'runout', `fixture board missing ${nextStreet} cards`);
        const advanced = advanceDetailedStreet(hand, cards);
        if (advanced === hand) fail(fixture, 'runout', `advanceDetailedStreet to ${nextStreet} rejected`);
        hand = advanced;
        state = deriveDetailedState(hand);
    }
    if (!state.streetClosed) fail(fixture, 'final', 'betting still open after all fixture actions');

    const completed = completeDetailedHand(hand, { winners: fixture.result?.winners });
    if (completed === hand) fail(fixture, 'final', 'completeDetailedHand rejected fixture winners');
    hand = completed;
    if (!normalizeDetailedHandRecord(hand)) {
        fail(fixture, 'final', 'finished hand fails normalizeDetailedHandRecord (would be quarantined on load)');
    }

    state = deriveDetailedState(hand);
    const side = deriveSidePots(hand);
    if (side.pots.some(pot => !finite(pot.amount)) || side.total === null) {
        fail(fixture, 'final', 'side pots not exactly derivable');
    }
    const payouts = payoutBySeat(fixture, state, side, state.winners);
    const uncalledBySeat = {};
    for (const entry of side.uncalledReturns) {
        uncalledBySeat[entry.seat] = (uncalledBySeat[entry.seat] ?? 0) + entry.amount;
    }
    const finalStacks = {};
    // netCommitted = 언콜드 반환을 뺀, 실제로 팟에 남은 커밋 — PokerKit 쪽에서도
    // (시작 스택 − 베팅 종료 시점 스택)으로 동일하게 관측 가능한 값이라 이걸 비교한다.
    const netCommitted = {};
    for (const p of state.players.filter(x => x.active)) {
        if (!finite(p.startingStack) || !finite(p.totalCommitted)) {
            fail(fixture, 'final', `seat ${p.seat} totals unknown`);
        }
        netCommitted[p.seat] = p.totalCommitted - (uncalledBySeat[p.seat] ?? 0);
        finalStacks[p.seat] = p.startingStack - p.totalCommitted + payouts[p.seat];
    }
    const startingSum = state.players.filter(p => p.active)
        .reduce((sum, p) => sum + p.startingStack, 0);
    const finalSum = Object.values(finalStacks).reduce((sum, v) => sum + v, 0);
    if (startingSum !== finalSum) {
        fail(fixture, 'final', `chips not conserved: start ${startingSum}, end ${finalSum}`);
    }

    const live = state.players.filter(p => p.active && !p.folded);
    const wentToShowdown = live.length >= 2;
    // 평가기 교차 검증: fixture가 선언한 승자와 handEvaluator의 자동 판정이 같은 지급을
    // 만들어야 한다. 이 지급은 아래에서 PokerKit의 자체 쇼다운 평가(finalStacks 골든)와
    // 다시 대조되므로, 세 소스(작성자·우리 평가기·PokerKit)가 전부 맞물린다.
    if (wentToShowdown) {
        const auto = determineShowdownWinners(hand);
        if (!auto) fail(fixture, 'final', 'determineShowdownWinners returned null (showdown fixtures must carry full cards)');
        const autoPayouts = payoutBySeat(fixture, state, side, auto.winners);
        for (const seat of Object.keys(payouts)) {
            if (autoPayouts[seat] !== payouts[seat]) {
                fail(fixture, 'final',
                    `evaluator disagrees with declared winners at seat ${seat}: declared payout ${payouts[seat]}, evaluator payout ${autoPayouts[seat]}`);
            }
        }
    }
    const trace = {
        traceVersion: TRACE_VERSION,
        fixtureId: fixture.id,
        decisions,
        final: {
            street: state.street,
            wentToShowdown,
            // 폴드 종료 핸드의 팟/커밋 표현은 엔진마다 다르다(PokerKit은 생존자의 마지막
            // 스트리트 베팅을 팟에 넣지 않고 통째로 환급). 칩 흐름은 finalStacks가 완전히
            // 고정하므로, 팟 구조·netCommitted 비교는 쇼다운 핸드로 한정한다.
            pots: wentToShowdown ? mergePotLayers(side.pots) : null,
            netCommitted: wentToShowdown ? netCommitted : null,
            finalStacks,
        },
    };
    return { hand, trace };
}
