// 순수 핸드 상태 머신 (docs/REBUILD_DESIGN.md §3 — E1)
// React·DOM·storage import 금지. schema.js만 의존.

import { createAction } from './schema.js';

// ---------------------------------------------------------------------------
// 내부 헬퍼
// ---------------------------------------------------------------------------

/** 액티브(!sittingOut) 좌석을 seat 번호 오름차순으로 반환 */
function activeSorted(seats) {
    return seats
        .filter(s => !s.sittingOut)
        .slice()
        .sort((a, b) => a.seat - b.seat);
}

/** 액티브 배열에서 딜러 인덱스. 딜러가 액티브가 아니면 딜러 다음 첫 액티브 좌석을 BTN으로 간주(방어). */
function dealerIndexIn(active, dealerSeat) {
    const idx = active.findIndex(s => s.seat === dealerSeat);
    if (idx !== -1) return idx;
    const after = active.findIndex(s => s.seat > dealerSeat);
    return after !== -1 ? after : 0;
}

// 구 getPosNameFromDist 표 준용 (설계 계약 §3):
// dist 0=BTN, 1=SB, 2=BB / 4인 dist3=CO / 5인 UTG,CO / 6인 UTG,HJ,CO /
// 7인 UTG,LJ,HJ,CO / 8인 +UTG+1 / 9인 +UTG+2. HU: 딜러='BTN'(SB 겸), 상대='BB'.
const POSITION_TABLE = {
    4: { 3: 'CO' },
    5: { 3: 'UTG', 4: 'CO' },
    6: { 3: 'UTG', 4: 'HJ', 5: 'CO' },
    7: { 3: 'UTG', 4: 'LJ', 5: 'HJ', 6: 'CO' },
    8: { 3: 'UTG', 4: 'UTG+1', 5: 'LJ', 6: 'HJ', 7: 'CO' },
    9: { 3: 'UTG', 4: 'UTG+1', 5: 'UTG+2', 6: 'LJ', 7: 'HJ', 8: 'CO' },
};

/** 딜러로부터의 액티브 거리(dist)와 액티브 인원(t)으로 포지션 이름 */
function positionFromDist(dist, t) {
    if (t === 2) return dist === 0 ? 'BTN' : 'BB'; // HU: 딜러가 SB 겸 BTN
    if (dist === 0) return 'BTN';
    if (dist === 1) return 'SB';
    if (dist === 2) return 'BB';
    return (POSITION_TABLE[t] && POSITION_TABLE[t][dist]) || null;
}

/**
 * 액티브 좌석 중 fromSeat 다음 차례(좌석 번호 순환 순서)에서
 * 폴드하지 않은 첫 좌석을 반환. 없으면 null.
 */
function nextEligibleSeat(active, fromSeat, foldedSeats) {
    const t = active.length;
    if (t === 0) return null;
    // fromSeat 바로 다음 위치부터 순환 탐색
    let startIdx = active.findIndex(s => s.seat > fromSeat);
    if (startIdx === -1) startIdx = 0;
    for (let i = 0; i < t; i++) {
        const cand = active[(startIdx + i) % t];
        if (cand.seat === fromSeat) continue;
        if (!foldedSeats.has(cand.seat)) return cand.seat;
    }
    return null;
}

// ---------------------------------------------------------------------------
// 공개 API
// ---------------------------------------------------------------------------

/**
 * 핸드의 좌석별 포지션 계산.
 * @param {Array<{seat:number, sittingOut:boolean}>} seats 좌석 배열 (0-based seat)
 * @param {number} dealerSeat 딜러 좌석 번호
 * @returns {Map<number, string|null>} 좌석 → 포지션 (sittingOut·인원 부족이면 null)
 */
export function positionsForHand(seats, dealerSeat) {
    const map = new Map();
    for (const s of seats) map.set(s.seat, null);

    const active = activeSorted(seats);
    const t = active.length;
    if (t < 2) return map; // 2인 미만이면 포지션 없음

    const dIdx = dealerIndexIn(active, dealerSeat);
    active.forEach((s, i) => {
        const dist = (i - dIdx + t) % t;
        map.set(s.seat, positionFromDist(dist, t));
    });
    return map;
}

/**
 * 언레이즈 팟에서 체크 권리를 가진 좌석.
 * 스트래들 없으면 BB, 있으면 마지막 스트래들 좌석(BB 다음 straddleCount번째 액티브 좌석).
 * @param {Array<{seat:number, sittingOut:boolean}>} seats
 * @param {number} dealerSeat
 * @param {number} straddleCount 스트래들 수 (0이면 없음)
 * @returns {number|null} 좌석 번호 (액티브 2인 미만이면 null)
 */
export function lastOptionSeat(seats, dealerSeat, straddleCount) {
    const active = activeSorted(seats);
    const t = active.length;
    if (t < 2) return null;

    const dIdx = dealerIndexIn(active, dealerSeat);
    const bbDist = t === 2 ? 1 : 2; // HU: 딜러=SB, 상대=BB
    const sc = straddleCount || 0;
    return active[(dIdx + bbDist + sc) % t].seat;
}

/**
 * 프리플랍 첫 액션 좌석 = lastOption 다음 액티브 좌석.
 * HU(액티브 2인): 딜러가 먼저 액션.
 * @param {Array<{seat:number, sittingOut:boolean}>} seats
 * @param {number} dealerSeat
 * @param {number} straddleCount
 * @returns {number|null}
 */
export function firstToActSeat(seats, dealerSeat, straddleCount) {
    const active = activeSorted(seats);
    const t = active.length;
    if (t < 2) return null;

    const lastOpt = lastOptionSeat(seats, dealerSeat, straddleCount);
    const loIdx = active.findIndex(s => s.seat === lastOpt);
    return active[(loIdx + 1) % t].seat;
}

/**
 * 핸드 레코드의 액션 배열을 리플레이해 현재 상태를 파생.
 * 스트래들은 레이즈가 아니다 (raiseCount 불포함).
 * isOver: actedSinceLastRaise가 폴드 안 한 액티브 전원을 포함하면 종료.
 *         raise가 나오면 set을 {레이저}로 리셋. 폴드로 1명만 남아도 종료(endedByFold).
 * @param {object} hand HandRecord
 * @returns {{ toActSeat:number|null, raiseCount:number, lastAggressorSeat:number|null,
 *             limperCount:number, foldedSeats:Set<number>, actedSinceLastRaise:Set<number>,
 *             isOver:boolean, endedByFold:boolean }}
 */
export function deriveHandState(hand) {
    const active = activeSorted(hand.seats);
    const foldedSeats = new Set();
    let actedSinceLastRaise = new Set();
    let raiseCount = 0;
    let limperCount = 0;
    let lastAggressorSeat = null;
    let isOver = false;
    let endedByFold = false;
    let toActSeat = firstToActSeat(hand.seats, hand.dealerSeat, hand.straddleCount);

    // 폴드 안 한 액티브 전원이 마지막 레이즈 이후 액션했는지 판정
    const evaluateOver = () => {
        const remaining = active.filter(s => !foldedSeats.has(s.seat));
        if (remaining.length <= 1) {
            isOver = true;
            endedByFold = foldedSeats.size > 0;
            return;
        }
        if (remaining.every(s => actedSinceLastRaise.has(s.seat))) {
            isOver = true;
            endedByFold = false;
        }
    };

    evaluateOver(); // 액티브 2인 미만이면 액션 없이도 종료 상태
    if (isOver) toActSeat = null;

    for (const a of hand.actions) {
        if (isOver) break; // 종료 후 남은 액션은 무시 (방어)
        const inTurn = a.seat === toActSeat; // 아웃오브턴 액션 = forceFold(자리 비움)

        switch (a.type) {
            case 'fold':
                foldedSeats.add(a.seat);
                actedSinceLastRaise.add(a.seat);
                break;
            case 'check':
                actedSinceLastRaise.add(a.seat);
                break;
            case 'call':
                if (raiseCount === 0) limperCount += 1;
                actedSinceLastRaise.add(a.seat);
                break;
            case 'raise':
                raiseCount += 1;
                lastAggressorSeat = a.seat;
                actedSinceLastRaise = new Set([a.seat]); // 레이즈 시 {레이저}로 리셋
                break;
            default:
                break;
        }

        evaluateOver();
        if (isOver) {
            toActSeat = null;
        } else if (inTurn) {
            // 인턴 액션만 차례를 진행시킨다: 폴드·싯아웃 좌석 건너뛰기
            toActSeat = nextEligibleSeat(active, a.seat, foldedSeats);
        } else if (toActSeat !== null && foldedSeats.has(toActSeat)) {
            // 방어: 아웃오브턴 폴드로 기대 차례 좌석이 죽었으면 다음 적격 좌석으로
            toActSeat = nextEligibleSeat(active, toActSeat, foldedSeats);
        }
        // 그 외 아웃오브턴 폴드는 차례를 바꾸지 않는다 (기존 toActSeat 유지)
    }

    return {
        toActSeat,
        raiseCount,
        lastAggressorSeat,
        limperCount,
        foldedSeats,
        actedSinceLastRaise,
        isOver,
        endedByFold,
    };
}

/** SB 좌석 (HU에서는 딜러가 SB 겸 BTN). 액티브 2인 미만이면 null. */
function smallBlindSeat(seats, dealerSeat) {
    const active = activeSorted(seats);
    const t = active.length;
    if (t < 2) return null;
    const dIdx = dealerIndexIn(active, dealerSeat);
    return active[(dIdx + (t === 2 ? 0 : 1)) % t].seat;
}

/**
 * 언레이즈 팟에서 SB의 강제 포스트가 현재 베팅 레벨(bb × 2^straddleCount)을 이미
 * 채웠는가 — sb===bb(이퀄 블라인드) 게임 등. 상세 엔진의 칩 기준(toCall===0) 판정과
 * 같은 결론을 내리기 위한 규칙: 추가 칩이 없는 계속은 call이 아니라 check다.
 */
function smallBlindCoversUnraisedBet(hand, seat) {
    const blinds = hand.blinds;
    const sb = blinds && typeof blinds.sb === 'number' && Number.isFinite(blinds.sb) ? blinds.sb : null;
    const bb = blinds && typeof blinds.bb === 'number' && Number.isFinite(blinds.bb) ? blinds.bb : null;
    if (sb === null || bb === null) return false;
    const unraisedBet = bb * 2 ** (hand.straddleCount || 0);
    return sb >= unraisedBet && seat === smallBlindSeat(hand.seats, hand.dealerSeat);
}

/** 파생 상태를 재사용하는 내부 구현 (applyAction에서 이중 리플레이 방지) */
function legalActionsForDerived(hand, seat, derived) {
    const seatRec = hand.seats.find(s => s.seat === seat);
    if (!seatRec || seatRec.sittingOut) return [];
    if (derived.isOver) return [];
    if (derived.foldedSeats.has(seat)) return [];
    if (derived.toActSeat !== seat) return [];

    if (derived.raiseCount === 0) {
        const lastOpt = lastOptionSeat(hand.seats, hand.dealerSeat, hand.straddleCount);
        if (seat === lastOpt) return ['check', 'raise']; // 언레이즈 팟의 lastOption만 체크 가능
        if (smallBlindCoversUnraisedBet(hand, seat)) return ['check', 'raise'];
        return ['fold', 'call', 'raise'];
    }
    // raiseCount>=1: 어그레서 본인에게는 차례가 돌아오지 않으므로 셀프 리레이즈 원천 불가
    return ['fold', 'call', 'raise'];
}

/**
 * 해당 좌석의 합법 액션 목록.
 * sittingOut·폴드·핸드종료·차례아님 → [].
 * raiseCount===0: lastOption 좌석과 베팅 레벨을 이미 채운 SB(sb>=bb×2^straddle)는
 *   ['check','raise'], 그 외 ['fold','call','raise'].
 * raiseCount>=1: ['fold','call','raise'].
 * @param {object} hand HandRecord
 * @param {number} seat
 * @returns {string[]}
 */
export function legalActionsFor(hand, seat) {
    return legalActionsForDerived(hand, seat, deriveHandState(hand));
}

/**
 * 액션 적용 (불변). 불법 액션이면 원본 hand 객체를 그대로 반환.
 * raiseLevel = 액션 전 raiseCount + 1 (raise가 아니면 0). 스트래들 위 오픈도 raiseLevel 1.
 * @param {object} hand HandRecord
 * @param {number} seat
 * @param {'fold'|'check'|'call'|'raise'} type
 * @returns {object} 새 HandRecord 또는 원본(불법 시)
 */
export function applyAction(hand, seat, type) {
    const derived = deriveHandState(hand);
    const legal = legalActionsForDerived(hand, seat, derived);
    if (!legal.includes(type)) return hand;

    const seatRec = hand.seats.find(s => s.seat === seat);
    const action = createAction({
        seq: hand.actions.length,
        seat,
        name: seatRec.name,
        position: seatRec.position,
        type,
        raiseLevel: type === 'raise' ? derived.raiseCount + 1 : 0,
    });

    return {
        ...hand,
        actions: [...hand.actions, action],
    };
}

/**
 * 강제 폴드 (불변): 차례와 무관하게 fold 액션을 기록한다 — 플레이어가 테이블을 떠난 경우 전용.
 * 조건: 좌석이 핸드에 있고(!sittingOut), 아직 폴드 전이며, 핸드가 종료되지 않았을 것.
 * 조건 미충족이면 원본 hand 객체를 그대로 반환한다.
 * @param {object} hand HandRecord
 * @param {number} seat
 * @returns {object} 새 HandRecord 또는 원본(no-op 시)
 */
export function forceFold(hand, seat) {
    const seatRec = hand.seats.find(s => s.seat === seat);
    if (!seatRec || seatRec.sittingOut) return hand;

    const derived = deriveHandState(hand);
    if (derived.isOver || derived.foldedSeats.has(seat)) return hand;

    const action = createAction({
        seq: hand.actions.length,
        seat,
        name: seatRec.name,
        position: seatRec.position,
        type: 'fold',
        raiseLevel: 0,
    });

    return {
        ...hand,
        actions: [...hand.actions, action],
    };
}

/**
 * 다음 딜러 좌석 = 현재 딜러 다음 액티브 좌석 (좌석 번호 순환).
 * 액티브 좌석이 없으면 현재 딜러 유지.
 * @param {Array<{seat:number, sittingOut:boolean}>} seats
 * @param {number} dealerSeat
 * @returns {number}
 */
export function nextDealerSeat(seats, dealerSeat) {
    const active = activeSorted(seats);
    if (active.length === 0) return dealerSeat;
    const after = active.find(s => s.seat > dealerSeat);
    return after ? after.seat : active[0].seat;
}
