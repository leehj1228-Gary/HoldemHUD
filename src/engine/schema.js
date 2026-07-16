// 데이터 스키마 계약 (docs/REBUILD_DESIGN.md §2)
// 이 모듈은 순수 상수/생성자/검증만 담는다. React·storage import 금지.

export const SCHEMA_VERSION = 1;

export const ACTION_TYPES = ['fold', 'check', 'call', 'raise'];

export const SCREENS = ['home', 'game', 'history', 'profile', 'coach'];

export const POSITION_CATEGORIES = ['EP', 'MP', 'CO', 'BTN', 'SB', 'BB'];

// 포지션 문자열 → 통계 카테고리 (UTG 계열→EP, LJ/HJ/MP→MP)
export function positionCategory(position) {
    if (['UTG', 'UTG+1', 'UTG+2'].includes(position)) return 'EP';
    if (['LJ', 'HJ', 'MP'].includes(position)) return 'MP';
    if (POSITION_CATEGORIES.includes(position)) return position;
    return null;
}

let idCounter = 0;
export function newId(prefix) {
    idCounter += 1;
    return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

// seat: 0-based 고정 좌석 번호. 이름은 trim해서 저장, trim된 이름이 플레이어 식별자.
export function createSeat(seat, name) {
    return {
        seat,
        name: (name || `Seat ${seat + 1}`).trim(),
        sittingOut: false,
    };
}

// positions: Map<seat, position|null> (handEngine.positionsForHand 결과)
export function createHand({ handNo, dealerSeat, straddleCount, blinds, seats, positions, startedAt }) {
    return {
        id: newId('hand'),
        handNo,
        startedAt: startedAt || null,
        endedAt: null,
        dealerSeat,
        straddleCount,
        blinds: blinds || null,
        seats: seats.map(s => ({
            seat: s.seat,
            name: s.name,
            sittingOut: !!s.sittingOut,
            position: s.sittingOut ? null : (positions.get(s.seat) ?? null),
        })),
        actions: [],
    };
}

// raiseLevel은 handEngine.applyAction이 계산해서 넘긴다 (raise가 아니면 0)
export function createAction({ seq, seat, name, position, type, raiseLevel = 0 }) {
    return {
        seq,
        seat,
        name,
        position: position ?? null,
        type,
        raiseLevel: type === 'raise' ? raiseLevel : 0,
        street: 'preflop',
    };
}

export function createSession({ blinds, currency, startedAt }) {
    return {
        id: newId('sess'),
        schemaVersion: SCHEMA_VERSION,
        startedAt: startedAt || null,
        endedAt: null,
        blinds: blinds || null,
        currency: currency || '$',
        totalHands: 0,
        hands: [],
    };
}

export function isValidActionType(type) {
    return ACTION_TYPES.includes(type);
}

// 핸드 레코드 최소 구조 검증 (마이그레이션·로드 시 방어용)
export function isValidHandRecord(hand) {
    return !!hand
        && typeof hand.dealerSeat === 'number'
        && Array.isArray(hand.seats)
        && Array.isArray(hand.actions)
        && hand.seats.every(s => typeof s.seat === 'number' && typeof s.name === 'string');
}

// ---------------------------------------------------------------------------
// Persisted detailed-hand boundary
// ---------------------------------------------------------------------------

const DETAILED_STREETS = ['preflop', 'flop', 'turn', 'river'];
const DETAILED_ACTION_TYPES = ['fold', 'check', 'call', 'bet', 'raise'];
const DETAILED_PRECISIONS = ['exact', 'estimated', 'unknown'];
const CARD_RANKS = new Set('23456789TJQKA'.split(''));
const CARD_SUITS = new Set('cdhs'.split(''));

// These limits are deliberately much larger than a real Hold'em hand while
// still preventing a corrupt persisted payload from causing an unbounded replay.
const MAX_DETAILED_SEATS = 10;
const MAX_DETAILED_ACTIONS = 512;
const MAX_CHIP_AMOUNT = Number.MAX_SAFE_INTEGER / (MAX_DETAILED_ACTIONS + 16);

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeChipAmount(value, { nullable = true, positive = false } = {}) {
    if (value === undefined || value === null) return nullable ? null : undefined;
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
    if (positive ? value <= 0 : value < 0) return undefined;
    return value <= MAX_CHIP_AMOUNT ? value : undefined;
}

function normalizePersistedCard(value) {
    if (typeof value !== 'string') return null;
    const raw = value.trim();
    if (raw.length !== 2) return null;
    const rank = raw[0].toUpperCase();
    const suit = raw[1].toLowerCase();
    return CARD_RANKS.has(rank) && CARD_SUITS.has(suit) ? `${rank}${suit}` : null;
}

function normalizePersistedCards(value, allowedLengths) {
    if (!Array.isArray(value) || !allowedLengths.includes(value.length)) return null;
    // Array.from materializes sparse slots so a hole cannot evade Array#every.
    const cards = Array.from(value, normalizePersistedCard);
    return cards.every(Boolean) ? cards : null;
}

function readSeatValue(source, seat) {
    if (Array.isArray(source)) return source[seat];
    return source[seat] ?? source[String(seat)];
}

function normalizePersistedStacks(seats, source) {
    if (source === undefined || source === null) {
        return Object.fromEntries(seats.map(seat => [seat, null]));
    }
    if (!isRecord(source) && !Array.isArray(source)) return null;
    const result = {};
    for (const seat of seats) {
        const raw = readSeatValue(source, seat);
        const amount = safeChipAmount(raw);
        if (raw !== undefined && amount === undefined) return null;
        result[seat] = amount;
    }
    return result;
}

function normalizePersistedStackPrecisions(seats, stacks, source) {
    if (source !== undefined && source !== null && !isRecord(source) && !Array.isArray(source)) return null;
    const result = {};
    for (const seat of seats) {
        const raw = source === undefined || source === null ? undefined : readSeatValue(source, seat);
        if (raw !== undefined && !DETAILED_PRECISIONS.includes(raw)) return null;
        result[seat] = stacks[seat] === null ? 'unknown' : (raw ?? 'exact');
    }
    return result;
}

function normalizePersistedAction(action, index, activeSeats, seatByNumber) {
    if (!isRecord(action)) return null;
    if (!Number.isInteger(action.seat) || !activeSeats.has(action.seat)) return null;
    if (!DETAILED_ACTION_TYPES.includes(action.type)) return null;
    if (!DETAILED_STREETS.includes(action.street)) return null;

    const amountTo = safeChipAmount(action.amountTo);
    const amountAdded = safeChipAmount(action.amountAdded);
    if ((action.amountTo !== undefined && amountTo === undefined)
        || (action.amountAdded !== undefined && amountAdded === undefined)) return null;

    const precision = action.precision === undefined
        ? (amountTo !== null && amountAdded !== null ? 'exact' : 'unknown')
        : action.precision;
    if (!DETAILED_PRECISIONS.includes(precision)) return null;
    const isChipAction = ['call', 'bet', 'raise'].includes(action.type);
    if (isChipAction && precision !== 'unknown' && (amountTo === null || amountAdded === null)) return null;
    if (amountTo !== null && amountAdded !== null && amountAdded > amountTo) return null;
    if (!isChipAction && amountAdded !== null && amountAdded !== 0) return null;

    const seq = action.seq === undefined ? index : action.seq;
    if (!Number.isInteger(seq) || seq < 0 || seq > MAX_DETAILED_ACTIONS * 2) return null;
    const raiseLevel = action.raiseLevel === undefined ? 0 : action.raiseLevel;
    if (!Number.isInteger(raiseLevel) || raiseLevel < 0 || raiseLevel > MAX_DETAILED_ACTIONS) return null;
    if (action.name !== undefined && typeof action.name !== 'string') return null;
    if (action.position !== undefined && action.position !== null && typeof action.position !== 'string') return null;
    if (action.isAllIn !== undefined && typeof action.isAllIn !== 'boolean') return null;

    const seat = seatByNumber.get(action.seat);
    return {
        seq,
        seat: action.seat,
        name: action.name ?? seat.name,
        position: action.position === undefined ? (seat.position ?? null) : action.position,
        type: action.type,
        raiseLevel,
        street: action.street,
        amountTo,
        amountAdded,
        precision,
        isAllIn: action.isAllIn === true,
    };
}

function normalizePersistedReveals(source, activeSeats) {
    if (source === undefined || source === null) return [];
    const entries = Array.isArray(source)
        ? source
        : (isRecord(source)
            ? Object.entries(source).map(([seat, cards]) => ({ seat: Number(seat), cards }))
            : null);
    if (!entries || entries.length > activeSeats.size) return null;
    const seenSeats = new Set();
    const result = [];
    for (const entry of entries) {
        if (!isRecord(entry) || !Number.isInteger(entry.seat) || !activeSeats.has(entry.seat)
            || seenSeats.has(entry.seat)) return null;
        const cards = normalizePersistedCards(entry.cards, [2]);
        if (!cards) return null;
        seenSeats.add(entry.seat);
        result.push({ seat: entry.seat, cards });
    }
    return result;
}

function normalizePersistedWinners(source, activeSeats) {
    if (source === undefined || source === null) return [];
    if (!Array.isArray(source) || source.length > activeSeats.size * MAX_DETAILED_SEATS) return null;
    const result = [];
    const seen = new Set();
    for (const raw of source) {
        const entry = typeof raw === 'number' ? { seat: raw, potIndex: null } : raw;
        if (!isRecord(entry) || !Number.isInteger(entry.seat) || !activeSeats.has(entry.seat)) return null;
        const potIndex = entry.potIndex === undefined || entry.potIndex === null ? null : entry.potIndex;
        if (potIndex !== null
            && (!Number.isInteger(potIndex) || potIndex < 0 || potIndex >= activeSeats.size)) return null;
        const key = `${entry.seat}:${potIndex ?? 'all'}`;
        if (seen.has(key)) return null;
        seen.add(key);
        result.push({ seat: entry.seat, potIndex });
    }
    return result;
}

function normalizeDetailedHandRecordUnsafe(hand) {
    if (!isRecord(hand) || !isRecord(hand.detailed) || hand.detailed.enabled !== true) return null;
    if (!Array.isArray(hand.seats) || hand.seats.length === 0 || hand.seats.length > MAX_DETAILED_SEATS) return null;
    if (!Array.isArray(hand.actions) || hand.actions.length > MAX_DETAILED_ACTIONS) return null;

    const seatByNumber = new Map();
    const seats = [];
    for (const sourceSeat of hand.seats) {
        if (!isRecord(sourceSeat) || !Number.isInteger(sourceSeat.seat) || sourceSeat.seat < 0
            || sourceSeat.seat >= MAX_DETAILED_SEATS || seatByNumber.has(sourceSeat.seat)
            || typeof sourceSeat.name !== 'string') return null;
        if (sourceSeat.position !== undefined && sourceSeat.position !== null
            && typeof sourceSeat.position !== 'string') return null;
        const seat = {
            ...sourceSeat,
            seat: sourceSeat.seat,
            name: sourceSeat.name,
            sittingOut: sourceSeat.sittingOut === true,
            position: sourceSeat.position ?? null,
        };
        seatByNumber.set(seat.seat, seat);
        seats.push(seat);
    }

    if (!Number.isInteger(hand.dealerSeat) || !seatByNumber.has(hand.dealerSeat)) return null;
    const activeSeats = new Set(seats.filter(seat => !seat.sittingOut).map(seat => seat.seat));
    const straddleCount = hand.straddleCount ?? 0;
    if (!Number.isInteger(straddleCount) || straddleCount < 0
        || straddleCount > Math.max(0, activeSeats.size - 2)) return null;

    const actions = [];
    let latestStreetIndex = 0;
    for (let index = 0; index < hand.actions.length; index += 1) {
        const action = normalizePersistedAction(hand.actions[index], index, activeSeats, seatByNumber);
        if (!action) return null;
        const streetIndex = DETAILED_STREETS.indexOf(action.street);
        if (streetIndex < latestStreetIndex) return null;
        latestStreetIndex = streetIndex;
        actions.push(action);
    }

    const detailed = hand.detailed;
    const street = detailed.street === undefined
        ? DETAILED_STREETS[latestStreetIndex]
        : detailed.street;
    if (!DETAILED_STREETS.includes(street)
        || DETAILED_STREETS.indexOf(street) < latestStreetIndex) return null;

    const chipUnit = safeChipAmount(detailed.chipUnit, { nullable: false, positive: true });
    if (chipUnit === undefined) return null;
    const startingStacks = normalizePersistedStacks([...seatByNumber.keys()], detailed.startingStacks);
    if (!startingStacks) return null;
    const startingStackPrecisions = normalizePersistedStackPrecisions(
        [...seatByNumber.keys()], startingStacks, detailed.startingStackPrecisions);
    if (!startingStackPrecisions) return null;

    const boardSource = detailed.board === undefined || detailed.board === null ? {} : detailed.board;
    if (!isRecord(boardSource)) return null;
    const board = {
        flop: normalizePersistedCards(boardSource.flop ?? [], [0, 3]),
        turn: normalizePersistedCards(boardSource.turn ?? [], [0, 1]),
        river: normalizePersistedCards(boardSource.river ?? [], [0, 1]),
    };
    if (!board.flop || !board.turn || !board.river) return null;

    const heroSeat = detailed.heroSeat === undefined ? null : detailed.heroSeat;
    if (heroSeat !== null && (!Number.isInteger(heroSeat) || !activeSeats.has(heroSeat))) return null;
    const heroCards = normalizePersistedCards(detailed.heroCards ?? [], [0, 2]);
    if (!heroCards) return null;
    const reveals = normalizePersistedReveals(detailed.reveals, activeSeats);
    if (!reveals || (heroSeat !== null && reveals.some(reveal => reveal.seat === heroSeat))) return null;

    const allCards = [
        ...board.flop, ...board.turn, ...board.river,
        ...heroCards,
        ...reveals.flatMap(reveal => reveal.cards),
    ];
    if (new Set(allCards).size !== allCards.length) return null;

    if (detailed.completed !== undefined && typeof detailed.completed !== 'boolean') return null;
    const completed = detailed.completed === true;
    const winners = normalizePersistedWinners(detailed.winners, activeSeats);
    if (!winners || completed !== (winners.length > 0)) return null;
    const foldedSeats = new Set(actions.filter(action => action.type === 'fold').map(action => action.seat));
    if (winners.some(winner => foldedSeats.has(winner.seat))) return null;

    return {
        ...hand,
        dealerSeat: hand.dealerSeat,
        straddleCount,
        seats,
        actions,
        detailed: {
            ...detailed,
            enabled: true,
            heroSeat,
            chipUnit,
            startingStacks,
            startingStackPrecisions,
            street,
            board,
            heroCards,
            reveals,
            completed,
            winners,
        },
    };
}

/**
 * Validate and clone a persisted v2 detailed HandRecord before replay.
 *
 * Optional fields are filled with conservative defaults, but contradictory or
 * malformed ledger/card data rejects the whole record. The function never
 * throws: callers can filter archives with `normalizeDetailedHandRecord(hand)`
 * and keep only non-null results before invoking detailedHandEngine.
 */
export function normalizeDetailedHandRecord(hand) {
    try {
        return normalizeDetailedHandRecordUnsafe(hand);
    } catch {
        return null;
    }
}
