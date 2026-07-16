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
