// Pure contract layer for detailed, street-by-street AI hand review.
// No provider calls live here: this module only builds knowledge-cutoff payloads/prompts
// and validates heuristic (no solver/equity) responses.

import { deriveDetailedState, legalDetailedActions } from '../engine/detailedHandEngine.js';
import {
    DETAILED_STREETS as STREETS,
    DETAILED_ACTION_TYPES as RECORDED_ACTIONS,
    DETAILED_PRECISIONS as PRECISIONS,
    normalizeCard as canonicalCard,
} from '../engine/schema.js';

const PAYLOAD_SCHEMA_VERSION = 'detailed-review-payload.v1';
const REVIEW_SCHEMA_VERSION = 'heuristic-decision-review.v1';
const ANALYSIS_MODE = 'heuristic_no_solver';
const CONFIDENCE_CAP = 0.45;

const STREET_BOARD_COUNTS = { preflop: 0, flop: 3, turn: 4, river: 5 };
const STREET_ALLOWED_VISIBLE_COUNTS = {
    preflop: [0],
    flop: [0, 3],
    turn: [0, 1, 3, 4],
    river: [0, 1, 2, 3, 4, 5],
};
const LEGAL_ACTIONS = [...RECORDED_ACTIONS, 'all-in'];
const ASSESSMENTS = ['plausible', 'review_needed', 'not_gradable'];
const HANGUL_PATTERN = /[가-힣]/;
const FORBIDDEN_PROSE_PATTERN = /\b(?:gto|equity|ev|ev\s*loss|expected\s+value|solver)\b|에쿼티|기대값|솔버|지티오|명백한\s*실수|정답|오답|최적(?:이다|입니다|임)?/i;
const STATIC_FACT_REFS = new Set([
    'game.variant', 'game.format', 'game.smallBlind', 'game.bigBlind',
    'game.straddleCount',
    'hero.position', 'hero.holeCards', 'visibleBoard', 'state.legalActions',
    'state.potBefore', 'state.currentBet', 'state.toCall', 'state.minRaiseTo',
    'state.heroStackBefore', 'state.potOddsRequiredPct', 'state.heroSprBefore',
    'actualAction',
]);

function fail(path, message) {
    throw new TypeError(`${path}: ${message}`);
}

function isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function requireObject(value, path) {
    if (!isObject(value)) fail(path, 'object required');
    return value;
}

function assertAllowedKeys(value, allowed, path) {
    for (const key of Object.keys(value)) {
        if (!allowed.includes(key)) fail(`${path}.${key}`, 'field is not allowed');
    }
}

function requireString(value, path, maxLength = 200) {
    if (typeof value !== 'string' || !value.trim()) fail(path, 'non-empty string required');
    const result = value.trim();
    if (result.length > maxLength) fail(path, `must be at most ${maxLength} characters`);
    return result;
}

function nullableString(value, path, maxLength = 200) {
    if (value === null || value === undefined || value === '') return null;
    return requireString(value, path, maxLength);
}

function requireKoreanProse(value, path, maxLength) {
    const result = requireString(value, path, maxLength);
    if (!HANGUL_PATTERN.test(result)) fail(path, 'Korean prose required');
    if (FORBIDDEN_PROSE_PATTERN.test(result) || /\d+(?:\.\d+)?\s*%/.test(result)) {
        fail(path, 'solver/equity/EV/optimal or exact percentage claims are not allowed');
    }
    return result;
}

function nullableKoreanProse(value, path, maxLength) {
    if (value === null || value === undefined || value === '') return null;
    return requireKoreanProse(value, path, maxLength);
}

function requireInteger(value, path) {
    if (!Number.isInteger(value) || value < 0) fail(path, 'non-negative integer required');
    return value;
}

function nullableSeat(value, path) {
    if (value === null || value === undefined) return null;
    return requireInteger(value, path);
}

function nullableAmount(value, path, { positive = false } = {}) {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        fail(path, 'finite non-negative number or null required');
    }
    if (positive && value <= 0) fail(path, 'positive number required');
    return value;
}

function requireEnum(value, values, path) {
    if (!values.includes(value)) fail(path, `must be one of: ${values.join(', ')}`);
    return value;
}

function normalizeStreet(value, path) {
    if (typeof value !== 'string') fail(path, 'street required');
    return requireEnum(value.toLowerCase(), STREETS, path);
}

// Boundary-specific strictness: same vocabulary as schema.normalizeCard, but
// invalid input fails the whole payload instead of degrading to null.
function normalizeCard(value, path) {
    if (typeof value !== 'string') fail(path, 'card string required');
    const card = canonicalCard(value);
    if (!card) fail(path, 'canonical card required (for example Ah)');
    return card;
}

function normalizeCards(value, path, allowedLengths) {
    if (!Array.isArray(value)) fail(path, 'card array required');
    if (!allowedLengths.includes(value.length)) {
        fail(path, `card count must be one of: ${allowedLengths.join(', ')}`);
    }
    const cards = value.map((card, index) => normalizeCard(card, `${path}[${index}]`));
    if (new Set(cards).size !== cards.length) fail(path, 'duplicate cards are not allowed');
    return cards;
}

function uniqueStrings(value, path, { maxItems = 10, maxLength = 200, allowEmpty = true } = {}) {
    if (!Array.isArray(value)) fail(path, 'array required');
    if (!allowEmpty && value.length === 0) fail(path, 'must not be empty');
    if (value.length > maxItems) fail(path, `must contain at most ${maxItems} items`);
    const strings = value.map((item, index) => requireString(item, `${path}[${index}]`, maxLength));
    if (new Set(strings).size !== strings.length) fail(path, 'duplicate values are not allowed');
    return strings;
}

function round(value, digits = 4) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    const scale = 10 ** digits;
    return Math.round(value * scale) / scale;
}

function playerIdForSeat(seat) {
    return `seat:${seat}`;
}

function sanitizePlayer(raw, path) {
    const value = requireObject(raw, path);
    assertAllowedKeys(value, ['playerId', 'seat', 'position', 'startingStack'], path);
    return {
        playerId: requireString(value.playerId, `${path}.playerId`, 80),
        seat: requireInteger(value.seat, `${path}.seat`),
        position: nullableString(value.position, `${path}.position`, 20),
        startingStack: nullableAmount(value.startingStack, `${path}.startingStack`),
    };
}

function sanitizeShared(raw) {
    const shared = requireObject(raw, 'payload.shared');
    assertAllowedKeys(shared, ['handId', 'game', 'hero', 'players'], 'payload.shared');

    const game = requireObject(shared.game, 'payload.shared.game');
    assertAllowedKeys(game, [
        'variant', 'format', 'unit', 'smallBlind', 'bigBlind', 'ante',
        'straddleCount', 'chipUnit', 'dealerSeat',
    ], 'payload.shared.game');
    const sanitizedGame = {
        variant: requireEnum(game.variant, ['NLHE'], 'payload.shared.game.variant'),
        format: requireEnum(game.format, ['cash', 'tournament'], 'payload.shared.game.format'),
        unit: requireEnum(game.unit, ['chips'], 'payload.shared.game.unit'),
        smallBlind: nullableAmount(game.smallBlind, 'payload.shared.game.smallBlind'),
        bigBlind: nullableAmount(game.bigBlind, 'payload.shared.game.bigBlind', { positive: true }),
        ante: nullableAmount(game.ante, 'payload.shared.game.ante'),
        straddleCount: requireInteger(game.straddleCount, 'payload.shared.game.straddleCount'),
        chipUnit: nullableAmount(game.chipUnit, 'payload.shared.game.chipUnit', { positive: true }),
        dealerSeat: nullableSeat(game.dealerSeat, 'payload.shared.game.dealerSeat'),
    };
    if (sanitizedGame.ante !== 0) {
        fail('payload.shared.game.ante', 'ante is not supported by the deterministic replay engine');
    }

    const hero = requireObject(shared.hero, 'payload.shared.hero');
    assertAllowedKeys(hero, ['playerId', 'seat', 'position', 'holeCards'], 'payload.shared.hero');
    const sanitizedHero = {
        playerId: requireString(hero.playerId, 'payload.shared.hero.playerId', 80),
        seat: requireInteger(hero.seat, 'payload.shared.hero.seat'),
        position: nullableString(hero.position, 'payload.shared.hero.position', 20),
        holeCards: normalizeCards(hero.holeCards, 'payload.shared.hero.holeCards', [0, 2]),
    };

    if (!Array.isArray(shared.players) || shared.players.length < 2 || shared.players.length > 10) {
        fail('payload.shared.players', 'must contain 2 to 10 players');
    }
    const players = shared.players.map((player, index) => sanitizePlayer(player, `payload.shared.players[${index}]`));
    const playerIds = players.map(player => player.playerId);
    const seats = players.map(player => player.seat);
    if (new Set(playerIds).size !== playerIds.length) fail('payload.shared.players', 'playerId values must be unique');
    if (new Set(seats).size !== seats.length) fail('payload.shared.players', 'seat values must be unique');
    const heroPlayer = players.find(player => player.playerId === sanitizedHero.playerId && player.seat === sanitizedHero.seat);
    if (!heroPlayer) fail('payload.shared.hero', 'hero must match one shared player');

    return {
        handId: requireString(shared.handId, 'payload.shared.handId', 120),
        game: sanitizedGame,
        hero: sanitizedHero,
        players: players.slice().sort((a, b) => a.seat - b.seat),
    };
}

function sanitizeRecordedAction(raw, path) {
    const action = requireObject(raw, path);
    assertAllowedKeys(action, [
        'seq', 'street', 'actorId', 'seat', 'type', 'amountTo', 'amountAdded',
        'precision', 'isAllIn',
    ], path);
    return {
        seq: requireInteger(action.seq, `${path}.seq`),
        street: normalizeStreet(action.street, `${path}.street`),
        actorId: requireString(action.actorId, `${path}.actorId`, 80),
        seat: requireInteger(action.seat, `${path}.seat`),
        type: requireEnum(action.type, RECORDED_ACTIONS, `${path}.type`),
        amountTo: nullableAmount(action.amountTo, `${path}.amountTo`),
        amountAdded: nullableAmount(action.amountAdded, `${path}.amountAdded`),
        precision: requireEnum(action.precision, PRECISIONS, `${path}.precision`),
        isAllIn: !!action.isAllIn,
    };
}

function sanitizeActivePlayer(raw, path) {
    const player = requireObject(raw, path);
    assertAllowedKeys(player, ['playerId', 'seat', 'position', 'stackBefore', 'allIn'], path);
    return {
        playerId: requireString(player.playerId, `${path}.playerId`, 80),
        seat: requireInteger(player.seat, `${path}.seat`),
        position: nullableString(player.position, `${path}.position`, 20),
        stackBefore: nullableAmount(player.stackBefore, `${path}.stackBefore`),
        allIn: !!player.allIn,
    };
}

function sanitizeDecisionState(raw, path) {
    const state = requireObject(raw, path);
    assertAllowedKeys(state, [
        'potBefore', 'potQuality', 'currentBet', 'toCall', 'minRaiseTo',
        'heroStackBefore', 'stackQuality', 'potOddsRequiredPct', 'heroSprBefore',
        'legalActions',
    ], path);
    if (!Array.isArray(state.legalActions) || state.legalActions.length === 0) {
        fail(`${path}.legalActions`, 'non-empty legal action array required');
    }
    const legalActions = state.legalActions.map((action, index) =>
        requireEnum(action, LEGAL_ACTIONS, `${path}.legalActions[${index}]`));
    if (new Set(legalActions).size !== legalActions.length) {
        fail(`${path}.legalActions`, 'duplicate actions are not allowed');
    }
    const potOdds = nullableAmount(state.potOddsRequiredPct, `${path}.potOddsRequiredPct`);
    if (potOdds !== null && potOdds > 100) fail(`${path}.potOddsRequiredPct`, 'must be at most 100');
    return {
        potBefore: nullableAmount(state.potBefore, `${path}.potBefore`),
        potQuality: requireEnum(state.potQuality, PRECISIONS, `${path}.potQuality`),
        currentBet: nullableAmount(state.currentBet, `${path}.currentBet`),
        toCall: nullableAmount(state.toCall, `${path}.toCall`),
        minRaiseTo: nullableAmount(state.minRaiseTo, `${path}.minRaiseTo`),
        heroStackBefore: nullableAmount(state.heroStackBefore, `${path}.heroStackBefore`),
        stackQuality: requireEnum(state.stackQuality, PRECISIONS, `${path}.stackQuality`),
        potOddsRequiredPct: potOdds,
        heroSprBefore: nullableAmount(state.heroSprBefore, `${path}.heroSprBefore`),
        legalActions,
    };
}

function derivedFactRefs(shared, decision) {
    const refs = [
        'game.variant', 'game.format', 'game.straddleCount',
        'state.legalActions', 'actualAction',
    ];
    if (shared.game.smallBlind !== null) refs.push('game.smallBlind');
    if (shared.game.bigBlind !== null) refs.push('game.bigBlind');
    if (shared.hero.position !== null) refs.push('hero.position');
    if (shared.hero.holeCards.length === 2) refs.push('hero.holeCards');
    if (decision.visibleBoard.length > 0) refs.push('visibleBoard');
    for (const key of [
        'potBefore', 'currentBet', 'toCall', 'minRaiseTo', 'heroStackBefore',
        'potOddsRequiredPct', 'heroSprBefore',
    ]) {
        if (decision.state[key] !== null) refs.push(`state.${key}`);
    }
    for (const action of decision.priorActions) refs.push(`priorActions:${action.seq}`);
    for (const player of decision.activePlayers) refs.push(`activePlayers:${player.playerId}`);
    return [...new Set(refs)];
}

function sanitizeDecision(raw, shared, index) {
    const path = `payload.decisions[${index}]`;
    const decision = requireObject(raw, path);
    assertAllowedKeys(decision, [
        'decisionId', 'decisionSeq', 'street', 'visibleBoard', 'activePlayers',
        'priorActions', 'state', 'actualAction', 'dataQuality', 'allowedFactRefs',
    ], path);

    const street = normalizeStreet(decision.street, `${path}.street`);
    const visibleBoard = normalizeCards(
        decision.visibleBoard,
        `${path}.visibleBoard`,
        STREET_ALLOWED_VISIBLE_COUNTS[street],
    );

    if (!Array.isArray(decision.activePlayers) || decision.activePlayers.length < 2) {
        fail(`${path}.activePlayers`, 'at least two active players required');
    }
    const activePlayers = decision.activePlayers
        .map((player, playerIndex) => sanitizeActivePlayer(player, `${path}.activePlayers[${playerIndex}]`))
        .sort((a, b) => a.seat - b.seat);
    if (new Set(activePlayers.map(player => player.playerId)).size !== activePlayers.length) {
        fail(`${path}.activePlayers`, 'playerId values must be unique');
    }

    if (!Array.isArray(decision.priorActions)) fail(`${path}.priorActions`, 'array required');
    const priorActions = decision.priorActions
        .map((action, actionIndex) => sanitizeRecordedAction(action, `${path}.priorActions[${actionIndex}]`))
        .sort((a, b) => a.seq - b.seq);
    if (new Set(priorActions.map(action => action.seq)).size !== priorActions.length) {
        fail(`${path}.priorActions`, 'seq values must be unique');
    }

    const decisionSeq = requireInteger(decision.decisionSeq, `${path}.decisionSeq`);
    if (priorActions.some(action => action.seq >= decisionSeq)) {
        fail(`${path}.priorActions`, 'all actions must be strictly before decisionSeq');
    }
    if (priorActions.some(action => STREETS.indexOf(action.street) > STREETS.indexOf(street))) {
        fail(`${path}.priorActions`, 'future-street actions are not allowed');
    }

    const state = sanitizeDecisionState(decision.state, `${path}.state`);
    const actualAction = sanitizeRecordedAction(decision.actualAction, `${path}.actualAction`);
    if (actualAction.seq !== decisionSeq) fail(`${path}.actualAction.seq`, 'must equal decisionSeq');
    if (actualAction.street !== street) fail(`${path}.actualAction.street`, 'must equal decision street');
    if (actualAction.actorId !== shared.hero.playerId || actualAction.seat !== shared.hero.seat) {
        fail(`${path}.actualAction`, 'must belong to the hero');
    }
    if (!state.legalActions.includes(actualAction.type)) {
        fail(`${path}.actualAction.type`, 'must be legal at this decision');
    }

    const activeIds = new Set(activePlayers.map(player => player.playerId));
    if (!activeIds.has(shared.hero.playerId)) fail(`${path}.activePlayers`, 'hero must be active');
    const sharedIds = new Set(shared.players.map(player => player.playerId));
    if (activePlayers.some(player => !sharedIds.has(player.playerId))) {
        fail(`${path}.activePlayers`, 'contains a player outside shared.players');
    }
    if (priorActions.some(action => !sharedIds.has(action.actorId))) {
        fail(`${path}.priorActions`, 'contains an actor outside shared.players');
    }

    const dataQuality = requireObject(decision.dataQuality, `${path}.dataQuality`);
    assertAllowedKeys(dataQuality, ['overall', 'unknownFields'], `${path}.dataQuality`);
    const sanitizedQuality = {
        overall: requireEnum(dataQuality.overall, PRECISIONS, `${path}.dataQuality.overall`),
        unknownFields: uniqueStrings(dataQuality.unknownFields, `${path}.dataQuality.unknownFields`, {
            maxItems: 20,
            maxLength: 100,
        }),
    };

    const sanitized = {
        decisionId: requireString(decision.decisionId, `${path}.decisionId`, 160),
        decisionSeq,
        street,
        visibleBoard,
        activePlayers,
        priorActions,
        state,
        actualAction,
        dataQuality: sanitizedQuality,
    };
    const allowedFactRefs = derivedFactRefs(shared, sanitized);
    if (decision.allowedFactRefs !== undefined) {
        const supplied = uniqueStrings(decision.allowedFactRefs, `${path}.allowedFactRefs`, {
            maxItems: 100,
            maxLength: 120,
        });
        const expected = new Set(allowedFactRefs);
        if (supplied.length !== expected.size || supplied.some(ref => !expected.has(ref))) {
            fail(`${path}.allowedFactRefs`, 'must exactly match the deterministic whitelist');
        }
    }

    const allKnownCards = [...shared.hero.holeCards, ...visibleBoard];
    if (new Set(allKnownCards).size !== allKnownCards.length) {
        fail(`${path}.visibleBoard`, 'duplicates a hero hole card');
    }

    return { ...sanitized, allowedFactRefs };
}

/**
 * Validate and canonicalize an already-built detailed review payload.
 * Unknown/extra fields are rejected so future actions, runout, showdown, or results
 * cannot silently enter a prompt.
 */
export function validateDetailedReviewPayload(payload) {
    const root = requireObject(payload, 'payload');
    assertAllowedKeys(root, ['schemaVersion', 'analysisMode', 'shared', 'decisions'], 'payload');
    if (root.schemaVersion !== PAYLOAD_SCHEMA_VERSION) {
        fail('payload.schemaVersion', `must equal ${PAYLOAD_SCHEMA_VERSION}`);
    }
    if (root.analysisMode !== ANALYSIS_MODE) {
        fail('payload.analysisMode', `must equal ${ANALYSIS_MODE}`);
    }

    const shared = sanitizeShared(root.shared);
    if (!Array.isArray(root.decisions) || root.decisions.length === 0 || root.decisions.length > 30) {
        fail('payload.decisions', 'must contain 1 to 30 decisions');
    }
    const decisions = root.decisions
        .map((decision, index) => sanitizeDecision(decision, shared, index))
        .sort((a, b) => a.decisionSeq - b.decisionSeq);
    if (new Set(decisions.map(decision => decision.decisionId)).size !== decisions.length) {
        fail('payload.decisions', 'decisionId values must be unique');
    }
    if (new Set(decisions.map(decision => decision.decisionSeq)).size !== decisions.length) {
        fail('payload.decisions', 'decisionSeq values must be unique');
    }

    return {
        schemaVersion: PAYLOAD_SCHEMA_VERSION,
        analysisMode: ANALYSIS_MODE,
        shared,
        decisions,
    };
}

function boardThroughStreet(board, street) {
    const source = isObject(board) ? board : {};
    const streetIndex = STREETS.indexOf(street);
    return {
        flop: streetIndex >= 1 && Array.isArray(source.flop) ? [...source.flop] : [],
        turn: streetIndex >= 2 && Array.isArray(source.turn) ? [...source.turn] : [],
        river: streetIndex >= 3 && Array.isArray(source.river) ? [...source.river] : [],
    };
}

function flattenVisibleBoard(board, street) {
    const cutoff = boardThroughStreet(board, street);
    return [...cutoff.flop, ...cutoff.turn, ...cutoff.river];
}

function recordedActionFromHand(action, path) {
    const seat = requireInteger(action?.seat, `${path}.seat`);
    const type = action?.type === 'all-in' ? null : action?.type;
    if (!RECORDED_ACTIONS.includes(type)) fail(`${path}.type`, 'resolved detailed action required');
    return {
        seq: requireInteger(action.seq, `${path}.seq`),
        street: normalizeStreet(action.street || 'preflop', `${path}.street`),
        actorId: playerIdForSeat(seat),
        seat,
        type,
        amountTo: nullableAmount(action.amountTo, `${path}.amountTo`),
        amountAdded: nullableAmount(action.amountAdded, `${path}.amountAdded`),
        precision: requireEnum(action.precision || 'unknown', PRECISIONS, `${path}.precision`),
        isAllIn: !!action.isAllIn,
    };
}

function prefixHandForDecision(hand, decisionSeq, street) {
    const board = boardThroughStreet(hand.detailed.board, street);
    const actions = hand.actions
        .filter(action => Number.isInteger(action?.seq) && action.seq < decisionSeq)
        .filter(action => STREETS.indexOf(String(action.street || 'preflop').toLowerCase()) <= STREETS.indexOf(street))
        .map(action => ({ ...action }));

    return {
        id: hand.id,
        dealerSeat: hand.dealerSeat,
        straddleCount: hand.straddleCount || 0,
        blinds: hand.blinds ? { ...hand.blinds } : null,
        seats: hand.seats.map(seat => ({ ...seat })),
        actions,
        detailed: {
            enabled: true,
            heroSeat: hand.detailed.heroSeat,
            chipUnit: hand.detailed.chipUnit,
            startingStacks: { ...(hand.detailed.startingStacks || {}) },
            startingStackPrecisions: { ...(hand.detailed.startingStackPrecisions || {}) },
            street,
            board,
            heroCards: Array.isArray(hand.detailed.heroCards) ? [...hand.detailed.heroCards] : [],
            // Knowledge cutoff: never replay or expose showdown/result metadata.
            reveals: [],
            completed: false,
            winners: [],
        },
    };
}

function qualityUnknownFields(state, visibleBoard, street, heroCards) {
    const unknown = [];
    if (state.pot === null) unknown.push('state.potBefore');
    if (state.toCall === null) unknown.push('state.toCall');
    const heroState = state.players.find(player => player.seat === state.heroSeat);
    if (!heroState || heroState.stack === null) unknown.push('state.heroStackBefore');
    if (heroCards.length !== 2) unknown.push('hero.holeCards');
    if (visibleBoard.length !== STREET_BOARD_COUNTS[street]) unknown.push('visibleBoard');
    if (state.validationErrors.length > 0) unknown.push('state.replayValidation');
    return unknown;
}

/**
 * Build a canonical prompt payload from a completed/partial detailed hand.
 * decisionSnapshots only select hero decision sequence numbers. State is always replayed
 * from actions with seq < decisionSeq; caller-provided future-sensitive snapshot fields
 * are deliberately ignored.
 */
export function buildDetailedReviewPayload(hand, decisionSnapshots) {
    const source = requireObject(hand, 'hand');
    if (!source.detailed?.enabled) fail('hand.detailed.enabled', 'detailed tracking must be enabled');
    if (!Array.isArray(source.seats) || source.seats.length < 2) fail('hand.seats', 'at least two seats required');
    if (!Array.isArray(source.actions)) fail('hand.actions', 'array required');
    if (!Array.isArray(decisionSnapshots) || decisionSnapshots.length === 0) {
        fail('decisionSnapshots', 'non-empty array required');
    }

    const handId = requireString(source.id, 'hand.id', 120);
    const heroSeat = requireInteger(source.detailed.heroSeat, 'hand.detailed.heroSeat');
    const heroSeatRecord = source.seats.find(seat => seat?.seat === heroSeat && !seat.sittingOut);
    if (!heroSeatRecord) fail('hand.detailed.heroSeat', 'must identify an active seat');
    const sourceAnte = source.blinds?.ante ?? source.ante ?? 0;
    if (sourceAnte !== 0) {
        fail('hand.ante', 'ante is not supported by the deterministic replay engine');
    }

    const startingStacks = source.detailed.startingStacks || {};
    const players = source.seats
        .filter(seat => seat && !seat.sittingOut)
        .map(seat => ({
            playerId: playerIdForSeat(seat.seat),
            seat: seat.seat,
            position: seat.position ?? null,
            startingStack: nullableAmount(
                startingStacks[seat.seat] ?? startingStacks[String(seat.seat)] ?? null,
                `hand.detailed.startingStacks[${seat.seat}]`,
            ),
        }))
        .sort((a, b) => a.seat - b.seat);

    const shared = {
        handId,
        game: {
            variant: source.variant || source.game?.variant || 'NLHE',
            format: source.format || source.game?.format || 'cash',
            unit: 'chips',
            smallBlind: source.blinds?.sb ?? null,
            bigBlind: source.blinds?.bb ?? null,
            ante: 0,
            straddleCount: Number.isInteger(source.straddleCount) && source.straddleCount >= 0
                ? source.straddleCount
                : 0,
            chipUnit: source.detailed.chipUnit ?? null,
            dealerSeat: source.dealerSeat ?? null,
        },
        hero: {
            playerId: playerIdForSeat(heroSeat),
            seat: heroSeat,
            position: heroSeatRecord.position ?? null,
            holeCards: Array.isArray(source.detailed.heroCards) ? [...source.detailed.heroCards] : [],
        },
        players,
    };

    const decisions = decisionSnapshots.map((snapshot, snapshotIndex) => {
        const selector = requireObject(snapshot, `decisionSnapshots[${snapshotIndex}]`);
        const decisionSeq = requireInteger(
            selector.decisionSeq ?? selector.seq,
            `decisionSnapshots[${snapshotIndex}].decisionSeq`,
        );
        const rawActual = source.actions.find(action => action?.seq === decisionSeq);
        if (!rawActual) fail(`decisionSnapshots[${snapshotIndex}]`, 'decision action was not found in hand.actions');
        if (rawActual.seat !== heroSeat) fail(`decisionSnapshots[${snapshotIndex}]`, 'decision action must belong to hero');

        const actualAction = recordedActionFromHand(rawActual, `hand.actions[seq=${decisionSeq}]`);
        const street = actualAction.street;
        const prefixHand = prefixHandForDecision(source, decisionSeq, street);
        const state = deriveDetailedState(prefixHand);
        const legalActions = legalDetailedActions(prefixHand, heroSeat);
        const heroState = state.players.find(player => player.seat === heroSeat);
        const visibleBoard = flattenVisibleBoard(prefixHand.detailed.board, street);
        const priorActions = prefixHand.actions
            .map((action, actionIndex) => recordedActionFromHand(action, `prefix.actions[${actionIndex}]`))
            .sort((a, b) => a.seq - b.seq);
        const activePlayers = state.players
            .filter(player => player.active && !player.folded)
            .map(player => ({
                playerId: playerIdForSeat(player.seat),
                seat: player.seat,
                position: player.position ?? null,
                stackBefore: player.stack,
                allIn: !!player.allIn,
            }))
            .sort((a, b) => a.seat - b.seat);

        const potOddsRequiredPct = state.pot !== null && state.toCall !== null && state.pot + state.toCall > 0
            ? round((state.toCall / (state.pot + state.toCall)) * 100)
            : null;
        const heroSprBefore = state.pot !== null && state.pot > 0 && heroState?.stack !== null
            ? round(heroState.stack / state.pot)
            : null;
        const overallQuality = state.validationErrors.length > 0 ? 'unknown' : state.quality;

        return {
            decisionId: `${handId}:a${decisionSeq}`,
            decisionSeq,
            street,
            visibleBoard,
            activePlayers,
            priorActions,
            state: {
                potBefore: state.pot,
                potQuality: state.potQuality,
                currentBet: state.currentBet,
                toCall: state.toCall,
                minRaiseTo: state.minRaiseTo,
                heroStackBefore: heroState?.stack ?? null,
                stackQuality: state.stackQuality,
                potOddsRequiredPct,
                heroSprBefore,
                legalActions,
            },
            actualAction,
            dataQuality: {
                overall: overallQuality,
                unknownFields: qualityUnknownFields(state, visibleBoard, street, shared.hero.holeCards),
            },
        };
    });

    return validateDetailedReviewPayload({
        schemaVersion: PAYLOAD_SCHEMA_VERSION,
        analysisMode: ANALYSIS_MODE,
        shared,
        decisions,
    });
}

/** Build the deterministic, single-decision prompt used by a provider-facing layer. */
export function buildDecisionPrompt(shared, decision) {
    const validated = validateDetailedReviewPayload({
        schemaVersion: PAYLOAD_SCHEMA_VERSION,
        analysisMode: ANALYSIS_MODE,
        shared,
        decisions: [decision],
    });
    const safeShared = validated.shared;
    const safeDecision = validated.decisions[0];
    const input = JSON.stringify({ shared: safeShared, decision: safeDecision }, null, 2);

    return [
        'You are a poker study assistant reviewing exactly one past hero decision.',
        `Analysis mode is ${ANALYSIS_MODE}: no solver and no equity engine are available.`,
        'Use only the knowledge-cutoff JSON below. It contains no future action, future board card, showdown, winner, or result.',
        'Do not claim GTO optimality, exact equity, EV, EV loss, frequencies, ranges, scores, or that an action is definitively correct/incorrect.',
        'Assess only whether the action is heuristically plausible, needs review, or cannot be graded from the supplied facts.',
        'Every reasoning item must cite only an exact string from decision.allowedFactRefs.',
        'Every alternative action must be present in decision.state.legalActions.',
        `Confidence.value must be between 0 and ${CONFIDENCE_CAP}. All prose must be Korean.`,
        'Return one JSON object only with this shape:',
        JSON.stringify({
            analysisMode: ANALYSIS_MODE,
            decisionId: safeDecision.decisionId,
            assessment: 'plausible | review_needed | not_gradable',
            confidence: { value: 0.0 },
            headline: 'string',
            reasoning: [{ text: 'string', factRefs: ['allowed reference'] }],
            alternatives: [{ action: 'legal action', condition: 'string', why: 'string' }],
            unknowns: ['string'],
            reflectionQuestion: 'string or null',
        }, null, 2),
        'KNOWLEDGE-CUTOFF INPUT:',
        input,
    ].join('\n');
}

function sanitizeReasoning(raw, path, allowedRefs) {
    const item = requireObject(raw, path);
    assertAllowedKeys(item, ['text', 'factRefs'], path);
    const factRefs = uniqueStrings(item.factRefs, `${path}.factRefs`, {
        maxItems: 12,
        maxLength: 120,
        allowEmpty: false,
    });
    for (const ref of factRefs) {
        if (!allowedRefs.has(ref)) fail(`${path}.factRefs`, `reference is not allowed: ${ref}`);
    }
    return {
        text: requireKoreanProse(item.text, `${path}.text`, 600),
        factRefs,
    };
}

function sanitizeAlternative(raw, path, legalActions) {
    const item = requireObject(raw, path);
    assertAllowedKeys(item, ['action', 'condition', 'why'], path);
    const action = requireEnum(item.action, LEGAL_ACTIONS, `${path}.action`);
    if (!legalActions.has(action)) fail(`${path}.action`, 'alternative is not legal for this decision');
    return {
        action,
        condition: requireKoreanProse(item.condition, `${path}.condition`, 300),
        why: requireKoreanProse(item.why, `${path}.why`, 500),
    };
}

/** Validate and whitelist one raw model response for a specific decision. */
export function validateDecisionReview(raw, decision) {
    const input = requireObject(raw, 'review');
    assertAllowedKeys(input, [
        'analysisMode', 'decisionId', 'assessment', 'confidence', 'headline',
        'reasoning', 'alternatives', 'unknowns', 'reflectionQuestion',
    ], 'review');
    if (input.analysisMode !== ANALYSIS_MODE) fail('review.analysisMode', `must equal ${ANALYSIS_MODE}`);

    const expected = requireObject(decision, 'decision');
    const decisionId = requireString(expected.decisionId, 'decision.decisionId', 160);
    if (input.decisionId !== decisionId) fail('review.decisionId', 'does not match the requested decision');
    const street = normalizeStreet(expected.street, 'decision.street');
    const legalActions = new Set(expected.state?.legalActions || []);
    if (legalActions.size === 0) fail('decision.state.legalActions', 'non-empty array required');
    const allowedRefs = new Set(expected.allowedFactRefs || []);
    if (allowedRefs.size === 0) fail('decision.allowedFactRefs', 'non-empty array required');
    const safeRefs = new Set(STATIC_FACT_REFS);
    for (const action of expected.priorActions || []) safeRefs.add(`priorActions:${action.seq}`);
    for (const player of expected.activePlayers || []) safeRefs.add(`activePlayers:${player.playerId}`);
    for (const ref of allowedRefs) {
        if (!safeRefs.has(ref)) fail('decision.allowedFactRefs', `unsafe reference: ${ref}`);
    }

    const confidence = requireObject(input.confidence, 'review.confidence');
    assertAllowedKeys(confidence, ['value'], 'review.confidence');
    if (typeof confidence.value !== 'number' || !Number.isFinite(confidence.value)
        || confidence.value < 0 || confidence.value > 1) {
        fail('review.confidence.value', 'number between 0 and 1 required');
    }

    if (!Array.isArray(input.reasoning) || input.reasoning.length === 0 || input.reasoning.length > 6) {
        fail('review.reasoning', 'must contain 1 to 6 items');
    }
    const reasoning = input.reasoning.map((item, index) =>
        sanitizeReasoning(item, `review.reasoning[${index}]`, allowedRefs));

    if (!Array.isArray(input.alternatives) || input.alternatives.length > 4) {
        fail('review.alternatives', 'must contain at most 4 items');
    }
    const alternatives = input.alternatives.map((item, index) =>
        sanitizeAlternative(item, `review.alternatives[${index}]`, legalActions));

    return {
        schemaVersion: REVIEW_SCHEMA_VERSION,
        analysisMode: ANALYSIS_MODE,
        decisionId,
        street,
        assessment: requireEnum(input.assessment, ASSESSMENTS, 'review.assessment'),
        confidence: {
            value: Math.min(round(confidence.value), CONFIDENCE_CAP),
            cap: CONFIDENCE_CAP,
        },
        headline: requireKoreanProse(input.headline, 'review.headline', 180),
        reasoning,
        alternatives,
        unknowns: uniqueStrings(input.unknowns, 'review.unknowns', {
            maxItems: 8,
            maxLength: 240,
        }).map((item, index) => requireKoreanProse(item, `review.unknowns[${index}]`, 240)),
        reflectionQuestion: nullableKoreanProse(input.reflectionQuestion, 'review.reflectionQuestion', 320),
    };
}
