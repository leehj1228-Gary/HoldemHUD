// Optional detailed (chip-aware, multi-street) tracking for the v1 HandRecord.
// Pure module: no React, DOM, storage, clocks, or mutation.

import { firstToActSeat } from './handEngine.js';
import {
    DETAILED_STREETS as STREETS,
    DETAILED_PRECISIONS as PRECISIONS,
    MAX_DETAILED_ACTIONS,
    normalizeCard,
} from './schema.js';

// 정밀도 서열은 schema의 DETAILED_PRECISIONS 선언 순서에서 파생한다 (재선언 금지).
const PRECISION_RANK = Object.fromEntries(PRECISIONS.map((token, rank) => [token, rank]));
const CHIP_ACTIONS = new Set(['call', 'bet', 'raise']);

function finiteAmount(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function greatestCommonDivisor(a, b) {
    let left = Math.abs(a);
    let right = Math.abs(b);
    while (right > 0) {
        const remainder = left % right;
        left = right;
        right = remainder;
    }
    return left;
}

function decimalPlaces(value) {
    const match = String(value).toLowerCase().match(/^(?:\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/);
    if (!match) return 0;
    return Math.max(0, (match[1]?.length || 0) - Number(match[2] || 0));
}

/** Smallest shared blind denomination (for example 0.10/0.25 -> 0.05). */
export function chipUnitForBlinds(blinds) {
    const sb = blinds?.sb;
    const bb = blinds?.bb;
    if (!finiteAmount(sb) || sb <= 0 || !finiteAmount(bb) || bb <= 0) return 1;
    const places = Math.min(8, Math.max(decimalPlaces(sb), decimalPlaces(bb)));
    const scale = 10 ** places;
    const left = Math.round(sb * scale);
    const right = Math.round(bb * scale);
    const divisor = greatestCommonDivisor(left, right);
    return divisor > 0 ? divisor / scale : 1;
}

function normalizePrecision(value, fallback = 'exact') {
    return PRECISIONS.includes(value) ? value : fallback;
}

function worsePrecision(a, b) {
    return PRECISION_RANK[a] >= PRECISION_RANK[b] ? a : b;
}

function normalizeStreet(value) {
    const street = typeof value === 'string' ? value.toLowerCase() : 'preflop';
    return STREETS.includes(street) ? street : 'preflop';
}

function nextStreet(street) {
    const i = STREETS.indexOf(street);
    return i >= 0 && i < STREETS.length - 1 ? STREETS[i + 1] : null;
}

function normalizeCards(values, expectedLength = null) {
    if (!Array.isArray(values)) return null;
    if (expectedLength !== null && values.length !== expectedLength) return null;
    const cards = values.map(normalizeCard);
    return cards.every(Boolean) ? cards : null;
}

function hasDuplicates(values) {
    return new Set(values).size !== values.length;
}

function cloneBoard(board) {
    const src = board && typeof board === 'object' ? board : {};
    return {
        flop: Array.isArray(src.flop) ? [...src.flop] : [],
        turn: Array.isArray(src.turn) ? [...src.turn] : [],
        river: Array.isArray(src.river) ? [...src.river] : [],
    };
}

function boardCards(board) {
    return [...board.flop, ...board.turn, ...board.river];
}

function normalizedStartingStacks(seats, input) {
    const result = {};
    const read = (seat) => {
        if (input instanceof Map) return input.get(seat);
        if (Array.isArray(input)) {
            const objectEntry = input.find(x => x && typeof x === 'object' && x.seat === seat);
            return objectEntry ? (objectEntry.stack ?? objectEntry.startingStack) : input[seat];
        }
        if (input && typeof input === 'object') return input[seat] ?? input[String(seat)];
        return undefined;
    };
    for (const s of seats) {
        const value = read(s.seat);
        result[s.seat] = finiteAmount(value) ? value : null;
    }
    return result;
}

function normalizedStartingStackPrecisions(seats, stacks, input) {
    const result = {};
    const read = (seat) => {
        if (input instanceof Map) return input.get(seat);
        if (input && typeof input === 'object') return input[seat] ?? input[String(seat)];
        return undefined;
    };
    for (const seat of seats) {
        result[seat.seat] = finiteAmount(stacks[seat.seat])
            ? normalizePrecision(read(seat.seat), 'exact')
            : 'unknown';
    }
    return result;
}

function activeSeatNumbers(hand) {
    return hand.seats
        .filter(s => s && !s.sittingOut && typeof s.seat === 'number')
        .map(s => s.seat)
        .sort((a, b) => a - b);
}

function dealerIndex(order, dealerSeat) {
    const exact = order.indexOf(dealerSeat);
    if (exact !== -1) return exact;
    const after = order.findIndex(seat => seat > dealerSeat);
    return after === -1 ? 0 : after;
}

function rotateFrom(order, startSeat) {
    if (order.length === 0) return [];
    let index = order.indexOf(startSeat);
    if (index === -1) {
        index = order.findIndex(seat => seat > startSeat);
        if (index === -1) index = 0;
    }
    return [...order.slice(index), ...order.slice(0, index)];
}

function rotateAfter(order, seat) {
    if (order.length === 0) return [];
    const index = order.indexOf(seat);
    if (index === -1) {
        const after = order.findIndex(x => x > seat);
        return after === -1 ? [...order] : [...order.slice(after), ...order.slice(0, after)];
    }
    const next = (index + 1) % order.length;
    return [...order.slice(next), ...order.slice(0, next)];
}

function metadataOf(hand) {
    const existing = hand && hand.detailed && hand.detailed.enabled ? hand.detailed : null;
    if (existing) {
        return {
            ...existing,
            street: normalizeStreet(existing.street),
            board: cloneBoard(existing.board),
            startingStacks: existing.startingStacks || {},
            startingStackPrecisions: existing.startingStackPrecisions || {},
            heroCards: Array.isArray(existing.heroCards) ? [...existing.heroCards] : [],
            reveals: Array.isArray(existing.reveals) ? existing.reveals.map(r => ({ ...r, cards: [...r.cards] })) : [],
            winners: Array.isArray(existing.winners) ? existing.winners.map(w => ({ ...w })) : [],
        };
    }
    const latestStreet = Array.isArray(hand?.actions) && hand.actions.length
        ? normalizeStreet(hand.actions[hand.actions.length - 1].street)
        : 'preflop';
    return {
        enabled: false,
        heroSeat: null,
        chipUnit: 1,
        startingStacks: {},
        startingStackPrecisions: {},
        street: latestStreet,
        board: { flop: [], turn: [], river: [] },
        heroCards: [],
        reveals: [],
        completed: false,
        winners: [],
    };
}

/** Enable v2-style tracking without changing the outer v1 HandRecord contract. */
export function enableDetailedTracking(hand, options = {}) {
    if (!hand || !Array.isArray(hand.seats) || !Array.isArray(hand.actions)) return hand;
    if (hand.detailed && hand.detailed.enabled) return hand;

    const seats = hand.seats;
    const stacks = normalizedStartingStacks(seats, options.startingStacks);
    const stackPrecisions = normalizedStartingStackPrecisions(seats, stacks, options.stackPrecisions);
    const chipUnit = finiteAmount(options.chipUnit) && options.chipUnit > 0
        ? options.chipUnit
        : chipUnitForBlinds(hand.blinds);
    const heroSeat = typeof options.heroSeat === 'number'
        && seats.some(s => s.seat === options.heroSeat && !s.sittingOut)
        ? options.heroSeat
        : null;
    const actions = hand.actions.map((action, index) => {
        const hasAmounts = finiteAmount(action.amountTo) && finiteAmount(action.amountAdded);
        return {
            ...action,
            seq: Number.isInteger(action.seq) ? action.seq : index,
            street: normalizeStreet(action.street),
            raiseLevel: Number.isFinite(action.raiseLevel) ? action.raiseLevel : 0,
            amountTo: finiteAmount(action.amountTo) ? action.amountTo : null,
            amountAdded: finiteAmount(action.amountAdded) ? action.amountAdded : null,
            precision: normalizePrecision(action.precision, hasAmounts ? 'exact' : 'unknown'),
            isAllIn: !!action.isAllIn,
        };
    });

    return {
        ...hand,
        actions,
        detailed: {
            enabled: true,
            heroSeat,
            chipUnit,
            startingStacks: stacks,
            startingStackPrecisions: stackPrecisions,
            street: actions.length ? normalizeStreet(actions[actions.length - 1].street) : 'preflop',
            board: { flop: [], turn: [], river: [] },
            heroCards: [],
            reveals: [],
            completed: false,
            winners: [],
        },
    };
}

function newPlayers(hand, meta) {
    return hand.seats.map(s => {
        const startingStack = finiteAmount(meta.startingStacks[s.seat]) ? meta.startingStacks[s.seat] : null;
        const startingStackPrecision = normalizePrecision(
            meta.startingStackPrecisions?.[s.seat],
            startingStack === null ? 'unknown' : 'exact',
        );
        return {
            seat: s.seat,
            name: s.name,
            position: s.position ?? null,
            active: !s.sittingOut,
            sittingOut: !!s.sittingOut,
            folded: false,
            allIn: startingStack === 0 && startingStackPrecision === 'exact',
            startingStack,
            startingStackPrecision,
            stack: startingStack,
            stackPrecision: startingStackPrecision,
            streetCommitted: 0,
            streetCommittedPrecision: 'exact',
            totalCommitted: 0,
            totalCommittedPrecision: 'exact',
        };
    });
}

function playerMap(players) {
    return new Map(players.map(p => [p.seat, p]));
}

function putKnownChips(player, added, amountTo = null, precision = 'exact') {
    const normalizedPrecision = normalizePrecision(precision, 'unknown');
    if (!finiteAmount(added)) {
        player.streetCommitted = null;
        player.streetCommittedPrecision = 'unknown';
        player.totalCommitted = null;
        player.totalCommittedPrecision = 'unknown';
        player.stack = null;
        player.stackPrecision = 'unknown';
        return;
    }
    if (finiteAmount(player.streetCommitted)) {
        player.streetCommitted = finiteAmount(amountTo) ? amountTo : player.streetCommitted + added;
    } else if (finiteAmount(amountTo)) {
        player.streetCommitted = amountTo;
    }
    player.streetCommittedPrecision = worsePrecision(player.streetCommittedPrecision, normalizedPrecision);
    if (finiteAmount(player.totalCommitted)) player.totalCommitted += added;
    player.totalCommittedPrecision = worsePrecision(player.totalCommittedPrecision, normalizedPrecision);
    if (finiteAmount(player.stack)) {
        const remaining = player.stack - added;
        player.stackPrecision = worsePrecision(player.stackPrecision, normalizedPrecision);
        if (remaining > 0) {
            player.stack = remaining;
        } else if (remaining === 0 && player.stackPrecision === 'exact') {
            player.stack = 0;
            player.allIn = true;
        } else {
            // An estimated stack is a coaching hint, not a hard betting cap.
            // Once actions reach/cross that estimate, chips behind become unknown
            // unless the action itself explicitly says all-in.
            player.stack = null;
            player.stackPrecision = 'unknown';
        }
    }
}

function forcedPosts(hand, players) {
    const order = activeSeatNumbers(hand);
    const map = playerMap(players);
    const posts = [];
    const blinds = hand.blinds && typeof hand.blinds === 'object' ? hand.blinds : {};
    const sb = finiteAmount(blinds.sb) ? blinds.sb : null;
    const bb = finiteAmount(blinds.bb) ? blinds.bb : null;
    let quality = sb === null || bb === null ? 'unknown' : 'exact';
    let currentBet = bb;
    let lastFullRaiseSize = bb;

    if (order.length >= 2) {
        const d = dealerIndex(order, hand.dealerSeat);
        const sbSeat = order.length === 2 ? order[d] : order[(d + 1) % order.length];
        const bbSeat = order.length === 2 ? order[(d + 1) % order.length] : order[(d + 2) % order.length];
        const addPost = (seat, nominal, type) => {
            const p = map.get(seat);
            if (!p) return;
            const hasExactStackCap = finiteAmount(p.stack) && p.stackPrecision === 'exact';
            const actual = nominal === null ? null : (hasExactStackCap ? Math.min(p.stack, nominal) : nominal);
            putKnownChips(p, actual, actual, nominal === null ? 'unknown' : 'exact');
            posts.push({ seat, type, amount: actual, nominalAmount: nominal });
        };
        addPost(sbSeat, sb, 'smallBlind');
        addPost(bbSeat, bb, 'bigBlind');

        let liveAmount = bb;
        const bbIndex = order.indexOf(bbSeat);
        const count = Math.max(0, Number.parseInt(hand.straddleCount, 10) || 0);
        for (let i = 1; i <= count; i++) {
            liveAmount = liveAmount === null ? null : liveAmount * 2;
            const seat = order[(bbIndex + i) % order.length];
            addPost(seat, liveAmount, 'straddle');
            currentBet = liveAmount;
            lastFullRaiseSize = liveAmount;
        }
    }

    return { posts, quality, currentBet, lastFullRaiseSize };
}

function livePlayers(players) {
    return players.filter(p => p.active && !p.folded);
}

function actionablePlayers(players) {
    return players.filter(p => p.active && !p.folded && !p.allIn);
}

function orderedActionableAfter(hand, players, seat) {
    const allowed = new Set(actionablePlayers(players).map(p => p.seat));
    return rotateAfter(activeSeatNumbers(hand), seat).filter(x => x !== seat && allowed.has(x));
}

function initialPending(hand, players, street, currentBet) {
    const allowed = new Set(actionablePlayers(players).map(p => p.seat));
    if (allowed.size === 0 || livePlayers(players).length <= 1) return [];
    if (allowed.size === 1) {
        if (street !== 'preflop') return [];
        const sole = actionablePlayers(players)[0];
        // A lone chips-behind player only acts when a forced post still has to be
        // matched. If already matched, nobody can respond to further betting.
        if (finiteAmount(currentBet) && finiteAmount(sole.streetCommitted)
            && sole.streetCommitted >= currentBet) return [];
    }
    const order = activeSeatNumbers(hand);
    if (street === 'preflop') {
        const first = firstToActSeat(hand.seats, hand.dealerSeat, hand.straddleCount || 0);
        return rotateFrom(order, first).filter(seat => allowed.has(seat));
    }
    return rotateAfter(order, hand.dealerSeat).filter(seat => allowed.has(seat));
}

function actionAmount(action, player) {
    if (!CHIP_ACTIONS.has(action.type)) {
        return {
            added: 0,
            to: finiteAmount(player.streetCommitted) ? player.streetCommitted : null,
        };
    }
    let added = finiteAmount(action.amountAdded) ? action.amountAdded : null;
    let to = finiteAmount(action.amountTo) ? action.amountTo : null;
    if (added === null && to !== null && finiteAmount(player.streetCommitted)) {
        added = Math.max(0, to - player.streetCommitted);
    }
    if (to === null && added !== null && finiteAmount(player.streetCommitted)) {
        to = player.streetCommitted + added;
    }
    return { added, to };
}

function streetReplay(hand, players, street, forced, actions, incomingQuality) {
    if (street !== 'preflop') {
        for (const p of players) {
            p.streetCommitted = 0;
            p.streetCommittedPrecision = 'exact';
        }
    }

    let quality = incomingQuality;
    let currentBet = street === 'preflop' ? forced.currentBet : 0;
    let currentBetPrecision = street === 'preflop' ? forced.quality : 'exact';
    let lastFullRaiseSize = street === 'preflop'
        ? forced.lastFullRaiseSize
        : (finiteAmount(hand.blinds?.bb) ? hand.blinds.bb : 0);
    let lastFullRaiseSizeKnown = finiteAmount(lastFullRaiseSize);
    let pending = initialPending(hand, players, street, currentBet);
    let raiseCount = 0;
    const lastActedAgainstBet = new Map();
    const validationErrors = [];

    for (const action of actions) {
        const map = playerMap(players);
        const player = map.get(action.seat);
        if (!player || !player.active) {
            quality = 'unknown';
            validationErrors.push(`invalid actor seat ${action.seat}`);
            continue;
        }
        // 레거시/외부 원장 관용: 이미 폴드했거나 올인한 좌석의 액션은 리플레이는 하되
        // validationErrors로 표면화한다 (거부 아님 — 소비자가 품질 저하로 반영).
        if (player.folded) {
            validationErrors.push(`action from folded seat ${action.seat}`);
        } else if (player.allIn) {
            validationErrors.push(`action from all-in seat ${action.seat}`);
        }

        const precision = normalizePrecision(action.precision, 'unknown');
        quality = worsePrecision(quality, precision);
        const beforeBet = currentBet;
        const { added, to } = actionAmount(action, player);
        if (CHIP_ACTIONS.has(action.type)) putKnownChips(player, added, to, precision);

        if (action.type === 'fold') player.folded = true;
        if (action.isAllIn) {
            player.allIn = true;
            player.stack = 0;
            player.stackPrecision = 'exact';
        }

        const aggression = action.type === 'bet' || action.type === 'raise';
        let fullRaise = false;
        if (aggression) {
            if (action.type === 'raise') raiseCount += 1;
            if (to === null || beforeBet === null) {
                currentBet = to;
                currentBetPrecision = to === null ? 'unknown' : precision;
                lastFullRaiseSizeKnown = false;
                fullRaise = true; // unknown legacy raise still resets action order
            } else {
                const increment = to - beforeBet;
                const minimum = beforeBet === 0
                    ? (finiteAmount(hand.blinds?.bb) ? hand.blinds.bb : 0)
                    : lastFullRaiseSize;
                fullRaise = increment >= minimum;
                currentBet = Math.max(beforeBet, to);
                currentBetPrecision = precision;
                if (fullRaise) {
                    lastFullRaiseSize = increment;
                    lastFullRaiseSizeKnown = lastFullRaiseSizeKnown
                        && currentBetPrecision !== 'unknown';
                }
            }
        } else if (action.type === 'call' && currentBet === null && to !== null) {
            currentBet = to; // a known call can anchor an earlier unknown bet level
            currentBetPrecision = precision;
            lastFullRaiseSizeKnown = false;
        }

        if (aggression && fullRaise) {
            pending = orderedActionableAfter(hand, players, action.seat);
        } else if (aggression) {
            const wanted = new Set(pending.filter(seat => seat !== action.seat));
            for (const p of actionablePlayers(players)) {
                if (p.seat === action.seat) continue;
                if (currentBet === null || !finiteAmount(p.streetCommitted) || p.streetCommitted < currentBet) {
                    wanted.add(p.seat);
                }
            }
            pending = orderedActionableAfter(hand, players, action.seat).filter(seat => wanted.has(seat));
        } else {
            pending = pending.filter(seat => seat !== action.seat);
        }

        pending = pending.filter(seat => {
            const p = playerMap(players).get(seat);
            return p && p.active && !p.folded && !p.allIn;
        });
        lastActedAgainstBet.set(action.seat, currentBet);
        if (livePlayers(players).length <= 1) pending = [];
    }

    const raiseRights = {};
    for (const p of actionablePlayers(players)) {
        const faced = lastActedAgainstBet.get(p.seat);
        if (faced === undefined || currentBet === 0) {
            raiseRights[p.seat] = true;
        } else if (finiteAmount(currentBet) && finiteAmount(faced)
            && finiteAmount(lastFullRaiseSize) && lastFullRaiseSizeKnown) {
            raiseRights[p.seat] = currentBet - faced >= lastFullRaiseSize;
        } else {
            // Unknown wager history must not invent a definite reopen decision. The
            // recorder stays permissive while the uncertainty is carried to review.
            raiseRights[p.seat] = null;
        }
    }

    return {
        quality,
        currentBet,
        currentBetPrecision,
        lastFullRaiseSize,
        lastFullRaiseSizeKnown,
        pending,
        raiseCount,
        raiseRights,
        validationErrors,
    };
}

/** Replay the detailed ledger into the current betting state. */
export function deriveDetailedState(hand) {
    if (!hand || !Array.isArray(hand.seats) || !Array.isArray(hand.actions)) {
        return {
            enabled: false, quality: 'unknown', potQuality: 'unknown', stackQuality: 'unknown',
            street: 'preflop', players: [], playerBySeat: new Map(), pot: null,
            currentBet: null, toActSeat: null, pendingResponseSeats: [], streetClosed: true,
            handOver: true, isComplete: false,
        };
    }

    const meta = metadataOf(hand);
    const players = newPlayers(hand, meta);
    const forced = forcedPosts(hand, players);
    let quality = forced.quality;
    let currentResult = null;
    const currentIndex = STREETS.indexOf(meta.street);
    const allErrors = [];

    for (let i = 0; i <= currentIndex; i++) {
        const street = STREETS[i];
        const actions = hand.actions.filter(a => normalizeStreet(a.street) === street);
        currentResult = streetReplay(hand, players, street, forced, actions, quality);
        quality = currentResult.quality;
        allErrors.push(...currentResult.validationErrors);
        if (i < currentIndex && currentResult.pending.length > 0) {
            quality = 'unknown';
            allErrors.push(`${street} advanced before betting closed`);
        }
    }

    const map = playerMap(players);
    const totalsKnown = players.filter(p => p.active).every(p => finiteAmount(p.totalCommitted));
    const pot = totalsKnown
        ? players.filter(p => p.active).reduce((sum, p) => sum + p.totalCommitted, 0)
        : null;
    const stacksKnown = players.filter(p => p.active).every(p => finiteAmount(p.startingStack) && finiteAmount(p.stack));
    // 리플레이가 구조적 모순(validationErrors)을 발견한 원장은 정밀도와 무관하게
    // 'exact'를 보고할 수 없다 — worst-of로 최소 'estimated'까지 강등한다.
    const replayFloor = allErrors.length > 0 ? 'estimated' : 'exact';
    const actionQuality = hand.actions.reduce(
        (q, a) => worsePrecision(q, normalizePrecision(a.precision, 'unknown')),
        worsePrecision(forced.quality, replayFloor));
    const potQuality = totalsKnown ? actionQuality : 'unknown';
    const startingStackQuality = players
        .filter(p => p.active)
        .reduce((q, p) => worsePrecision(q, p.startingStackPrecision), 'exact');
    const stackQuality = stacksKnown ? worsePrecision(actionQuality, startingStackQuality) : 'unknown';
    quality = worsePrecision(potQuality, stackQuality);
    const remaining = livePlayers(players);
    const pending = currentResult ? currentResult.pending : [];
    const streetClosed = pending.length === 0 || remaining.length <= 1;
    const handOver = remaining.length <= 1 || (meta.street === 'river' && streetClosed);
    const currentBet = currentResult ? currentResult.currentBet : null;
    const toActSeat = meta.completed || streetClosed ? null : pending[0] ?? null;
    const toActPlayer = toActSeat === null ? null : map.get(toActSeat);
    const toCall = toActPlayer && finiteAmount(currentBet) && finiteAmount(toActPlayer.streetCommitted)
        ? Math.max(0, currentBet - toActPlayer.streetCommitted)
        : null;
    const toCallQuality = toCall === null
        ? 'unknown'
        : worsePrecision(
            currentResult?.currentBetPrecision || 'unknown',
            toActPlayer?.streetCommittedPrecision || 'unknown',
        );
    const minBet = finiteAmount(hand.blinds?.bb) ? hand.blinds.bb : null;
    // NLHE minimum raise: currentBet plus the last full raise size, never less than
    // currentBet plus a full minimum bet. After a sub-minimum all-in wager
    // (currentBet < minBet) the legal minimum is therefore "all-in + full min bet"
    // (Robert's Rules/TDA), matching the replay's own full-raise classification.
    const minRaiseTo = currentBet === 0
        ? minBet
        : (finiteAmount(currentBet) && finiteAmount(currentResult?.lastFullRaiseSize)
            && currentResult?.lastFullRaiseSizeKnown
            ? currentBet + (finiteAmount(minBet)
                ? Math.max(currentResult.lastFullRaiseSize, minBet)
                : currentResult.lastFullRaiseSize)
            : null);

    return {
        enabled: meta.enabled,
        quality,
        potQuality,
        stackQuality,
        street: meta.street,
        board: cloneBoard(meta.board),
        heroSeat: meta.heroSeat,
        heroCards: [...meta.heroCards],
        reveals: meta.reveals.map(r => ({ ...r, cards: [...r.cards] })),
        players,
        playerBySeat: map,
        forcedPosts: forced.posts,
        pot,
        currentBet,
        currentBetPrecision: currentResult?.currentBetPrecision || 'unknown',
        lastFullRaiseSize: currentResult?.lastFullRaiseSize ?? null,
        lastFullRaiseSizeKnown: !!currentResult?.lastFullRaiseSizeKnown,
        minRaiseTo,
        toCall,
        toCallQuality,
        pendingResponseSeats: [...pending],
        toActSeat,
        raiseRights: { ...(currentResult?.raiseRights || {}) },
        raiseCount: currentResult?.raiseCount || 0,
        streetClosed,
        handOver,
        allRemainingAllIn: remaining.length > 1 && remaining.every(p => p.allIn),
        isComplete: !!meta.completed,
        winners: meta.winners.map(w => ({ ...w })),
        validationErrors: allErrors,
    };
}

/** Legal UI commands for the current actor. `all-in` is stored as call/bet/raise + isAllIn. */
export function legalDetailedActions(hand, seat) {
    const state = deriveDetailedState(hand);
    if (!state.enabled || state.isComplete || state.streetClosed || state.toActSeat !== seat) return [];
    const player = state.playerBySeat.get(seat);
    if (!player || player.folded || player.allIn) return [];
    const hasResponsiveOpponent = state.players.some(candidate => candidate.seat !== seat
        && candidate.active && !candidate.folded && !candidate.allIn);

    const actions = [];
    if (state.toCall === 0) {
        actions.push('check');
        if (hasResponsiveOpponent && state.currentBet === 0) actions.push('bet');
        else if (hasResponsiveOpponent && state.raiseRights[seat] !== false) actions.push('raise');
    } else {
        actions.push('fold', 'call');
        // 스택이 현재 벳을 넘어설 수 없는 좌석(가능한 최대가 콜 이하 = 콜 올인 전용)에는
        // raise를 광고하지 않는다 — applyDetailedAction이 전부 거부하는 죽은 어휘이기
        // 때문(PokerKit 차등 리플레이 F12에서 발견된 광고/적용 불일치). 미지 수치는
        // 기록기 관용 원칙대로 허용 측에 남긴다.
        const canExceedBet = !finiteAmount(player.stack) || !finiteAmount(player.streetCommitted)
            || !finiteAmount(state.currentBet)
            || player.streetCommitted + player.stack > state.currentBet;
        if (hasResponsiveOpponent && state.raiseRights[seat] !== false && canExceedBet) actions.push('raise');
    }
    if (!finiteAmount(player.stack) || player.stack > 0) {
        const allInWouldRaise = state.currentBet !== 0
            && (state.toCall === null || player.stack > state.toCall);
        if ((!allInWouldRaise || hasResponsiveOpponent)
            && (!allInWouldRaise || state.raiseRights[seat] !== false)) actions.push('all-in');
    }
    return actions;
}

function alignedToChipUnit(value, unit) {
    if (!finiteAmount(value)) return false;
    const quotient = value / unit;
    return Math.abs(quotient - Math.round(quotient)) < 1e-9;
}

function appendAction(hand, state, seat, type, amountTo, amountAdded, precision, isAllIn) {
    const seatRec = hand.seats.find(s => s.seat === seat);
    const raiseLevel = type === 'raise' ? state.raiseCount + 1 : 0;
    const action = {
        seq: hand.actions.length,
        seat,
        name: seatRec.name,
        position: seatRec.position ?? null,
        type,
        raiseLevel,
        street: state.street,
        amountTo: finiteAmount(amountTo) ? amountTo : null,
        amountAdded: finiteAmount(amountAdded) ? amountAdded : null,
        precision,
        isAllIn: !!isAllIn,
    };
    return { ...hand, actions: [...hand.actions, action] };
}

/** Apply a detailed action immutably; illegal input returns the original object. */
export function applyDetailedAction(hand, seat, type, options = {}) {
    const state = deriveDetailedState(hand);
    const legal = legalDetailedActions(hand, seat);
    if (!legal.includes(type)) return hand;
    // Producer-side mirror of the persisted-record cap: a ledger the loader would
    // destroy must never be produced in the first place (standard illegal no-op).
    if (hand.actions.length >= MAX_DETAILED_ACTIONS) return hand;
    const player = state.playerBySeat.get(seat);
    // 어휘 밖 정밀도 토큰은 'exact'로 승격하지 않고 불법 no-op으로 거부한다 —
    // 누락된 번역 계층이 추정 금액을 확신 금액으로 둔갑시키는 방향의 버그 차단.
    if (options.precision !== undefined && !PRECISIONS.includes(options.precision)) return hand;
    let precision = options.precision === undefined ? 'exact' : options.precision;
    if (type === 'call') precision = worsePrecision(precision, state.toCallQuality || 'unknown');
    if (type === 'all-in' && (options.amountSource === 'stack' || !finiteAmount(options.amountTo))) {
        precision = worsePrecision(precision, player?.stackPrecision || 'unknown');
    }
    const unit = hand.detailed.chipUnit;
    let resolvedType = type;
    let amountTo = null;
    let amountAdded = null;
    let isAllIn = !!options.isAllIn;

    if (type === 'fold' || type === 'check') {
        amountAdded = 0;
        amountTo = finiteAmount(player.streetCommitted) ? player.streetCommitted : null;
    } else if (type === 'call') {
        if (state.toCall !== null && finiteAmount(player.streetCommitted)) {
            const hasExactStackCap = finiteAmount(player.stack) && player.stackPrecision === 'exact';
            amountAdded = hasExactStackCap ? Math.min(state.toCall, player.stack) : state.toCall;
            amountTo = player.streetCommitted + amountAdded;
            if (hasExactStackCap && amountAdded === player.stack) isAllIn = true;
        } else if (finiteAmount(options.amountTo) && finiteAmount(player.streetCommitted)) {
            amountTo = options.amountTo;
            amountAdded = amountTo - player.streetCommitted;
        } else if (precision !== 'unknown') {
            return hand;
        }
    } else if (type === 'bet' || type === 'raise') {
        if (finiteAmount(options.amountTo) && finiteAmount(player.streetCommitted)) {
            amountTo = options.amountTo;
            amountAdded = amountTo - player.streetCommitted;
        } else if (precision !== 'unknown') {
            return hand;
        }
    } else if (type === 'all-in') {
        isAllIn = true;
        if (finiteAmount(player.stack) && finiteAmount(player.streetCommitted)) {
            amountAdded = player.stack;
            amountTo = player.streetCommitted + player.stack;
            if (state.currentBet === 0) resolvedType = 'bet';
            else if (finiteAmount(state.currentBet) && amountTo <= state.currentBet) resolvedType = 'call';
            else resolvedType = 'raise';
        } else if (finiteAmount(options.amountTo) && finiteAmount(player.streetCommitted)) {
            amountTo = options.amountTo;
            amountAdded = amountTo - player.streetCommitted;
            if (state.currentBet === 0) resolvedType = 'bet';
            else if (finiteAmount(state.currentBet) && amountTo <= state.currentBet) resolvedType = 'call';
            else resolvedType = 'raise';
        } else if (precision === 'unknown') {
            if (state.currentBet === 0) resolvedType = 'bet';
            else if (options.allInKind === 'call' || options.allInKind === 'raise') {
                resolvedType = options.allInKind;
            } else {
                return hand;
            }
        } else {
            return hand;
        }
    }

    if ((resolvedType === 'bet' || resolvedType === 'raise') && !isAllIn
        && finiteAmount(amountTo) && !alignedToChipUnit(amountTo, unit)) return hand;
    if (amountTo !== null && !finiteAmount(amountTo)) return hand;
    if (amountAdded !== null && !finiteAmount(amountAdded)) return hand;
    if (player.stackPrecision === 'exact'
        && finiteAmount(player.stack) && finiteAmount(amountAdded) && amountAdded > player.stack) return hand;
    if (isAllIn && player.stackPrecision === 'exact'
        && finiteAmount(player.stack) && finiteAmount(amountAdded) && amountAdded !== player.stack) return hand;

    if (resolvedType === 'bet' && state.currentBet !== 0) return hand;
    const hasResponsiveOpponent = state.players.some(candidate => candidate.seat !== seat
        && candidate.active && !candidate.folded && !candidate.allIn);
    if ((resolvedType === 'bet' || resolvedType === 'raise') && !hasResponsiveOpponent) return hand;
    if (resolvedType === 'raise') {
        if (state.raiseRights[seat] === false) return hand;
        if (state.currentBet === 0) return hand;
        if (finiteAmount(state.currentBet) && finiteAmount(amountTo) && amountTo <= state.currentBet) return hand;
        if (finiteAmount(state.minRaiseTo) && finiteAmount(amountTo) && amountTo < state.minRaiseTo && !isAllIn) return hand;
    }
    if (resolvedType === 'bet' && finiteAmount(state.minRaiseTo) && finiteAmount(amountTo)
        && amountTo < state.minRaiseTo && !isAllIn) return hand;

    return appendAction(hand, state, seat, resolvedType, amountTo, amountAdded, precision, isAllIn);
}

// ---------------------------------------------------------------------------
// 배치 스텝 (빠른 기록용) — 개별 액션과 동일한 합법성 게이트를 통과하는 순수 루프.
// 하나라도 불법이면 전체를 no-op(동일 참조 반환)으로 거부한다: 반쯤 적용된 배치는
// 어떤 단일 액션보다 위험하다.
// ---------------------------------------------------------------------------

/** 현재 스트리트의 남은 액션 대기 좌석을 전부 폴드시킨다 (전원 fold 합법일 때만). */
export function foldOutPendingSeats(hand) {
    let current = hand;
    for (let guard = 0; guard < MAX_DETAILED_ACTIONS; guard += 1) {
        const state = deriveDetailedState(current);
        if (!state.enabled || state.isComplete) return hand;
        if (state.toActSeat === null) break;
        if (!legalDetailedActions(current, state.toActSeat).includes('fold')) return hand;
        const next = applyDetailedAction(current, state.toActSeat, 'fold');
        if (next === current) return hand;
        current = next;
    }
    return current;
}

/** 현재 스트리트의 남은 액션 대기 좌석을 전부 체크시킨다 (전원 check 합법일 때만). */
export function checkDownStreet(hand) {
    let current = hand;
    for (let guard = 0; guard < MAX_DETAILED_ACTIONS; guard += 1) {
        const state = deriveDetailedState(current);
        if (!state.enabled || state.isComplete) return hand;
        if (state.toActSeat === null) break;
        if (!legalDetailedActions(current, state.toActSeat).includes('check')) return hand;
        const next = applyDetailedAction(current, state.toActSeat, 'check');
        if (next === current) return hand;
        current = next;
    }
    return current;
}

/**
 * 올인 런아웃: 더 이상 베팅이 없을 때(올인 대치 또는 응수 가능 1명 이하) 남은
 * 보드를 리버까지 한 번에 깐다. boardPatch = { flop?, turn?, river? } — 빠진
 * 스트리트는 모름([])으로 진행. 베팅 주체가 남아 있으면 전체 no-op.
 */
export function dealRunoutBoard(hand, boardPatch = {}) {
    let current = hand;
    for (let guard = 0; guard < STREETS.length; guard += 1) {
        const state = deriveDetailedState(current);
        if (!state.enabled || state.isComplete || state.handOver || !state.streetClosed) break;
        const next = nextStreet(state.street);
        if (!next) break;
        const actionable = state.players.filter(p => p.active && !p.folded && !p.allIn);
        if (!state.allRemainingAllIn && actionable.length > 1) return hand;
        const cards = boardPatch[next];
        const advanced = advanceDetailedStreet(current, Array.isArray(cards) ? cards : []);
        if (advanced === current) return hand;
        current = advanced;
    }
    return current;
}

/** Move to the next street after betting closes; zero cards means an unknown board street. */
export function advanceDetailedStreet(hand, cards = []) {
    const state = deriveDetailedState(hand);
    const next = nextStreet(state.street);
    if (!state.enabled || state.isComplete || !state.streetClosed || state.handOver || !next) return hand;
    const expected = next === 'flop' ? 3 : 1;
    if (!Array.isArray(cards) || (cards.length !== 0 && cards.length !== expected)) return hand;
    const normalized = cards.length === 0 ? [] : normalizeCards(cards, expected);
    if (normalized === null) return hand;

    const meta = metadataOf(hand);
    const board = cloneBoard(meta.board);
    const all = [...boardCards(board), ...meta.heroCards, ...meta.reveals.flatMap(r => r.cards), ...normalized];
    if (hasDuplicates(all)) return hand;
    board[next] = normalized;
    return { ...hand, detailed: { ...hand.detailed, street: next, board } };
}

function normalizeReveals(reveals) {
    if (reveals === undefined) return [];
    const entries = Array.isArray(reveals)
        ? reveals
        : (reveals && typeof reveals === 'object'
            ? Object.entries(reveals).map(([seat, cards]) => ({ seat: Number(seat), cards }))
            : null);
    if (entries === null) return null;
    const result = [];
    const seenSeats = new Set();
    for (const entry of entries) {
        if (!entry || typeof entry.seat !== 'number') return null;
        if (seenSeats.has(entry.seat)) return null;
        const cards = normalizeCards(entry.cards, 2);
        if (!cards) return null;
        seenSeats.add(entry.seat);
        result.push({ seat: entry.seat, cards });
    }
    return result;
}

/** Set known hole/board cards. Duplicate/invalid cards make this a no-op. */
export function setDetailedCards(hand, payload = {}) {
    if (!hand?.detailed?.enabled) return hand;
    const { heroSeat, heroCards, reveals, board: boardPatch, street, cards: streetCards } = payload;
    const seats = new Set(hand.seats.filter(s => !s.sittingOut).map(s => s.seat));
    const meta = metadataOf(hand);
    if (meta.completed) return hand;
    const nextBoard = cloneBoard(meta.board);
    const replaceBoardStreet = (key, values) => {
        const expected = key === 'flop' ? 3 : 1;
        if (!Array.isArray(values) || (values.length !== 0 && values.length !== expected)) return false;
        const normalized = values.length === 0 ? [] : normalizeCards(values, expected);
        if (normalized === null) return false;
        nextBoard[key] = normalized;
        return true;
    };
    if (boardPatch !== undefined) {
        if (!boardPatch || typeof boardPatch !== 'object' || Array.isArray(boardPatch)) return hand;
        for (const key of ['flop', 'turn', 'river']) {
            if (Object.prototype.hasOwnProperty.call(boardPatch, key) && !replaceBoardStreet(key, boardPatch[key])) return hand;
        }
    }
    if (street !== undefined || streetCards !== undefined) {
        const targetStreet = normalizeStreet(street);
        if (targetStreet === 'preflop' || !replaceBoardStreet(targetStreet, streetCards)) return hand;
    }
    const resolvedHeroSeat = heroSeat === undefined ? meta.heroSeat : heroSeat;
    if (resolvedHeroSeat !== null && !seats.has(resolvedHeroSeat)) return hand;
    let sourceHeroCards = heroCards === undefined ? meta.heroCards : heroCards;
    let sourceReveals = reveals === undefined ? meta.reveals : reveals;

    // Cards belong to seats, not to the temporary Hero label. When Hero changes,
    // preserve the old Hero cards as a reveal and promote the new Hero's reveal.
    if (heroSeat !== undefined && heroSeat !== meta.heroSeat && reveals === undefined) {
        const revealList = meta.reveals.map(r => ({ ...r, cards: [...r.cards] }));
        const promoted = revealList.find(r => r.seat === resolvedHeroSeat);
        sourceReveals = revealList.filter(r => r.seat !== resolvedHeroSeat && r.seat !== meta.heroSeat);
        if (meta.heroSeat !== null && meta.heroCards.length === 2) {
            sourceReveals.push({ seat: meta.heroSeat, cards: [...meta.heroCards] });
        }
        if (heroCards === undefined) sourceHeroCards = promoted ? promoted.cards : [];
    }

    const normalizedHero = Array.isArray(sourceHeroCards) && sourceHeroCards.length === 0
        ? []
        : normalizeCards(sourceHeroCards, 2);
    if (normalizedHero === null) return hand;
    const normalizedRevealList = normalizeReveals(sourceReveals);
    if (normalizedRevealList === null
        || normalizedRevealList.some(r => !seats.has(r.seat) || r.seat === resolvedHeroSeat)) return hand;
    const cards = [
        ...boardCards(nextBoard),
        ...normalizedHero,
        ...normalizedRevealList.flatMap(r => r.cards),
    ];
    if (hasDuplicates(cards)) return hand;

    return {
        ...hand,
        detailed: {
            ...hand.detailed,
            board: nextBoard,
            heroSeat: resolvedHeroSeat,
            heroCards: [...normalizedHero],
            reveals: normalizedRevealList.map(r => ({ ...r, cards: [...r.cards] })),
        },
    };
}

/** Undo the most recent detailed step: completion, current-street action, or street advance. */
export function undoDetailedStep(hand) {
    if (!hand?.detailed?.enabled) return hand;
    const meta = metadataOf(hand);
    if (meta.completed) {
        return {
            ...hand,
            status: 'in_progress',
            detailed: { ...hand.detailed, completed: false, winners: [] },
        };
    }

    const street = meta.street;
    const lastAction = hand.actions.at(-1);
    if (lastAction && normalizeStreet(lastAction.street) === street) {
        return { ...hand, actions: hand.actions.slice(0, -1) };
    }

    const streetIndex = STREETS.indexOf(street);
    if (streetIndex <= 0) return hand;
    const board = cloneBoard(meta.board);
    board[street] = [];
    return {
        ...hand,
        detailed: {
            ...hand.detailed,
            street: STREETS[streetIndex - 1],
            board,
        },
    };
}

/** Derive main/side pots from total contributions. */
export function deriveSidePots(hand) {
    const state = deriveDetailedState(hand);
    const contributors = state.players.filter(p => p.active && finiteAmount(p.totalCommitted) && p.totalCommitted > 0);
    if (state.players.some(p => p.active && !finiteAmount(p.totalCommitted))) {
        return { quality: 'unknown', pots: [], uncalledReturns: [], pendingExcess: [], total: null };
    }
    const levels = [...new Set(contributors.map(p => p.totalCommitted))].sort((a, b) => a - b);
    const pots = [];
    const excess = [];
    let previous = 0;
    for (const level of levels) {
        const layerContributors = contributors.filter(p => p.totalCommitted >= level);
        const amount = (level - previous) * layerContributors.length;
        if (amount > 0) {
            if (layerContributors.length === 1) {
                excess.push({ seat: layerContributors[0].seat, amount });
            } else {
                const eligibleSeats = layerContributors.filter(p => !p.folded).map(p => p.seat);
                pots.push({
                    index: pots.length,
                    type: pots.length === 0 ? 'main' : 'side',
                    cap: level,
                    amount,
                    contributorSeats: layerContributors.map(p => p.seat),
                    eligibleSeats,
                });
            }
        }
        previous = level;
    }
    const closed = state.streetClosed || state.isComplete;
    return {
        quality: state.potQuality,
        pots,
        uncalledReturns: closed ? excess : [],
        pendingExcess: closed ? [] : excess,
        total: pots.reduce((sum, pot) => sum + pot.amount, 0),
    };
}

function normalizedWinners(winners) {
    if (!Array.isArray(winners)) return [];
    return winners.map(w => (typeof w === 'number' ? { seat: w, potIndex: null } : {
        seat: w?.seat,
        potIndex: Number.isInteger(w?.potIndex) ? w.potIndex : null,
    }));
}

/** Complete a fold/all-in/river-closed hand and record winners by seat/pot. */
export function completeDetailedHand(hand, { winners } = {}) {
    const state = deriveDetailedState(hand);
    if (!state.enabled || state.isComplete || !state.streetClosed) return hand;
    const remaining = state.players.filter(p => p.active && !p.folded);
    const completable = remaining.length <= 1 || state.street === 'river' || state.allRemainingAllIn;
    if (!completable) return hand;
    const normalized = normalizedWinners(winners);
    if (normalized.length === 0 && remaining.length === 1) normalized.push({ seat: remaining[0].seat, potIndex: null });
    if (normalized.length === 0) return hand;
    if (normalized.some(w => !remaining.some(p => p.seat === w.seat))) return hand;
    const winnerKeys = normalized.map(winner => `${winner.seat}:${winner.potIndex ?? 'all'}`);
    if (new Set(winnerKeys).size !== winnerKeys.length) return hand;

    const side = deriveSidePots(hand);
    const validPotIndexes = new Set(side.pots.map(pot => pot.index));
    if (normalized.some(winner => winner.potIndex !== null && !validPotIndexes.has(winner.potIndex))) return hand;
    for (const pot of side.pots) {
        const candidates = normalized.filter(w => w.potIndex === null || w.potIndex === pot.index);
        if (candidates.length === 0 || candidates.some(w => !pot.eligibleSeats.includes(w.seat))) return hand;
    }
    return {
        ...hand,
        detailed: { ...hand.detailed, completed: true, winners: normalized },
    };
}
