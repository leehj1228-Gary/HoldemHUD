// DecisionSnapshot v1 계약 (연구 기준서 §15.1 — decision-snapshot.v1)
// 순수 모듈. validator는 §15.1 불변조건 10개 중 구조적으로 검사 가능한 것을 전부 강제하고,
// 알 수 없는 필드는 전면 거부한다 (미래 액션·보드·쇼다운·결과가 조용히 스며드는 경로 차단).

import {
    DETAILED_STREETS as STREETS,
    DETAILED_ACTION_TYPES as RECORDED_ACTIONS,
    DETAILED_PRECISIONS as PRECISIONS,
    normalizeCard,
} from '../../engine/schema.js';
import { computeInputHash } from '../hash.js';

export const DECISION_SNAPSHOT_SCHEMA_VERSION = 'decision-snapshot.v1';
export const ANALYSIS_CONTEXTS = ['post_hand', 'sandbox'];
export const SNAPSHOT_SOURCE = 'holdemhud.manual_capture';

export const LEGAL_OPTION_ACTIONS = [...RECORDED_ACTIONS, 'all-in'];
const PLAYER_ID_PATTERN = /^(?:player:[0-9a-f]{8}|seat:\d+)$/;
const INPUT_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
// 거리별 허용 보드 장수 (detailedReview와 동일한 경계 강화: 부분 unknown 보드 허용).
const STREET_ALLOWED_VISIBLE_COUNTS = {
    preflop: [0],
    flop: [0, 3],
    turn: [0, 1, 3, 4],
    river: [0, 1, 2, 3, 4, 5],
};
// snapshot 어디에도 나타나면 안 되는 키: 실명/PII와 미래 정보 계열 (불변조건 1, 6).
const FORBIDDEN_DEEP_KEYS = new Set([
    'name', 'displayName', 'email', 'apiKey', 'note', 'notes',
    'showdown', 'reveals', 'winners', 'winner', 'result', 'payout', 'payouts', 'futureActions',
]);

const ROOT_KEYS = [
    'schemaVersion', 'requestId', 'handId', 'decisionId', 'analysisContext', 'knowledgeCutoff',
    'game', 'hero', 'players', 'visibleBoard', 'priorActions', 'state',
    'opponentModelRef', 'actualAction', 'dataQuality', 'provenance',
];
const GAME_KEYS = [
    'variant', 'format', 'currencyMode', 'chipUnit', 'smallBlind', 'bigBlind',
    'ante', 'rake', 'dealerSeat', 'straddlePosts',
];
const HERO_KEYS = ['playerId', 'seat', 'position', 'holeCards'];
const PLAYER_KEYS = ['playerId', 'seat', 'position', 'startingStack', 'stackBefore', 'stackPrecision', 'folded', 'allIn'];
const PRIOR_ACTION_KEYS = ['seq', 'street', 'playerId', 'action', 'amountTo', 'amountAdded', 'potFraction', 'isAllIn', 'precision'];
const STATE_KEYS = [
    'potBeforeAction', 'potPrecision', 'contestablePots', 'currentBetTo', 'heroCommittedThisStreet',
    'toCall', 'minRaiseTo', 'maxRaiseTo', 'heroStackBefore', 'heroSprBefore', 'potOddsRequiredPct', 'legalOptions',
];
const POT_KEYS = ['potId', 'amount', 'eligiblePlayerIds'];
const OPTION_KEYS = ['action', 'amountAdded', 'minTo', 'maxTo'];
const CUTOFF_KEYS = ['decisionSeq', 'street', 'visibleThroughActionSeq'];
const OPPONENT_REF_KEYS = ['modelId', 'asOfHandId', 'includedHands'];
const ACTUAL_KEYS = ['action', 'amountTo', 'amountAdded', 'isAllIn', 'precision'];
const QUALITY_KEYS = ['overall', 'unknownFields', 'estimatedFields', 'validationErrors'];
const PROVENANCE_KEYS = ['source', 'sourceSchemaVersion', 'snapshotBuilderVersion', 'inputHash'];

function isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isAmount(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isNullableAmount(value) {
    return value === null || isAmount(value);
}

function checkKeys(value, allowed, path, errors) {
    for (const key of Object.keys(value)) {
        if (!allowed.includes(key)) errors.push(`${path}.${key}: field is not allowed`);
    }
}

function checkForbiddenDeepKeys(value, path, errors) {
    if (Array.isArray(value)) {
        value.forEach((item, index) => checkForbiddenDeepKeys(item, `${path}[${index}]`, errors));
        return;
    }
    if (!isObject(value)) return;
    for (const [key, entry] of Object.entries(value)) {
        if (FORBIDDEN_DEEP_KEYS.has(key)) {
            errors.push(`${path}.${key}: forbidden key (display name/PII/future information)`);
            continue;
        }
        checkForbiddenDeepKeys(entry, `${path}.${key}`, errors);
    }
}

function checkCards(value, path, allowedLengths, errors) {
    if (!Array.isArray(value)) {
        errors.push(`${path}: card array required`);
        return [];
    }
    if (allowedLengths && !allowedLengths.includes(value.length)) {
        errors.push(`${path}: card count must be one of: ${allowedLengths.join(', ')}`);
    }
    const cards = [];
    value.forEach((card, index) => {
        const canonical = typeof card === 'string' ? normalizeCard(card) : null;
        if (!canonical || canonical !== card) {
            errors.push(`${path}[${index}]: canonical card required (for example Ah)`);
        } else {
            cards.push(canonical);
        }
    });
    if (new Set(cards).size !== cards.length) errors.push(`${path}: duplicate cards are not allowed`);
    return cards;
}

function checkPlayerId(value, path, errors) {
    if (typeof value !== 'string' || !PLAYER_ID_PATTERN.test(value)) {
        errors.push(`${path}: pseudonymous playerId required (player:<hex8> or seat:<n>)`);
        return null;
    }
    return value;
}

/**
 * DecisionSnapshot v1 구조 검증. throw하지 않고 {ok, errors} 반환.
 * @param {object} snapshot
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateDecisionSnapshot(snapshot) {
    const errors = [];
    if (!isObject(snapshot)) return { ok: false, errors: ['snapshot: object required'] };
    checkKeys(snapshot, ROOT_KEYS, 'snapshot', errors);
    checkForbiddenDeepKeys(snapshot, 'snapshot', errors);

    if (snapshot.schemaVersion !== DECISION_SNAPSHOT_SCHEMA_VERSION) {
        errors.push(`snapshot.schemaVersion: must equal ${DECISION_SNAPSHOT_SCHEMA_VERSION}`);
    }
    if (snapshot.requestId !== undefined && (typeof snapshot.requestId !== 'string' || !snapshot.requestId.trim())) {
        errors.push('snapshot.requestId: non-empty string required when present');
    }
    if (typeof snapshot.handId !== 'string' || !snapshot.handId.trim()) {
        errors.push('snapshot.handId: non-empty string required');
    }
    if (!ANALYSIS_CONTEXTS.includes(snapshot.analysisContext)) {
        errors.push(`snapshot.analysisContext: must be one of: ${ANALYSIS_CONTEXTS.join(', ')}`);
    }

    // knowledgeCutoff (불변조건 1의 기준점)
    let decisionSeq = null;
    let cutoffStreetIndex = -1;
    if (!isObject(snapshot.knowledgeCutoff)) {
        errors.push('snapshot.knowledgeCutoff: object required');
    } else {
        const cutoff = snapshot.knowledgeCutoff;
        checkKeys(cutoff, CUTOFF_KEYS, 'snapshot.knowledgeCutoff', errors);
        if (!Number.isInteger(cutoff.decisionSeq) || cutoff.decisionSeq < 0) {
            errors.push('snapshot.knowledgeCutoff.decisionSeq: non-negative integer required');
        } else {
            decisionSeq = cutoff.decisionSeq;
        }
        if (!STREETS.includes(cutoff.street)) {
            errors.push(`snapshot.knowledgeCutoff.street: must be one of: ${STREETS.join(', ')}`);
        } else {
            cutoffStreetIndex = STREETS.indexOf(cutoff.street);
        }
        if (cutoff.visibleThroughActionSeq !== null
            && (!Number.isInteger(cutoff.visibleThroughActionSeq) || cutoff.visibleThroughActionSeq < 0)) {
            errors.push('snapshot.knowledgeCutoff.visibleThroughActionSeq: non-negative integer or null required');
        }
        if (decisionSeq !== null && Number.isInteger(cutoff.visibleThroughActionSeq)
            && cutoff.visibleThroughActionSeq >= decisionSeq) {
            errors.push('snapshot.knowledgeCutoff.visibleThroughActionSeq: must be strictly before decisionSeq');
        }
    }
    if (typeof snapshot.handId === 'string' && decisionSeq !== null
        && snapshot.decisionId !== `${snapshot.handId}:seq:${decisionSeq}`) {
        errors.push('snapshot.decisionId: must equal `${handId}:seq:${decisionSeq}`');
    }

    // game
    if (!isObject(snapshot.game)) {
        errors.push('snapshot.game: object required');
    } else {
        const game = snapshot.game;
        checkKeys(game, GAME_KEYS, 'snapshot.game', errors);
        if (game.variant !== 'NLHE') errors.push('snapshot.game.variant: must equal NLHE');
        if (!['cash', 'tournament'].includes(game.format)) {
            errors.push('snapshot.game.format: must be one of: cash, tournament');
        }
        if (game.currencyMode !== null && (typeof game.currencyMode !== 'string' || !game.currencyMode.trim())) {
            errors.push('snapshot.game.currencyMode: non-empty string or null required');
        }
        if (game.chipUnit !== null && (!isAmount(game.chipUnit) || game.chipUnit <= 0)) {
            errors.push('snapshot.game.chipUnit: positive number or null required');
        }
        if (!isNullableAmount(game.smallBlind)) errors.push('snapshot.game.smallBlind: amount or null required');
        if (game.bigBlind !== null && (!isAmount(game.bigBlind) || game.bigBlind <= 0)) {
            errors.push('snapshot.game.bigBlind: positive amount or null required');
        }
        if (game.ante !== 0) errors.push('snapshot.game.ante: must equal 0 (replay engine does not model antes)');
        if (game.rake !== null) errors.push('snapshot.game.rake: must be null in v1');
        if (game.dealerSeat !== null && (!Number.isInteger(game.dealerSeat) || game.dealerSeat < 0)) {
            errors.push('snapshot.game.dealerSeat: non-negative integer or null required');
        }
        if (!Array.isArray(game.straddlePosts)) {
            errors.push('snapshot.game.straddlePosts: array required');
        } else {
            game.straddlePosts.forEach((post, index) => {
                const path = `snapshot.game.straddlePosts[${index}]`;
                if (!isObject(post)) { errors.push(`${path}: object required`); return; }
                checkKeys(post, ['seat', 'playerId', 'amount'], path, errors);
                if (!Number.isInteger(post.seat) || post.seat < 0) errors.push(`${path}.seat: non-negative integer required`);
                checkPlayerId(post.playerId, `${path}.playerId`, errors);
                if (!isNullableAmount(post.amount)) errors.push(`${path}.amount: amount or null required`);
            });
        }
    }

    // players + hero (불변조건 2·6: 카드 필드/실명 없음은 key whitelist가 보장)
    const playerIds = new Set();
    if (!Array.isArray(snapshot.players) || snapshot.players.length < 2 || snapshot.players.length > 10) {
        errors.push('snapshot.players: must contain 2 to 10 players');
    } else {
        const seats = new Set();
        snapshot.players.forEach((player, index) => {
            const path = `snapshot.players[${index}]`;
            if (!isObject(player)) { errors.push(`${path}: object required`); return; }
            checkKeys(player, PLAYER_KEYS, path, errors);
            const id = checkPlayerId(player.playerId, `${path}.playerId`, errors);
            if (id) {
                if (playerIds.has(id)) errors.push(`${path}.playerId: duplicate playerId`);
                playerIds.add(id);
            }
            if (!Number.isInteger(player.seat) || player.seat < 0) {
                errors.push(`${path}.seat: non-negative integer required`);
            } else {
                if (seats.has(player.seat)) errors.push(`${path}.seat: duplicate seat`);
                seats.add(player.seat);
            }
            if (player.position !== null && (typeof player.position !== 'string' || !player.position.trim())) {
                errors.push(`${path}.position: non-empty string or null required`);
            }
            if (!isNullableAmount(player.startingStack)) errors.push(`${path}.startingStack: amount or null required`);
            if (!isNullableAmount(player.stackBefore)) errors.push(`${path}.stackBefore: amount or null required`);
            if (!PRECISIONS.includes(player.stackPrecision)) {
                errors.push(`${path}.stackPrecision: must be one of: ${PRECISIONS.join(', ')}`);
            }
            if (typeof player.folded !== 'boolean') errors.push(`${path}.folded: boolean required`);
            if (typeof player.allIn !== 'boolean') errors.push(`${path}.allIn: boolean required`);
        });
    }

    let heroCards = [];
    if (!isObject(snapshot.hero)) {
        errors.push('snapshot.hero: object required');
    } else {
        const hero = snapshot.hero;
        checkKeys(hero, HERO_KEYS, 'snapshot.hero', errors);
        const heroId = checkPlayerId(hero.playerId, 'snapshot.hero.playerId', errors);
        if (heroId && playerIds.size > 0 && !playerIds.has(heroId)) {
            errors.push('snapshot.hero.playerId: hero must be listed in snapshot.players');
        }
        if (!Number.isInteger(hero.seat) || hero.seat < 0) errors.push('snapshot.hero.seat: non-negative integer required');
        if (hero.position !== null && (typeof hero.position !== 'string' || !hero.position.trim())) {
            errors.push('snapshot.hero.position: non-empty string or null required');
        }
        heroCards = checkCards(hero.holeCards, 'snapshot.hero.holeCards', [0, 2], errors);
    }

    const visibleBoard = checkCards(
        snapshot.visibleBoard,
        'snapshot.visibleBoard',
        cutoffStreetIndex >= 0 ? STREET_ALLOWED_VISIBLE_COUNTS[STREETS[cutoffStreetIndex]] : null,
        errors,
    );
    if (new Set([...heroCards, ...visibleBoard]).size !== heroCards.length + visibleBoard.length) {
        errors.push('snapshot.visibleBoard: duplicates a hero hole card');
    }

    // priorActions (불변조건 1·3)
    if (!Array.isArray(snapshot.priorActions)) {
        errors.push('snapshot.priorActions: array required');
    } else {
        let previousSeq = -1;
        let maxSeq = null;
        snapshot.priorActions.forEach((action, index) => {
            const path = `snapshot.priorActions[${index}]`;
            if (!isObject(action)) { errors.push(`${path}: object required`); return; }
            checkKeys(action, PRIOR_ACTION_KEYS, path, errors);
            if (!Number.isInteger(action.seq) || action.seq < 0) {
                errors.push(`${path}.seq: non-negative integer required`);
            } else {
                if (action.seq <= previousSeq) errors.push(`${path}.seq: must be strictly increasing`);
                previousSeq = action.seq;
                maxSeq = maxSeq === null ? action.seq : Math.max(maxSeq, action.seq);
                if (decisionSeq !== null && action.seq >= decisionSeq) {
                    errors.push(`${path}.seq: future action at/after the decision is not allowed`);
                }
            }
            if (!STREETS.includes(action.street)) {
                errors.push(`${path}.street: must be one of: ${STREETS.join(', ')}`);
            } else if (cutoffStreetIndex >= 0 && STREETS.indexOf(action.street) > cutoffStreetIndex) {
                errors.push(`${path}.street: future-street action is not allowed`);
            }
            const id = checkPlayerId(action.playerId, `${path}.playerId`, errors);
            if (id && playerIds.size > 0 && !playerIds.has(id)) {
                errors.push(`${path}.playerId: actor outside snapshot.players`);
            }
            if (!RECORDED_ACTIONS.includes(action.action)) {
                errors.push(`${path}.action: must be one of: ${RECORDED_ACTIONS.join(', ')}`);
            }
            if (!isNullableAmount(action.amountTo)) errors.push(`${path}.amountTo: amount or null required`);
            if (!isNullableAmount(action.amountAdded)) errors.push(`${path}.amountAdded: amount or null required`);
            if (isAmount(action.amountTo) && isAmount(action.amountAdded) && action.amountAdded > action.amountTo) {
                errors.push(`${path}.amountAdded: must not exceed amountTo (raise-to vs added semantics)`);
            }
            if (action.potFraction !== null && !isAmount(action.potFraction)) {
                errors.push(`${path}.potFraction: non-negative number or null required`);
            }
            if (typeof action.isAllIn !== 'boolean') errors.push(`${path}.isAllIn: boolean required`);
            if (!PRECISIONS.includes(action.precision)) {
                errors.push(`${path}.precision: must be one of: ${PRECISIONS.join(', ')}`);
            }
        });
        if (isObject(snapshot.knowledgeCutoff) && snapshot.knowledgeCutoff.visibleThroughActionSeq !== undefined) {
            const declared = snapshot.knowledgeCutoff.visibleThroughActionSeq;
            if ((declared ?? null) !== maxSeq) {
                errors.push('snapshot.knowledgeCutoff.visibleThroughActionSeq: must equal the last prior action seq (or null when none)');
            }
        }
    }

    // state (불변조건 5·9)
    let optionActions = new Set();
    if (!isObject(snapshot.state)) {
        errors.push('snapshot.state: object required');
    } else {
        const state = snapshot.state;
        checkKeys(state, STATE_KEYS, 'snapshot.state', errors);
        for (const key of ['potBeforeAction', 'currentBetTo', 'heroCommittedThisStreet', 'toCall',
            'minRaiseTo', 'maxRaiseTo', 'heroStackBefore', 'heroSprBefore']) {
            if (!isNullableAmount(state[key])) errors.push(`snapshot.state.${key}: amount or null required`);
        }
        if (!PRECISIONS.includes(state.potPrecision)) {
            errors.push(`snapshot.state.potPrecision: must be one of: ${PRECISIONS.join(', ')}`);
        }
        if (state.potOddsRequiredPct !== null
            && (!isAmount(state.potOddsRequiredPct) || state.potOddsRequiredPct > 100)) {
            errors.push('snapshot.state.potOddsRequiredPct: number between 0 and 100 or null required');
        }
        if (!Array.isArray(state.contestablePots)) {
            errors.push('snapshot.state.contestablePots: array required');
        } else {
            state.contestablePots.forEach((pot, index) => {
                const path = `snapshot.state.contestablePots[${index}]`;
                if (!isObject(pot)) { errors.push(`${path}: object required`); return; }
                checkKeys(pot, POT_KEYS, path, errors);
                if (typeof pot.potId !== 'string' || !pot.potId.trim()) errors.push(`${path}.potId: non-empty string required`);
                if (!isAmount(pot.amount)) errors.push(`${path}.amount: amount required`);
                if (!Array.isArray(pot.eligiblePlayerIds) || pot.eligiblePlayerIds.length === 0) {
                    errors.push(`${path}.eligiblePlayerIds: non-empty array required`);
                } else {
                    pot.eligiblePlayerIds.forEach((id, idIndex) => {
                        const okId = checkPlayerId(id, `${path}.eligiblePlayerIds[${idIndex}]`, errors);
                        if (okId && playerIds.size > 0 && !playerIds.has(okId)) {
                            errors.push(`${path}.eligiblePlayerIds[${idIndex}]: player outside snapshot.players`);
                        }
                    });
                }
            });
        }
        if (!Array.isArray(state.legalOptions) || state.legalOptions.length === 0) {
            errors.push('snapshot.state.legalOptions: non-empty array required');
        } else {
            state.legalOptions.forEach((option, index) => {
                const path = `snapshot.state.legalOptions[${index}]`;
                if (!isObject(option)) { errors.push(`${path}: object required`); return; }
                checkKeys(option, OPTION_KEYS, path, errors);
                if (!LEGAL_OPTION_ACTIONS.includes(option.action)) {
                    errors.push(`${path}.action: must be one of: ${LEGAL_OPTION_ACTIONS.join(', ')}`);
                    return;
                }
                if (optionActions.has(option.action)) errors.push(`${path}.action: duplicate legal option`);
                optionActions.add(option.action);
                if (option.action === 'call' || option.action === 'all-in') {
                    if (option.amountAdded !== undefined && !isNullableAmount(option.amountAdded)) {
                        errors.push(`${path}.amountAdded: amount or null required`);
                    }
                    if (option.minTo !== undefined || option.maxTo !== undefined) {
                        errors.push(`${path}: minTo/maxTo are only allowed on bet/raise options`);
                    }
                    if (option.action === 'call' && (option.amountAdded ?? null) !== (state.toCall ?? null)) {
                        errors.push(`${path}.amountAdded: must equal state.toCall (authoritative replay bound)`);
                    }
                } else if (option.action === 'bet' || option.action === 'raise') {
                    if (!isNullableAmount(option.minTo) || !isNullableAmount(option.maxTo)) {
                        errors.push(`${path}: minTo/maxTo amounts or null required`);
                    }
                    if (option.amountAdded !== undefined) {
                        errors.push(`${path}.amountAdded: only allowed on call/all-in options`);
                    }
                    if ((option.minTo ?? null) !== (state.minRaiseTo ?? null)) {
                        errors.push(`${path}.minTo: must equal state.minRaiseTo (authoritative replay bound)`);
                    }
                    if ((option.maxTo ?? null) !== (state.maxRaiseTo ?? null)) {
                        errors.push(`${path}.maxTo: must equal state.maxRaiseTo (authoritative replay bound)`);
                    }
                    if (isAmount(option.minTo) && isAmount(option.maxTo) && option.minTo > option.maxTo) {
                        errors.push(`${path}: minTo must not exceed maxTo`);
                    }
                } else if (option.amountAdded !== undefined || option.minTo !== undefined || option.maxTo !== undefined) {
                    errors.push(`${path}: fold/check options carry no amounts`);
                }
            });
        }
    }

    // actualAction — legal option 안에 있어야 한다 (all-in은 resolved type으로 저장됨).
    if (!isObject(snapshot.actualAction)) {
        errors.push('snapshot.actualAction: object required');
    } else {
        const actual = snapshot.actualAction;
        checkKeys(actual, ACTUAL_KEYS, 'snapshot.actualAction', errors);
        if (!RECORDED_ACTIONS.includes(actual.action)) {
            errors.push(`snapshot.actualAction.action: must be one of: ${RECORDED_ACTIONS.join(', ')}`);
        } else if (optionActions.size > 0
            && !optionActions.has(actual.action)
            && !(actual.isAllIn === true && optionActions.has('all-in'))) {
            errors.push('snapshot.actualAction.action: must be a legal option at this decision');
        }
        if (!isNullableAmount(actual.amountTo)) errors.push('snapshot.actualAction.amountTo: amount or null required');
        if (!isNullableAmount(actual.amountAdded)) errors.push('snapshot.actualAction.amountAdded: amount or null required');
        if (typeof actual.isAllIn !== 'boolean') errors.push('snapshot.actualAction.isAllIn: boolean required');
        if (!PRECISIONS.includes(actual.precision)) {
            errors.push(`snapshot.actualAction.precision: must be one of: ${PRECISIONS.join(', ')}`);
        }
    }

    // opponentModelRef (불변조건 7: 현재 핸드 이전 자료만)
    if (snapshot.opponentModelRef !== null) {
        if (!isObject(snapshot.opponentModelRef)) {
            errors.push('snapshot.opponentModelRef: object or null required');
        } else {
            const ref = snapshot.opponentModelRef;
            checkKeys(ref, OPPONENT_REF_KEYS, 'snapshot.opponentModelRef', errors);
            if (typeof ref.modelId !== 'string' || !ref.modelId.trim()) {
                errors.push('snapshot.opponentModelRef.modelId: non-empty string required');
            }
            if (ref.asOfHandId !== null && (typeof ref.asOfHandId !== 'string' || !ref.asOfHandId.trim())) {
                errors.push('snapshot.opponentModelRef.asOfHandId: non-empty string or null required');
            }
            if (ref.asOfHandId !== null && ref.asOfHandId === snapshot.handId) {
                errors.push('snapshot.opponentModelRef.asOfHandId: must not include the current hand (future information)');
            }
            if (ref.includedHands !== null && (!Number.isInteger(ref.includedHands) || ref.includedHands < 0)) {
                errors.push('snapshot.opponentModelRef.includedHands: non-negative integer or null required');
            }
        }
    }

    // dataQuality (불변조건 10의 근거)
    if (!isObject(snapshot.dataQuality)) {
        errors.push('snapshot.dataQuality: object required');
    } else {
        const quality = snapshot.dataQuality;
        checkKeys(quality, QUALITY_KEYS, 'snapshot.dataQuality', errors);
        if (!PRECISIONS.includes(quality.overall)) {
            errors.push(`snapshot.dataQuality.overall: must be one of: ${PRECISIONS.join(', ')}`);
        }
        for (const key of ['unknownFields', 'estimatedFields', 'validationErrors']) {
            if (!Array.isArray(quality[key]) || quality[key].some(item => typeof item !== 'string' || !item.trim())) {
                errors.push(`snapshot.dataQuality.${key}: array of non-empty strings required`);
            }
        }
    }

    // provenance (불변조건 8)
    if (!isObject(snapshot.provenance)) {
        errors.push('snapshot.provenance: object required');
    } else {
        const provenance = snapshot.provenance;
        checkKeys(provenance, PROVENANCE_KEYS, 'snapshot.provenance', errors);
        if (typeof provenance.source !== 'string' || !provenance.source.trim()) {
            errors.push('snapshot.provenance.source: non-empty string required');
        }
        if (!Number.isInteger(provenance.sourceSchemaVersion) || provenance.sourceSchemaVersion < 1) {
            errors.push('snapshot.provenance.sourceSchemaVersion: positive integer required');
        }
        if (typeof provenance.snapshotBuilderVersion !== 'string'
            || !/^\d+\.\d+\.\d+$/.test(provenance.snapshotBuilderVersion)) {
            errors.push('snapshot.provenance.snapshotBuilderVersion: semantic version required');
        }
        if (typeof provenance.inputHash !== 'string' || !INPUT_HASH_PATTERN.test(provenance.inputHash)) {
            errors.push('snapshot.provenance.inputHash: sha256:<64 hex> required');
        }
    }

    return { ok: errors.length === 0, errors };
}

/**
 * 불변조건 10: replay validation error가 있는 snapshot은 전략 analyzer를 호출하면 안 된다.
 * gateway가 이 함수로 분기한다.
 */
export function isAnalyzableSnapshot(snapshot) {
    return validateDecisionSnapshot(snapshot).ok
        && snapshot.dataQuality.validationErrors.length === 0;
}

/**
 * 불변조건 8 검증: provenance.inputHash를 (inputHash와 requestId를 제외한) canonical snapshot에서
 * 재계산해 일치하는지 확인한다. requestId는 gateway가 해시 이후에 붙일 수 있으므로 해시 밖이다.
 * @param {object} snapshot
 * @returns {Promise<boolean>}
 */
export async function verifySnapshotInputHash(snapshot) {
    if (!isObject(snapshot) || !isObject(snapshot.provenance)) return false;
    const declared = snapshot.provenance.inputHash;
    if (typeof declared !== 'string') return false;
    const clone = { ...snapshot, provenance: { ...snapshot.provenance } };
    delete clone.requestId;
    delete clone.provenance.inputHash;
    return (await computeInputHash(clone)) === declared;
}

/**
 * 이 snapshot에서 설명이 인용할 수 있는 결정론적 fact reference 목록.
 * (detailedReview의 derivedFactRefs와 같은 원칙 — null인 값은 인용 불가.)
 * @param {object} snapshot 유효한 DecisionSnapshot v1
 * @returns {string[]}
 */
export function allowedFactRefsForSnapshot(snapshot) {
    const refs = ['game.variant', 'game.format', 'state.legalOptions', 'actualAction'];
    if (snapshot.game.smallBlind !== null) refs.push('game.smallBlind');
    if (snapshot.game.bigBlind !== null) refs.push('game.bigBlind');
    if (snapshot.game.straddlePosts.length > 0) refs.push('game.straddlePosts');
    if (snapshot.hero.position !== null) refs.push('hero.position');
    if (snapshot.hero.holeCards.length === 2) refs.push('hero.holeCards');
    if (snapshot.visibleBoard.length > 0) refs.push('visibleBoard');
    for (const key of ['potBeforeAction', 'currentBetTo', 'heroCommittedThisStreet', 'toCall',
        'minRaiseTo', 'maxRaiseTo', 'heroStackBefore', 'heroSprBefore', 'potOddsRequiredPct']) {
        if (snapshot.state[key] !== null) refs.push(`state.${key}`);
    }
    if (snapshot.state.contestablePots.length > 0) refs.push('state.contestablePots');
    for (const action of snapshot.priorActions) refs.push(`priorActions:${action.seq}`);
    for (const player of snapshot.players) refs.push(`players:${player.playerId}`);
    return [...new Set(refs)];
}
