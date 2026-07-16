// DecisionSnapshot v1 빌더 (연구 기준서 §15.1, §16.1)
// 지식 컷오프는 detailedReview.prefixHandForDecision을 재사용한다 (컷오프 알고리즘 단일 원천 —
// 여기서 절대 재구현하지 않는다). 상태는 항상 authoritative ledger의 결정 직전 replay에서 나온다.
// snapshot에는 표시 이름이 어디에도 들어가지 않는다: 좌석 이름은 pseudonyms.js의 안정적 가명 ID로 대체.

import {
    deriveDetailedState,
    legalDetailedActions,
    deriveSidePots,
} from '../../engine/detailedHandEngine.js';
import {
    DETAILED_STREETS as STREETS,
    DETAILED_ACTION_TYPES as RECORDED_ACTIONS,
    DETAILED_PRECISIONS as PRECISIONS,
} from '../../engine/schema.js';
import { prefixHandForDecision } from '../../services/detailedReview.js';
import { pseudonymFor } from '../pseudonyms.js';
import { computeInputHash } from '../hash.js';
import {
    DECISION_SNAPSHOT_SCHEMA_VERSION,
    SNAPSHOT_SOURCE,
    validateDecisionSnapshot,
} from '../contracts/decisionSnapshot.js';

export const SNAPSHOT_BUILDER_VERSION = '1.0.0';
const STREET_BOARD_COUNTS = { preflop: 0, flop: 3, turn: 4, river: 5 };

function fail(path, message) {
    throw new TypeError(`${path}: ${message}`);
}

function finiteAmount(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function nullableAmount(value) {
    return finiteAmount(value) ? value : null;
}

function round(value, digits = 4) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    const scale = 10 ** digits;
    return Math.round(value * scale) / scale;
}

function normalizeStreet(value) {
    const street = typeof value === 'string' ? value.toLowerCase() : 'preflop';
    return STREETS.includes(street) ? street : 'preflop';
}

function flattenBoard(board) {
    const source = board && typeof board === 'object' ? board : {};
    return [
        ...(Array.isArray(source.flop) ? source.flop : []),
        ...(Array.isArray(source.turn) ? source.turn : []),
        ...(Array.isArray(source.river) ? source.river : []),
    ];
}

// 결정 직전 pot (해당 액션 자신의 칩은 제외) — potFraction 분모용.
function potBeforeAction(hand, action) {
    const prefix = prefixHandForDecision(hand, action.seq, normalizeStreet(action.street));
    return deriveDetailedState(prefix).pot;
}

function estimatedFieldsFor(state, players) {
    const fields = [];
    if (state.potQuality === 'estimated') fields.push('state.potBeforeAction');
    if (state.stackQuality === 'estimated') fields.push('state.heroStackBefore');
    for (const player of players) {
        if (player.stackPrecision === 'estimated') fields.push(`players:${player.playerId}.stackBefore`);
    }
    return fields;
}

function unknownFieldsFor(state, heroState, heroCards, visibleBoard, street) {
    const unknown = ['game.rake']; // 수동 기록에는 레이크 정보가 없다 (§15.1 예시와 동일).
    if (state.pot === null) unknown.push('state.potBeforeAction');
    if (state.toCall === null) unknown.push('state.toCall');
    if (!heroState || heroState.stack === null) unknown.push('state.heroStackBefore');
    if (heroCards.length !== 2) unknown.push('hero.holeCards');
    if (visibleBoard.length !== STREET_BOARD_COUNTS[street]) unknown.push('visibleBoard');
    if (state.validationErrors.length > 0) unknown.push('state.replayValidation');
    return unknown;
}

/**
 * 완료(또는 부분 진행) 상세 핸드에서 Hero 결정 하나의 DecisionSnapshot v1을 만든다.
 * 상태는 decisionSeq 미만의 액션만으로 replay되며, 미래 액션·보드·쇼다운·승자는
 * prefixHandForDecision이 구조적으로 제거한다.
 *
 * @param {object} completedHandRecord detailed tracking이 켜진 HandRecord
 * @param {number} decisionSeq 분석할 Hero 액션의 seq
 * @param {object} [options]
 * @param {object} [options.opponentStatsAsOf] 결정 이전 자료로 만든 상대 모델 참조
 *   ({modelId?, asOfHandId?, includedHands?} — 현재 핸드를 포함하면 거부)
 * @param {string} [options.salt] 가명화 salt (pseudonyms.js와 동일 규칙)
 * @returns {Promise<object>} decision-snapshot.v1 객체 (provenance.inputHash 포함)
 */
export async function buildDecisionSnapshot(completedHandRecord, decisionSeq, { opponentStatsAsOf, salt = '' } = {}) {
    const hand = completedHandRecord;
    if (!hand || typeof hand !== 'object') fail('hand', 'object required');
    if (!hand.detailed?.enabled) fail('hand.detailed.enabled', 'detailed tracking must be enabled');
    if (!Array.isArray(hand.seats) || hand.seats.length < 2) fail('hand.seats', 'at least two seats required');
    if (!Array.isArray(hand.actions)) fail('hand.actions', 'array required');
    if (!Number.isInteger(decisionSeq) || decisionSeq < 0) fail('decisionSeq', 'non-negative integer required');
    if (typeof hand.id !== 'string' || !hand.id.trim()) fail('hand.id', 'non-empty string required');
    const sourceAnte = hand.blinds?.ante ?? hand.ante ?? 0;
    if (sourceAnte !== 0) fail('hand.ante', 'ante is not supported by the deterministic replay engine');

    const heroSeat = hand.detailed.heroSeat;
    if (!Number.isInteger(heroSeat)) fail('hand.detailed.heroSeat', 'integer hero seat required');
    const heroSeatRecord = hand.seats.find(seat => seat?.seat === heroSeat && !seat.sittingOut);
    if (!heroSeatRecord) fail('hand.detailed.heroSeat', 'must identify an active seat');

    const rawActual = hand.actions.find(action => action?.seq === decisionSeq);
    if (!rawActual) fail('decisionSeq', 'decision action was not found in hand.actions');
    if (rawActual.seat !== heroSeat) fail('decisionSeq', 'decision action must belong to hero');
    if (!RECORDED_ACTIONS.includes(rawActual.type)) fail('decisionSeq', 'resolved detailed action required');
    const street = normalizeStreet(rawActual.street);

    // 지식 컷오프: 단일 원천 재사용. 이후의 모든 상태는 이 prefix에서만 나온다.
    const prefixHand = prefixHandForDecision(hand, decisionSeq, street);
    const state = deriveDetailedState(prefixHand);
    const legal = legalDetailedActions(prefixHand, heroSeat);
    if (legal.length === 0) {
        fail('decisionSeq', 'replay found no legal hero action at the cutoff (ledger disagreement)');
    }
    if (!legal.includes(rawActual.type) && !(rawActual.isAllIn && legal.includes('all-in'))) {
        fail('decisionSeq', 'actual action is not legal at the replayed cutoff state');
    }

    // 가명화: 좌석 이름 → 안정적 가명 ID. 이름이 없으면 좌석 기반 ID로 대체.
    const playerIdBySeat = new Map(hand.seats.map(seat => [
        seat?.seat,
        pseudonymFor(seat?.name, salt) ?? `seat:${seat?.seat}`,
    ]));
    const heroPlayerId = playerIdBySeat.get(heroSeat);

    const heroState = state.players.find(player => player.seat === heroSeat) ?? null;
    const heroCards = Array.isArray(hand.detailed.heroCards) ? [...hand.detailed.heroCards] : [];
    const visibleBoard = flattenBoard(prefixHand.detailed.board);

    const players = state.players
        .filter(player => player.active)
        .map(player => ({
            playerId: playerIdBySeat.get(player.seat),
            seat: player.seat,
            position: player.position ?? null,
            startingStack: nullableAmount(player.startingStack),
            stackBefore: nullableAmount(player.stack),
            stackPrecision: PRECISIONS.includes(player.stackPrecision) ? player.stackPrecision : 'unknown',
            folded: !!player.folded,
            allIn: !!player.allIn,
        }))
        .sort((a, b) => a.seat - b.seat);

    const priorActions = prefixHand.actions
        .map(action => {
            if (!RECORDED_ACTIONS.includes(action?.type)) {
                fail(`hand.actions[seq=${action?.seq}]`, 'resolved detailed action required');
            }
            const amountAdded = nullableAmount(action.amountAdded);
            const potBefore = potBeforeAction(hand, action);
            return {
                seq: action.seq,
                street: normalizeStreet(action.street),
                playerId: playerIdBySeat.get(action.seat) ?? `seat:${action.seat}`,
                action: action.type,
                amountTo: nullableAmount(action.amountTo),
                amountAdded,
                potFraction: amountAdded !== null && amountAdded > 0 && finiteAmount(potBefore) && potBefore > 0
                    ? round(amountAdded / potBefore)
                    : null,
                isAllIn: !!action.isAllIn,
                precision: PRECISIONS.includes(action.precision) ? action.precision : 'unknown',
            };
        })
        .sort((a, b) => a.seq - b.seq);

    const straddlePosts = state.forcedPosts
        .filter(post => post.type === 'straddle')
        .map(post => ({
            seat: post.seat,
            playerId: playerIdBySeat.get(post.seat) ?? `seat:${post.seat}`,
            amount: nullableAmount(post.amount),
        }));

    const sidePots = deriveSidePots(prefixHand);
    const contestablePots = sidePots.pots.map(pot => ({
        potId: pot.type === 'main' ? 'main' : `side:${pot.index}`,
        amount: pot.amount,
        eligiblePlayerIds: pot.eligibleSeats.map(seat => playerIdBySeat.get(seat) ?? `seat:${seat}`),
    }));

    // hero stack cap: exact stack일 때만 확정 상한 (estimated stack은 상한이 아님 — 엔진과 동일 원칙).
    const maxRaiseTo = heroState && heroState.stackPrecision === 'exact'
        && finiteAmount(heroState.stack) && finiteAmount(heroState.streetCommitted)
        ? heroState.streetCommitted + heroState.stack
        : null;
    const minRaiseTo = nullableAmount(state.minRaiseTo);

    const legalOptions = legal
        .map(action => {
            if (action === 'call') return { action, amountAdded: nullableAmount(state.toCall) };
            if (action === 'bet' || action === 'raise') {
                // 최소 풀레이즈조차 스택 상한을 넘는 경우 그 옵션은 (올인 외에는) 실행 불가 —
                // 모순된 bound를 계약에 싣지 않고 옵션을 내린다. all-in 옵션이 남는다.
                if (minRaiseTo !== null && maxRaiseTo !== null && minRaiseTo > maxRaiseTo) return null;
                return { action, minTo: minRaiseTo, maxTo: maxRaiseTo };
            }
            if (action === 'all-in') {
                return {
                    action,
                    amountAdded: heroState && heroState.stackPrecision === 'exact'
                        ? nullableAmount(heroState.stack)
                        : null,
                };
            }
            return { action };
        })
        .filter(Boolean);

    const potOddsRequiredPct = state.pot !== null && state.toCall !== null && state.pot + state.toCall > 0
        ? round((state.toCall / (state.pot + state.toCall)) * 100)
        : null;
    const heroSprBefore = state.pot !== null && state.pot > 0 && finiteAmount(heroState?.stack)
        ? round(heroState.stack / state.pot)
        : null;

    let opponentModelRef = null;
    if (opponentStatsAsOf !== undefined && opponentStatsAsOf !== null) {
        if (typeof opponentStatsAsOf !== 'object' || Array.isArray(opponentStatsAsOf)) {
            fail('options.opponentStatsAsOf', 'object required');
        }
        const asOfHandId = opponentStatsAsOf.asOfHandId ?? null;
        if (asOfHandId === hand.id) {
            fail('options.opponentStatsAsOf.asOfHandId', 'must not include the current hand (future information)');
        }
        const modelId = typeof opponentStatsAsOf.modelId === 'string' && opponentStatsAsOf.modelId.trim()
            ? opponentStatsAsOf.modelId.trim()
            : `opponent-model:${(await computeInputHash(opponentStatsAsOf)).slice('sha256:'.length, 'sha256:'.length + 16)}`;
        opponentModelRef = {
            modelId,
            asOfHandId,
            includedHands: Number.isInteger(opponentStatsAsOf.includedHands) && opponentStatsAsOf.includedHands >= 0
                ? opponentStatsAsOf.includedHands
                : null,
        };
    }

    const prefixSeqs = priorActions.map(action => action.seq);
    const snapshot = {
        schemaVersion: DECISION_SNAPSHOT_SCHEMA_VERSION,
        handId: hand.id,
        decisionId: `${hand.id}:seq:${decisionSeq}`,
        analysisContext: 'post_hand',
        knowledgeCutoff: {
            decisionSeq,
            street,
            visibleThroughActionSeq: prefixSeqs.length > 0 ? Math.max(...prefixSeqs) : null,
        },
        game: {
            variant: 'NLHE',
            format: 'cash',
            currencyMode: null,
            chipUnit: finiteAmount(hand.detailed.chipUnit) && hand.detailed.chipUnit > 0
                ? hand.detailed.chipUnit
                : null,
            smallBlind: nullableAmount(hand.blinds?.sb),
            bigBlind: nullableAmount(hand.blinds?.bb),
            ante: 0,
            rake: null,
            dealerSeat: Number.isInteger(hand.dealerSeat) && hand.dealerSeat >= 0 ? hand.dealerSeat : null,
            straddlePosts,
        },
        hero: {
            playerId: heroPlayerId,
            seat: heroSeat,
            position: heroSeatRecord.position ?? null,
            holeCards: heroCards,
        },
        players,
        visibleBoard,
        priorActions,
        state: {
            potBeforeAction: nullableAmount(state.pot),
            potPrecision: state.potQuality,
            contestablePots,
            currentBetTo: nullableAmount(state.currentBet),
            heroCommittedThisStreet: nullableAmount(heroState?.streetCommitted),
            toCall: nullableAmount(state.toCall),
            minRaiseTo,
            maxRaiseTo,
            heroStackBefore: nullableAmount(heroState?.stack),
            heroSprBefore,
            potOddsRequiredPct,
            legalOptions,
        },
        opponentModelRef,
        actualAction: {
            action: rawActual.type,
            amountTo: nullableAmount(rawActual.amountTo),
            amountAdded: nullableAmount(rawActual.amountAdded),
            isAllIn: !!rawActual.isAllIn,
            precision: PRECISIONS.includes(rawActual.precision) ? rawActual.precision : 'unknown',
        },
        dataQuality: {
            overall: state.validationErrors.length > 0 ? 'unknown' : state.quality,
            unknownFields: unknownFieldsFor(state, heroState, heroCards, visibleBoard, street),
            estimatedFields: estimatedFieldsFor(state, players),
            validationErrors: [...state.validationErrors],
        },
        provenance: {
            source: SNAPSHOT_SOURCE,
            sourceSchemaVersion: 2,
            snapshotBuilderVersion: SNAPSHOT_BUILDER_VERSION,
            // inputHash는 아래에서 canonical(snapshot minus inputHash)로 채운다 (불변조건 8).
        },
    };

    const inputHash = await computeInputHash(snapshot);
    const complete = {
        ...snapshot,
        provenance: { ...snapshot.provenance, inputHash },
    };

    // 자기 검증: 빌더 출력이 계약을 어기면 조용히 내보내지 않고 즉시 실패한다.
    const check = validateDecisionSnapshot(complete);
    if (!check.ok) fail('snapshot', `builder produced a contract violation: ${check.errors.join('; ')}`);
    return complete;
}
