// gameReducer 테스트 (docs/REBUILD_DESIGN.md §6, §9) — 순수 리듀서만 검증 (storage 미사용)
import { describe, it, expect, vi } from 'vitest';
import {
    reducer,
    initialState,
    createInitialState,
    DEFAULT_BLINDS,
    canDisableDetailedTracking,
} from '../../src/state/gameReducer.js';
import { deriveHandState, lastOptionSeat } from '../../src/engine/handEngine.js';
import { deriveDetailedState } from '../../src/engine/detailedHandEngine.js';
import { isValidHandRecord } from '../../src/engine/schema.js';

// ---------------------------------------------------------------------------
// 헬퍼
// ---------------------------------------------------------------------------
// 6-max, dealer=0 → BTN=0, SB=1, BB=2, UTG=3, HJ=4, CO=5. 첫 액션은 seat 3(UTG).

const START_CFG = {
    playerCount: 6,
    blinds: { sb: 1, bb: 2 },
    currency: '$',
    startedAt: 1000,
    seatNames: ['A', 'B', 'C', 'D', 'E', 'F'],
};

function startSession(cfg = START_CFG) {
    return reducer(initialState, { type: 'START_SESSION', cfg });
}

function record(state, seat, actionType) {
    return reducer(state, { type: 'RECORD_ACTION', seat, actionType });
}

function playAll(state, moves) {
    let st = state;
    for (const [seat, actionType] of moves) st = record(st, seat, actionType);
    return st;
}

/** 폴드 돌아서 SB 림프 → BB 체크로 끝나는 풀 핸드 (액션 6개) */
function playCheckedHand(state) {
    return playAll(state, [
        [3, 'fold'], [4, 'fold'], [5, 'fold'], [0, 'fold'], [1, 'call'], [2, 'check'],
    ]);
}

// ---------------------------------------------------------------------------
// START_SESSION
// ---------------------------------------------------------------------------

describe('START_SESSION', () => {
    it('세션 생성: 좌석·블라인드·포지션·첫 핸드', () => {
        const st = startSession();
        const s = st.session;
        expect(s).not.toBeNull();
        expect(s.seats).toHaveLength(6);
        expect(s.seats.map(x => x.name)).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
        expect(s.blinds).toEqual({ sb: 1, bb: 2 });
        expect(s.currency).toBe('$');
        expect(s.dealerSeat).toBe(0);
        expect(s.straddleCount).toBe(0);
        expect(s.handNo).toBe(1);
        expect(s.hands).toEqual([]);
        expect(s.currentHand.handNo).toBe(1);
        expect(s.currentHand.actions).toEqual([]);
        expect(s.currentHand.seats.find(x => x.seat === 3).position).toBe('UTG');
        expect(st.nav[st.nav.length - 1]).toBe('game');
        expect(st.autoNext.pending).toBe(false);
    });

    it('NaN 블라인드는 기본값으로 대체', () => {
        const st = reducer(initialState, {
            type: 'START_SESSION',
            cfg: { playerCount: 6, blinds: { sb: 'abc', bb: undefined } },
        });
        expect(st.session.blinds).toEqual(DEFAULT_BLINDS);
    });

    it('playerCount NaN → 6석 기본값, 유효 블라인드는 유지', () => {
        const st = reducer(initialState, {
            type: 'START_SESSION',
            cfg: { playerCount: 'x', blinds: { sb: 1, bb: 3 } },
        });
        expect(st.session.seats).toHaveLength(6);
        expect(st.session.blinds).toEqual({ sb: 1, bb: 3 });
    });
});

// ---------------------------------------------------------------------------
// RECORD_ACTION — 풀 핸드 워크스루 + 불법 no-op
// ---------------------------------------------------------------------------

describe('RECORD_ACTION — 풀 핸드 워크스루 (6-max, 폴드 돌아 BB 체크)', () => {
    it('액션 순서·차례 진행·핸드 종료·autoNext 설정', () => {
        let st = startSession();

        const expectedToAct = [4, 5, 0, 1, 2]; // 각 액션 후 다음 차례
        const moves = [[3, 'fold'], [4, 'fold'], [5, 'fold'], [0, 'fold'], [1, 'call']];
        moves.forEach(([seat, type], i) => {
            st = record(st, seat, type);
            const d = deriveHandState(st.session.currentHand);
            expect(d.isOver).toBe(false);
            expect(d.toActSeat).toBe(expectedToAct[i]);
            expect(st.autoNext.pending).toBe(false);
        });

        st = record(st, 2, 'check'); // BB 체크로 종료
        const d = deriveHandState(st.session.currentHand);
        expect(d.isOver).toBe(true);
        expect(d.endedByFold).toBe(false);
        expect(d.toActSeat).toBeNull();
        expect(st.autoNext.pending).toBe(true);

        const actions = st.session.currentHand.actions;
        expect(actions).toHaveLength(6);
        expect(actions[0]).toMatchObject({ seat: 3, type: 'fold', position: 'UTG', raiseLevel: 0 });
        expect(actions[5]).toMatchObject({ seat: 2, type: 'check', position: 'BB' });
    });

    it('불법 액션은 no-op — 기존 state 참조 그대로 반환', () => {
        const st = startSession();
        // 차례 아님 (BTN이 첫 액션 시도)
        expect(record(st, 0, 'fold')).toBe(st);
        // 언레이즈 팟에서 lastOption 아닌 좌석의 check
        expect(record(st, 3, 'check')).toBe(st);
        // 이미 폴드한 플레이어의 재액션
        const st2 = record(st, 3, 'fold');
        expect(record(st2, 3, 'call')).toBe(st2);
        // 세션 없음
        expect(record(initialState, 3, 'fold')).toBe(initialState);
    });
});

// ---------------------------------------------------------------------------
// UNDO — 핸드 내부 + 핸드 경계 넘기
// ---------------------------------------------------------------------------

describe('UNDO', () => {
    it('핸드 내부: 마지막 액션 제거 + autoNext 취소', () => {
        let st = startSession();
        st = record(st, 3, 'raise');
        expect(st.session.currentHand.actions).toHaveLength(1);
        st = reducer(st, { type: 'UNDO' });
        expect(st.session.currentHand.actions).toHaveLength(0);
        expect(st.autoNext.pending).toBe(false);
    });

    it('핸드 종료 직후 UNDO는 autoNext를 취소하고 마지막 액션을 되돌린다', () => {
        let st = playCheckedHand(startSession());
        expect(st.autoNext.pending).toBe(true);
        st = reducer(st, { type: 'UNDO' });
        expect(st.autoNext.pending).toBe(false);
        expect(st.session.currentHand.actions).toHaveLength(5);
        expect(deriveHandState(st.session.currentHand).toActSeat).toBe(2);
    });

    it('핸드 경계 넘기: 완료 핸드 pop → dealer/straddle/handNo 복원 + 마지막 액션 제거', () => {
        let st = playCheckedHand(startSession());
        st = reducer(st, { type: 'NEXT_HAND', endedAt: 2000 });
        expect(st.session.hands).toHaveLength(1);
        expect(st.session.hands[0].endedAt).toBe(2000);
        expect(st.session.handNo).toBe(2);
        expect(st.session.dealerSeat).toBe(1);

        // 스트래들을 바꿔 복원 여부를 검증
        st = reducer(st, { type: 'CYCLE_STRADDLE' });
        expect(st.session.straddleCount).toBe(1);
        expect(st.session.currentHand.straddleCount).toBe(1);

        st = reducer(st, { type: 'UNDO' }); // currentHand 비어 있음 → 경계 넘기
        expect(st.session.hands).toHaveLength(0);
        expect(st.session.handNo).toBe(1);
        expect(st.session.dealerSeat).toBe(0);        // 핸드 1의 딜러 복원
        expect(st.session.straddleCount).toBe(0);     // 핸드 1의 스트래들 복원
        expect(st.session.currentHand.endedAt).toBeNull();
        expect(st.session.currentHand.actions).toHaveLength(5); // BB 체크 제거됨
        const d = deriveHandState(st.session.currentHand);
        expect(d.isOver).toBe(false);
        expect(d.toActSeat).toBe(2);
        expect(st.autoNext.pending).toBe(false);
    });

    it('되돌릴 것이 없으면 no-op (참조 유지)', () => {
        const st = startSession();
        expect(reducer(st, { type: 'UNDO' })).toBe(st);
        expect(reducer(initialState, { type: 'UNDO' })).toBe(initialState);
    });
});

// ---------------------------------------------------------------------------
// AUTO_NEXT_FIRED — 멱등
// ---------------------------------------------------------------------------

describe('AUTO_NEXT_FIRED', () => {
    it('pending일 때 1회만 적용 — 이중 발화는 no-op', () => {
        const over = playCheckedHand(startSession());
        expect(over.autoNext.pending).toBe(true);

        const fired = reducer(over, { type: 'AUTO_NEXT_FIRED', endedAt: 2000 });
        expect(fired.session.hands).toHaveLength(1);
        expect(fired.session.handNo).toBe(2);
        expect(fired.session.dealerSeat).toBe(1);
        expect(fired.session.currentHand.actions).toEqual([]);
        expect(fired.autoNext.pending).toBe(false);

        // 타이머가 다시 울려도 pending=false → 참조 그대로
        const again = reducer(fired, { type: 'AUTO_NEXT_FIRED', endedAt: 3000 });
        expect(again).toBe(fired);
        expect(again.session.hands).toHaveLength(1);
    });

    it('CANCEL_AUTO_NEXT는 pending만 끈다', () => {
        const over = playCheckedHand(startSession());
        const cancelled = reducer(over, { type: 'CANCEL_AUTO_NEXT' });
        expect(cancelled.autoNext.pending).toBe(false);
        expect(cancelled.session.hands).toHaveLength(0); // 핸드는 넘기지 않음
        // 이미 꺼져 있으면 no-op
        expect(reducer(cancelled, { type: 'CANCEL_AUTO_NEXT' })).toBe(cancelled);
        // pending이 꺼진 뒤 AUTO_NEXT_FIRED가 와도 무시
        expect(reducer(cancelled, { type: 'AUTO_NEXT_FIRED' })).toBe(cancelled);
    });
});

// ---------------------------------------------------------------------------
// NEXT_HAND — 빈 핸드 스킵 + 싯아웃 딜러 회전
// ---------------------------------------------------------------------------

describe('NEXT_HAND', () => {
    it('빈 핸드는 레코드 저장 없이 딜러만 회전 (handNo 유지)', () => {
        let st = startSession();
        st = reducer(st, { type: 'NEXT_HAND' });
        expect(st.session.hands).toHaveLength(0);
        expect(st.session.handNo).toBe(1);
        expect(st.session.dealerSeat).toBe(1);
        expect(st.session.currentHand.dealerSeat).toBe(1);
    });

    it('딜러 회전은 싯아웃 좌석을 건너뛴다', () => {
        let st = startSession();
        st = reducer(st, { type: 'TOGGLE_SITOUT', seat: 1 });
        expect(st.session.seats[1].sittingOut).toBe(true);

        st = reducer(st, { type: 'NEXT_HAND' }); // 빈 핸드 → 딜러만 회전, seat1 건너뜀
        expect(st.session.hands).toHaveLength(0);
        expect(st.session.dealerSeat).toBe(2);

        // 재생성된 핸드에서 싯아웃 좌석은 포지션 null
        const sitSeat = st.session.currentHand.seats.find(x => x.seat === 1);
        expect(sitSeat.sittingOut).toBe(true);
        expect(sitSeat.position).toBeNull();
    });

    it('액션 있는 핸드는 endedAt 찍고 push + handNo 증가', () => {
        let st = playCheckedHand(startSession());
        st = reducer(st, { type: 'NEXT_HAND', endedAt: 2000 });
        expect(st.session.hands).toHaveLength(1);
        expect(st.session.hands[0].endedAt).toBe(2000);
        expect(st.session.handNo).toBe(2);
        expect(st.session.currentHand.handNo).toBe(2);
        expect(st.autoNext.pending).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// TOGGLE_SITOUT
// ---------------------------------------------------------------------------

describe('TOGGLE_SITOUT', () => {
    it('진행 중 핸드의 살아있는 플레이어면 fold 기록 후 토글', () => {
        let st = startSession();
        st = record(st, 3, 'fold'); // 이제 seat 4 차례
        st = reducer(st, { type: 'TOGGLE_SITOUT', seat: 4 });

        const actions = st.session.currentHand.actions;
        expect(actions).toHaveLength(2);
        expect(actions[1]).toMatchObject({ seat: 4, type: 'fold' });
        expect(st.session.seats[4].sittingOut).toBe(true);
        // 딜링된 핸드의 스냅샷은 보존 (dealt 통계 유지)
        expect(st.session.currentHand.seats.find(x => x.seat === 4).sittingOut).toBe(false);
    });

    it('이미 폴드한 플레이어 토글은 중복 fold를 기록하지 않는다', () => {
        let st = startSession();
        st = record(st, 3, 'fold');
        st = reducer(st, { type: 'TOGGLE_SITOUT', seat: 3 });
        expect(st.session.currentHand.actions).toHaveLength(1);
        expect(st.session.seats[3].sittingOut).toBe(true);
    });

    it('빈 핸드에서 토글하면 핸드를 재생성해 포지션을 재배치한다', () => {
        let st = startSession();
        st = reducer(st, { type: 'TOGGLE_SITOUT', seat: 2 });
        const handSeat = st.session.currentHand.seats.find(x => x.seat === 2);
        expect(handSeat.sittingOut).toBe(true);
        expect(handSeat.position).toBeNull();
        // 복귀 토글
        st = reducer(st, { type: 'TOGGLE_SITOUT', seat: 2 });
        expect(st.session.seats[2].sittingOut).toBe(false);
        expect(st.session.currentHand.seats.find(x => x.seat === 2).position).toBe('BB');
    });

    it('차례가 아닌 살아있는 플레이어를 싯아웃해도 fold가 기록된다 (유령 플레이어 방지)', () => {
        let st = startSession();
        st = record(st, 3, 'fold'); // 차례 = seat 4
        st = reducer(st, { type: 'TOGGLE_SITOUT', seat: 0 }); // BTN(차례 아님) 자리 비움

        // 동결 핸드 레코드에 fold가 남는다
        const actions = st.session.currentHand.actions;
        expect(actions).toHaveLength(2);
        expect(actions[1]).toMatchObject({ seat: 0, type: 'fold' });
        expect(st.session.seats[0].sittingOut).toBe(true);

        // 차례는 그대로 seat 4 — 이후 진행에서 seat 0에 절대 차례가 오지 않는다
        let d = deriveHandState(st.session.currentHand);
        expect(d.toActSeat).toBe(4);

        st = record(st, 4, 'fold');
        expect(deriveHandState(st.session.currentHand).toActSeat).toBe(5);
        st = record(st, 5, 'fold');
        expect(deriveHandState(st.session.currentHand).toActSeat).toBe(1); // 0 건너뜀
        st = record(st, 1, 'call');
        st = record(st, 2, 'check'); // 핸드 정상 완주
        d = deriveHandState(st.session.currentHand);
        expect(d.isOver).toBe(true);
        expect(st.autoNext.pending).toBe(true);
    });

    it('차례인 플레이어를 싯아웃하면 fold 기록 후 다음 좌석으로 진행', () => {
        let st = startSession();
        st = record(st, 3, 'fold'); // 차례 = seat 4
        st = reducer(st, { type: 'TOGGLE_SITOUT', seat: 4 });
        expect(st.session.currentHand.actions[1]).toMatchObject({ seat: 4, type: 'fold' });
        expect(deriveHandState(st.session.currentHand).toActSeat).toBe(5);
    });

    it('마지막에서 두 번째 생존자를 싯아웃하면 핸드가 종료된다', () => {
        let st = startSession();
        st = playAll(st, [[3, 'fold'], [4, 'fold'], [5, 'fold'], [0, 'fold']]); // 생존 {1,2}, 차례 1
        st = reducer(st, { type: 'TOGGLE_SITOUT', seat: 2 }); // 차례 아닌 BB가 자리 비움
        const d = deriveHandState(st.session.currentHand);
        expect(d.isOver).toBe(true);
        expect(d.endedByFold).toBe(true);
        expect(st.autoNext.pending).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// 스트래들 클램프 — 좌석 구성 변경 시 stale straddleCount 방지
// ---------------------------------------------------------------------------

describe('straddleCount 클램프', () => {
    it('6-max 스트래들 1 → 싯아웃 3명이면 straddleCount 0으로 클램프, lastOption은 BB', () => {
        let st = startSession();
        st = reducer(st, { type: 'CYCLE_STRADDLE' });
        expect(st.session.straddleCount).toBe(1);

        st = reducer(st, { type: 'TOGGLE_SITOUT', seat: 3 });
        st = reducer(st, { type: 'TOGGLE_SITOUT', seat: 4 });
        st = reducer(st, { type: 'TOGGLE_SITOUT', seat: 5 }); // 액티브 3인 → 스트래들 불가

        expect(st.session.straddleCount).toBe(0);
        expect(st.session.currentHand.straddleCount).toBe(0);
        // 액티브 {0,1,2}, 딜러 0 → BB = seat 2가 lastOption (체크 권리)
        expect(lastOptionSeat(st.session.seats, st.session.dealerSeat, st.session.straddleCount)).toBe(2);
    });

    it('진행 중 싯아웃으로 stale해진 straddleCount는 NEXT_HAND에서 클램프된다', () => {
        let st = startSession();
        st = reducer(st, { type: 'CYCLE_STRADDLE' });
        st = record(st, 4, 'fold'); // 스트래들 핸드 진행 시작 (첫 액션 = seat 4)
        st = reducer(st, { type: 'TOGGLE_SITOUT', seat: 3 });
        st = reducer(st, { type: 'TOGGLE_SITOUT', seat: 5 });
        st = reducer(st, { type: 'TOGGLE_SITOUT', seat: 0 }); // 액티브 3인 — 핸드는 동결 유지
        expect(st.session.currentHand.straddleCount).toBe(1); // 동결 스냅샷 보존

        st = reducer(st, { type: 'NEXT_HAND' });
        expect(st.session.straddleCount).toBe(0); // 새 핸드에서 클램프
        expect(st.session.currentHand.straddleCount).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// 진행 중 핸드 구성 변경 가드 — 핸드 사이 전용 액션들
// ---------------------------------------------------------------------------

describe('진행 중 핸드 구성 가드 (no-op)', () => {
    function midHandState() {
        return record(startSession(), 3, 'fold'); // 액션 1개 → 진행 중
    }

    it('SET_DEALER는 진행 중이면 no-op', () => {
        const st = midHandState();
        expect(reducer(st, { type: 'SET_DEALER', seat: 2 })).toBe(st);
    });

    it('CYCLE_STRADDLE은 진행 중이면 no-op', () => {
        const st = midHandState();
        expect(reducer(st, { type: 'CYCLE_STRADDLE' })).toBe(st);
    });

    it('ADD_SEAT는 진행 중이면 no-op', () => {
        const st = midHandState();
        expect(reducer(st, { type: 'ADD_SEAT' })).toBe(st);
    });

    it('REMOVE_SEAT는 진행 중이면 no-op (toActSeat 고아화 방지)', () => {
        const st = midHandState();
        // 차례(seat 4)를 제거하려 해도 거부된다
        expect(reducer(st, { type: 'REMOVE_SEAT', seat: 4 })).toBe(st);
    });

    it('SWAP_SEATS는 진행 중이면 no-op', () => {
        const st = midHandState();
        expect(reducer(st, { type: 'SWAP_SEATS', a: 0, b: 1 })).toBe(st);
    });

    it('핸드 사이(액션 0개)에는 모두 정상 동작', () => {
        let st = startSession();
        st = reducer(st, { type: 'SET_DEALER', seat: 2 });
        expect(st.session.dealerSeat).toBe(2);
        st = reducer(st, { type: 'ADD_SEAT' });
        expect(st.session.seats).toHaveLength(7);
        st = reducer(st, { type: 'REMOVE_SEAT', seat: 6 });
        expect(st.session.seats).toHaveLength(6);
        st = reducer(st, { type: 'SWAP_SEATS', a: 0, b: 1 });
        expect(st.session.seats[0].name).toBe('B');
        expect(st.session.seats[1].name).toBe('A');
    });
});

// ---------------------------------------------------------------------------
// RENAME_SEAT — 진행 중 이름 교정 전파
// ---------------------------------------------------------------------------

describe('RENAME_SEAT', () => {
    it('진행 중에도 허용 — currentHand 스냅샷과 액션 레코드에 새 이름 전파', () => {
        let st = startSession();
        st = record(st, 3, 'raise');
        st = record(st, 4, 'fold');
        st = reducer(st, { type: 'RENAME_SEAT', seat: 3, name: '  Zed ' });

        expect(st.session.seats[3].name).toBe('Zed');
        expect(st.session.currentHand.seats.find(x => x.seat === 3).name).toBe('Zed');
        expect(st.session.currentHand.actions[0].name).toBe('Zed'); // seat 3의 raise
        expect(st.session.currentHand.actions[1].name).toBe('E');   // 다른 좌석은 그대로
        // 동결 스냅샷의 나머지(포지션 등)는 보존
        expect(st.session.currentHand.seats.find(x => x.seat === 3).position).toBe('UTG');
    });

    it('빈 이름·동일 이름·없는 좌석은 no-op', () => {
        const st = record(startSession(), 3, 'raise');
        expect(reducer(st, { type: 'RENAME_SEAT', seat: 3, name: '   ' })).toBe(st);
        expect(reducer(st, { type: 'RENAME_SEAT', seat: 3, name: 'D' })).toBe(st);
        expect(reducer(st, { type: 'RENAME_SEAT', seat: 99, name: 'X' })).toBe(st);
    });
});

// ---------------------------------------------------------------------------
// END_SESSION
// ---------------------------------------------------------------------------

describe('END_SESSION', () => {
    it('SessionRecord를 만들어 archive에 push하고 session=null', () => {
        let st = startSession();
        st = playAll(st, [
            [3, 'raise'], [4, 'fold'], [5, 'fold'], [0, 'fold'], [1, 'fold'], [2, 'fold'],
        ]);
        expect(deriveHandState(st.session.currentHand).isOver).toBe(true);

        st = reducer(st, { type: 'END_SESSION', endedAt: 5000 });
        expect(st.session).toBeNull();
        expect(st.archive).toHaveLength(1);
        expect(st.nav).toEqual(['home']);
        expect(st.autoNext.pending).toBe(false);

        const rec = st.archive[0];
        expect(rec.schemaVersion).toBe(1);
        expect(rec.startedAt).toBe(1000);
        expect(rec.endedAt).toBe(5000);
        expect(rec.blinds).toEqual({ sb: 1, bb: 2 });
        expect(rec.currency).toBe('$');
        expect(rec.totalHands).toBe(1);
        expect(rec.hands).toHaveLength(1);
        expect(rec.hands[0].endedAt).toBe(5000);
        expect(rec.hands[0].actions[0]).toMatchObject({ seat: 3, type: 'raise', raiseLevel: 1 });
    });

    it('빈 currentHand는 아카이브에 포함하지 않는다', () => {
        let st = startSession();
        st = reducer(st, { type: 'END_SESSION', endedAt: 5000 });
        expect(st.archive[0].totalHands).toBe(0);
        expect(st.archive[0].hands).toEqual([]);
    });

    it('두 번째 END_SESSION은 no-op (이중 집계 차단)', () => {
        let st = startSession();
        st = reducer(st, { type: 'END_SESSION', endedAt: 5000 });
        const again = reducer(st, { type: 'END_SESSION', endedAt: 6000 });
        expect(again).toBe(st);
        expect(again.archive).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// 내비게이션 · 로스터 · 설정 · 초기화
// ---------------------------------------------------------------------------

describe('내비게이션 스택', () => {
    it('NAV_PUSH/POP/HOME + 중복 push 방지 + 잘못된 화면 거부', () => {
        let st = reducer(initialState, { type: 'NAV_PUSH', screen: 'history' });
        expect(st.nav).toEqual(['home', 'history']);
        expect(reducer(st, { type: 'NAV_PUSH', screen: 'history' })).toBe(st); // 중복
        expect(reducer(st, { type: 'NAV_PUSH', screen: 'bogus' })).toBe(st);   // 무효 화면
        st = reducer(st, { type: 'NAV_PUSH', screen: 'profile' });
        st = reducer(st, { type: 'NAV_POP' });
        expect(st.nav).toEqual(['home', 'history']);
        st = reducer(st, { type: 'NAV_HOME' });
        expect(st.nav).toEqual(['home']);
        expect(reducer(st, { type: 'NAV_POP' })).toBe(st); // 바닥에서는 no-op
    });
});

describe('로스터·설정·아카이브 관리', () => {
    it('ADD_ROSTER는 trim + 중복 차단, REMOVE_ROSTER는 제거', () => {
        let st = reducer(initialState, { type: 'ADD_ROSTER', name: '  Kim  ' });
        expect(st.roster).toEqual(['Kim']);
        expect(reducer(st, { type: 'ADD_ROSTER', name: 'Kim' })).toBe(st);
        expect(reducer(st, { type: 'ADD_ROSTER', name: '   ' })).toBe(st);
        st = reducer(st, { type: 'REMOVE_ROSTER', name: 'Kim' });
        expect(st.roster).toEqual([]);
    });

    it('UPDATE_SETTINGS는 patch 병합', () => {
        const st = reducer(initialState, { type: 'UPDATE_SETTINGS', patch: { geminiApiKey: 'k1' } });
        expect(st.settings.geminiApiKey).toBe('k1');
        // patch에 없는 필드는 기본값 유지 (멀티 프로바이더 기본값)
        expect(st.settings.geminiModel).toBe('gemini-3-pro-preview');
        expect(st.settings.aiProvider).toBe('gemini');
        const st2 = reducer(st, { type: 'UPDATE_SETTINGS', patch: { aiProvider: 'anthropic', anthropicApiKey: 'sk-ant-1' } });
        expect(st2.settings.aiProvider).toBe('anthropic');
        expect(st2.settings.anthropicApiKey).toBe('sk-ant-1');
        expect(st2.settings.geminiApiKey).toBe('k1');
    });

    it('DELETE_ARCHIVED는 id로 제거, 없는 id는 no-op', () => {
        let st = startSession();
        st = reducer(st, { type: 'END_SESSION', endedAt: 5000 });
        const id = st.archive[0].id;
        expect(reducer(st, { type: 'DELETE_ARCHIVED', id: 'nope' })).toBe(st);
        st = reducer(st, { type: 'DELETE_ARCHIVED', id });
        expect(st.archive).toEqual([]);
    });
});

describe('LOAD_PERSISTED / RESET_ALL', () => {
    it('LOAD_PERSISTED: 상태 원자 일부 + archive 반영, settings는 기본값과 병합', () => {
        const st = reducer(initialState, {
            type: 'LOAD_PERSISTED',
            payload: {
                state: { session: null, roster: ['Kim'], settings: { geminiApiKey: 'k' } },
                archive: [{ id: 's1', hands: [] }],
            },
        });
        expect(st.session).toBeNull();
        expect(st.roster).toEqual(['Kim']);
        // 저장된 키는 유지 + 나머지는 멀티 프로바이더 기본값으로 채움
        expect(st.settings.geminiApiKey).toBe('k');
        expect(st.settings.aiProvider).toBe('gemini');
        expect(st.settings.geminiModel).toBe('gemini-3-pro-preview');
        expect(st.settings.openaiModel).toBeTruthy();
        expect(st.settings.anthropicModel).toBeTruthy();
        expect(st.archive).toHaveLength(1);
    });

    it('LOAD_PERSISTED: 손상된 currentHand는 재생성, 손상된 hands·archive 핸드는 격리한다', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const seats = [
            { seat: 0, name: 'A', sittingOut: false },
            { seat: 1, name: 'B', sittingOut: false },
            { seat: 2, name: 'C', sittingOut: false },
        ];
        const goodHand = { id: 'h1', handNo: 1, dealerSeat: 0, straddleCount: 0, seats, actions: [] };
        const st = reducer(initialState, {
            type: 'LOAD_PERSISTED',
            payload: {
                state: {
                    session: {
                        id: 's1', startedAt: 1, blinds: { sb: 1, bb: 2 }, currency: '$',
                        seats, dealerSeat: 0, straddleCount: 0, handNo: 2,
                        hands: [goodHand, { corrupted: true }, null],
                        currentHand: { seats: 'garbage' }, // isValidHandRecord false
                    },
                },
                archive: [{ id: 'a1', hands: [goodHand, 42, { bad: 1 }] }],
            },
        });
        expect(st.session.hands).toEqual([goodHand]); // 손상 레코드는 hands에서 제외
        // 삭제 대신 격리: 객체 원본은 quarantinedHands에 그대로 보존 (null·숫자는 보존 가치 없음)
        expect(st.session.quarantinedHands).toEqual([{ corrupted: true }, { seats: 'garbage' }]);
        expect(isValidHandRecord(st.session.currentHand)).toBe(true); // 재생성됨
        expect(st.session.currentHand.handNo).toBe(2);
        expect(st.session.currentHand.actions).toEqual([]);
        expect(st.archive[0].hands).toEqual([goodHand]);
        expect(st.archive[0].quarantinedHands).toEqual([{ bad: 1 }]);
        expect(warnSpy).toHaveBeenCalledTimes(1); // 로드당 경고 1회 (개수 포함)
        expect(warnSpy.mock.calls[0][0]).toContain('3');
        // 재생성된 핸드는 파생 계산에서 throw하지 않는다
        expect(() => deriveHandState(st.session.currentHand)).not.toThrow();
        warnSpy.mockRestore();
    });

    it('LOAD_PERSISTED: seats가 배열이 아닌 세션은 버린다 (session=null)', () => {
        const st = reducer(initialState, {
            type: 'LOAD_PERSISTED',
            payload: { state: { session: { id: 's1', seats: 'broken' } } },
        });
        expect(st.session).toBeNull();
    });

    it('LOAD_PERSISTED: malformed detailed data is quarantined before replay', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        let saved = startSession({
            playerCount: 2,
            blinds: { sb: 1, bb: 2 },
            currency: '$',
            startedAt: 1000,
            seatNames: ['Hero', 'Villain'],
        });
        saved = reducer(saved, {
            type: 'ENABLE_DETAILED_TRACKING',
            options: { startingStacks: { 0: 100, 1: 100 }, chipUnit: 1 },
        });
        const broken = JSON.parse(JSON.stringify(saved.session.currentHand));
        broken.detailed.reveals = [{ seat: 1, cards: null }];

        const loaded = reducer(initialState, {
            type: 'LOAD_PERSISTED',
            payload: {
                state: { session: { ...saved.session, currentHand: broken } },
                archive: [{ id: 'archived', hands: [broken] }],
            },
        });

        expect(loaded.session.currentHand.detailed).toBeUndefined();
        expect(isValidHandRecord(loaded.session.currentHand)).toBe(true);
        expect(loaded.archive[0].hands).toEqual([]);
        // 원본은 삭제되지 않고 격리 버킷에 보존된다
        expect(loaded.session.quarantinedHands).toEqual([broken]);
        expect(loaded.archive[0].quarantinedHands).toEqual([broken]);
        expect(() => deriveHandState(loaded.session.currentHand)).not.toThrow();
        warnSpy.mockRestore();
    });

    it('LOAD_PERSISTED: 격리 버킷은 저장/로드 왕복에서 보존되고 END_SESSION으로 이월된다', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        let saved = startSession({
            playerCount: 2,
            blinds: { sb: 1, bb: 2 },
            currency: '$',
            startedAt: 1000,
            seatNames: ['Hero', 'Villain'],
        });
        saved = reducer(saved, {
            type: 'ENABLE_DETAILED_TRACKING',
            options: { startingStacks: { 0: 100, 1: 100 }, chipUnit: 1 },
        });
        const broken = JSON.parse(JSON.stringify(saved.session.currentHand));
        broken.detailed.reveals = [{ seat: 1, cards: null }];

        const loaded = reducer(initialState, {
            type: 'LOAD_PERSISTED',
            payload: {
                state: { session: { ...saved.session, hands: [broken], currentHand: null } },
                archive: [{ id: 'archived', hands: [broken] }],
            },
        });
        expect(loaded.session.hands).toEqual([]);
        expect(loaded.session.quarantinedHands).toEqual([broken]);
        expect(loaded.archive[0].quarantinedHands).toEqual([broken]);
        expect(warnSpy).toHaveBeenCalledTimes(1);

        // 저장/로드 왕복 (영속화는 세션·아카이브를 JSON 그대로 직렬화) — 버킷 보존, 중복 격리 없음
        const reloaded = reducer(initialState, {
            type: 'LOAD_PERSISTED',
            payload: JSON.parse(JSON.stringify({
                state: { session: loaded.session, roster: [], settings: {} },
                archive: loaded.archive,
            })),
        });
        expect(reloaded.session.quarantinedHands).toEqual([broken]);
        expect(reloaded.archive[0].quarantinedHands).toEqual([broken]);
        expect(reloaded.archive[0].hands).toEqual([]);
        expect(warnSpy).toHaveBeenCalledTimes(1); // 재로드에서는 새 격리 없음 → 추가 경고 없음

        // END_SESSION: 라이브 세션의 버킷이 아카이브 레코드로 그대로 이월
        const ended = reducer(reloaded, { type: 'END_SESSION', endedAt: 9000 });
        const record = ended.archive[ended.archive.length - 1];
        expect(record.quarantinedHands).toEqual([broken]);
        expect(record.hands).toEqual([]);
        expect(record.totalHands).toBe(0);
        warnSpy.mockRestore();
    });

    it('RESET_ALL은 초기 상태를 반환한다 (리듀서는 순수 — 스토리지 삭제는 컨텍스트 몫)', () => {
        let st = startSession();
        st = reducer(st, { type: 'ADD_ROSTER', name: 'Kim' });
        st = reducer(st, { type: 'RESET_ALL' });
        expect(st).toEqual(createInitialState());
        expect(st.session).toBeNull();
        expect(st.nav).toEqual(['home']);
    });
});

describe('detailed hand reducer flow', () => {
    const headsUpConfig = {
        playerCount: 2,
        blinds: { sb: 1, bb: 2 },
        currency: '$',
        startedAt: 2000,
        seatNames: ['Hero', 'Villain'],
    };

    it('keeps quick mode compatible and enables an opt-in v2 ledger', () => {
        let st = startSession(headsUpConfig);
        st = reducer(st, {
            type: 'ENABLE_DETAILED_TRACKING',
            options: { heroSeat: 0, startingStacks: { 0: 100, 1: 100 }, chipUnit: 1 },
        });

        expect(st.session.currentHand.schemaVersion).toBe(2);
        expect(st.session.currentHand.captureLevel).toBe('detailed');
        expect(st.autoNext.pending).toBe(false);
        const detail = deriveDetailedState(st.session.currentHand);
        expect(detail.toActSeat).toBe(0);
        expect(detail.toCall).toBe(1);
        expect(detail.pot).toBe(3);
    });

    it('records streets, board, winner and advances only after completion', () => {
        let st = startSession(headsUpConfig);
        st = reducer(st, {
            type: 'ENABLE_DETAILED_TRACKING',
            options: { heroSeat: 0, startingStacks: { 0: 100, 1: 100 }, chipUnit: 1 },
        });
        st = reducer(st, {
            type: 'RECORD_DETAILED_ACTION', seat: 0, actionType: 'call', options: { precision: 'exact' },
        });
        st = reducer(st, {
            type: 'RECORD_DETAILED_ACTION', seat: 1, actionType: 'check', options: { precision: 'exact' },
        });
        expect(deriveDetailedState(st.session.currentHand).streetClosed).toBe(true);
        expect(st.autoNext.pending).toBe(false);

        st = reducer(st, { type: 'ADVANCE_DETAILED_STREET', cards: ['As', '8d', '4c'] });
        expect(st.session.currentHand.detailed.board.flop).toEqual(['As', '8d', '4c']);
        expect(deriveDetailedState(st.session.currentHand).toActSeat).toBe(1);

        st = reducer(st, {
            type: 'RECORD_DETAILED_ACTION', seat: 1, actionType: 'check', options: { precision: 'exact' },
        });
        st = reducer(st, {
            type: 'RECORD_DETAILED_ACTION', seat: 0, actionType: 'bet',
            options: { amountTo: 2, precision: 'exact' },
        });
        st = reducer(st, {
            type: 'RECORD_DETAILED_ACTION', seat: 1, actionType: 'fold', options: { precision: 'exact' },
        });
        expect(deriveDetailedState(st.session.currentHand).handOver).toBe(true);

        st = reducer(st, { type: 'COMPLETE_DETAILED_HAND', payload: { winners: [] } });
        expect(st.session.currentHand.status).toBe('complete');
        expect(st.session.currentHand.detailed.winners).toEqual([{ seat: 0, potIndex: null }]);
        expect(st.autoNext.pending).toBe(true);
    });

    it('can return to quick mode before any postflop detail is captured', () => {
        let st = startSession(headsUpConfig);
        st = reducer(st, { type: 'ENABLE_DETAILED_TRACKING', options: { chipUnit: 1 } });
        expect(canDisableDetailedTracking(st.session)).toBe(true);
        st = reducer(st, { type: 'DISABLE_DETAILED_TRACKING' });
        expect(st.session.currentHand.detailed).toBeUndefined();
        expect(st.session.currentHand.captureLevel).toBeUndefined();
    });

    it('완료된 프리플랍 상세 핸드는 DISABLE_DETAILED_TRACKING이 no-op (자동 다음핸드 대기 창 보존)', () => {
        let st = startSession(headsUpConfig);
        st = reducer(st, {
            type: 'ENABLE_DETAILED_TRACKING',
            options: { heroSeat: 0, startingStacks: { 0: 100, 1: 100 }, chipUnit: 1 },
        });
        st = reducer(st, {
            type: 'RECORD_DETAILED_ACTION', seat: 0, actionType: 'fold', options: { precision: 'exact' },
        });
        st = reducer(st, { type: 'COMPLETE_DETAILED_HAND', payload: { winners: [] } });
        expect(st.session.currentHand.detailed.completed).toBe(true);
        expect(st.autoNext.pending).toBe(true); // 1.5초 자동 다음핸드 대기 창

        // 완료 레코드(승자·카드·스택)를 벗겨내면 안 된다 — 참조 그대로 no-op
        expect(canDisableDetailedTracking(st.session)).toBe(false);
        expect(reducer(st, { type: 'DISABLE_DETAILED_TRACKING' })).toBe(st);
        expect(st.session.currentHand.detailed.winners).toEqual([{ seat: 1, potIndex: null }]);
    });

    it('freezes table configuration as soon as detailed setup starts', () => {
        let st = startSession({ ...headsUpConfig, playerCount: 3, seatNames: ['Hero', 'V1', 'V2'] });
        st = reducer(st, {
            type: 'ENABLE_DETAILED_TRACKING',
            options: { heroSeat: 0, startingStacks: { 0: 100, 1: 100, 2: 100 }, chipUnit: 1 },
        });
        st = reducer(st, {
            type: 'SET_DETAILED_CARDS',
            payload: { heroSeat: 0, heroCards: ['As', 'Kd'] },
        });

        expect(reducer(st, { type: 'CYCLE_STRADDLE' })).toBe(st);
        expect(reducer(st, { type: 'TOGGLE_SITOUT', seat: 1 })).toBe(st);
        expect(reducer(st, { type: 'SET_DEALER', seat: 1 })).toBe(st);

        const renamed = reducer(st, { type: 'RENAME_SEAT', seat: 0, name: 'Hero corrected' });
        expect(renamed.session.currentHand.detailed.heroCards).toEqual(['As', 'Kd']);
        expect(renamed.session.currentHand.seats[0].name).toBe('Hero corrected');
    });

    it('blocks manual next while incomplete but allows it after completion or cancel', () => {
        let st = startSession(headsUpConfig);
        st = reducer(st, {
            type: 'ENABLE_DETAILED_TRACKING',
            options: { heroSeat: 0, startingStacks: { 0: 100, 1: 100 }, chipUnit: 1 },
        });
        expect(reducer(st, { type: 'NEXT_HAND', endedAt: 3000 })).toBe(st);

        st = reducer(st, {
            type: 'RECORD_DETAILED_ACTION', seat: 0, actionType: 'fold', options: { precision: 'exact' },
        });
        st = reducer(st, { type: 'COMPLETE_DETAILED_HAND', payload: { winners: [] } });
        st = reducer(st, { type: 'CANCEL_AUTO_NEXT' });
        expect(st.autoNext.pending).toBe(false);

        st = reducer(st, { type: 'NEXT_HAND', endedAt: 3000 });
        expect(st.session.hands).toHaveLength(1);
        expect(st.session.hands[0].detailed.completed).toBe(true);
        expect(st.session.handNo).toBe(2);
    });

    it('restores pending auto-next when a completed detailed current hand reloads', () => {
        let saved = startSession(headsUpConfig);
        saved = reducer(saved, {
            type: 'ENABLE_DETAILED_TRACKING',
            options: { startingStacks: { 0: 100, 1: 100 }, chipUnit: 1 },
        });
        saved = reducer(saved, {
            type: 'RECORD_DETAILED_ACTION', seat: 0, actionType: 'fold', options: { precision: 'exact' },
        });
        saved = reducer(saved, { type: 'COMPLETE_DETAILED_HAND', payload: { winners: [] } });

        const loaded = reducer(initialState, {
            type: 'LOAD_PERSISTED',
            payload: { state: { session: saved.session, roster: [], settings: {} }, archive: [] },
        });
        expect(loaded.session.currentHand.detailed.completed).toBe(true);
        expect(loaded.autoNext.pending).toBe(true);
    });

    it('archives an interrupted detailed hand as a draft, not a completed sample', () => {
        let st = startSession(headsUpConfig);
        st = reducer(st, {
            type: 'ENABLE_DETAILED_TRACKING',
            options: { startingStacks: { 0: 100, 1: 100 }, chipUnit: 1 },
        });
        st = reducer(st, {
            type: 'RECORD_DETAILED_ACTION', seat: 0, actionType: 'call', options: { precision: 'exact' },
        });
        st = reducer(st, { type: 'END_SESSION', endedAt: 4000 });

        expect(st.archive[0].hands).toHaveLength(1);
        expect(st.archive[0].hands[0].status).toBe('incomplete');
        expect(st.archive[0].totalHands).toBe(0);
        expect(st.archive[0].incompleteHands).toBe(1);
    });
});
