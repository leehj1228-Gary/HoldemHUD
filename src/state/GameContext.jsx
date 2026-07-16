// 얇은 프로바이더 (docs/REBUILD_DESIGN.md §6 — S1)
// useReducer + 영속화 이펙트 + 자동 다음핸드 타이머. 화면은 useGame()만 사용한다.

import React, { createContext, useContext, useReducer, useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { reducer, initialState } from './gameReducer.js';
import { deriveHandState, legalActionsFor as engineLegalActionsFor } from '../engine/handEngine.js';
import { computeAllStats } from '../engine/statsEngine.js';
import { loadPersisted, savePersistedState, saveArchive, resetAllData as storageResetAllData } from '../storage/storage.js';

const GameContext = createContext(null);

const EMPTY_SEATS = [];
const EMPTY_DERIVED = {
    toActSeat: null, raiseCount: 0, lastAggressorSeat: null, limperCount: 0,
    foldedSeats: new Set(), actedSinceLastRaise: new Set(), isOver: false, endedByFold: false,
};

export function GameProvider({ children }) {
    const [state, dispatch] = useReducer(reducer, initialState);
    const [hydrated, setHydrated] = useState(false);
    const stateRef = useRef(state);
    useEffect(() => { stateRef.current = state; });

    // 마운트 시 영속화 상태 로드 (StrictMode 이중 실행에도 무해 — 멱등)
    useEffect(() => {
        dispatch({ type: 'LOAD_PERSISTED', payload: loadPersisted() });
        setHydrated(true);
    }, []);

    // 저장 실패 알림: 앱 실행당 alert 1회, 로그는 매번 (quota 초과 등)
    const saveFailAlertedRef = useRef(false);
    const reportSaveFailure = useCallback((ok) => {
        if (ok) return;
        console.error('[GameContext] 저장 실패 — 저장 공간 부족 가능성');
        if (!saveFailAlertedRef.current) {
            saveFailAlertedRef.current = true;
            if (typeof globalThis.alert === 'function') {
                globalThis.alert('저장 실패: 저장 공간이 부족할 수 있습니다');
            }
        }
    }, []);

    // 저장 이펙트 1: session/roster/settings → 300ms 디바운스 (로드 전 렌더는 건너뜀).
    // 예외 1: 세션 정체성 전환(null↔객체)은 즉시 저장 — END_SESSION의 archive 쓰기와
    //         session=null 쓰기가 원자적으로 함께 착지하도록.
    // 예외 2: pagehide/visibilitychange(hidden) 시 pendingSaveRef로 동기 플러시 —
    //         앱 강제 종료·하드웨어 백 종료로 마지막 300ms 쓰기가 유실되는 것 방지.
    const { session, roster, settings, archive, autoNext } = state;
    const pendingSaveRef = useRef({ session: null, roster: [], settings: null, dirty: false });
    const prevSessionRef = useRef(null);
    useEffect(() => {
        if (!hydrated) return undefined;
        pendingSaveRef.current = { session, roster, settings, dirty: true };

        const identityChanged = (prevSessionRef.current === null) !== (session === null);
        prevSessionRef.current = session;
        if (identityChanged) {
            pendingSaveRef.current.dirty = false;
            reportSaveFailure(savePersistedState({ session, roster, settings }));
            return undefined;
        }

        const timer = setTimeout(() => {
            pendingSaveRef.current.dirty = false;
            reportSaveFailure(savePersistedState({ session, roster, settings }));
        }, 300);
        return () => clearTimeout(timer);
    }, [hydrated, session, roster, settings, reportSaveFailure]);

    // 저장 이펙트 1b: 페이지 이탈 시 디바운스 대기 중인 쓰기를 동기 플러시
    useEffect(() => {
        const flush = () => {
            const p = pendingSaveRef.current;
            if (!p.dirty) return;
            p.dirty = false;
            savePersistedState({ session: p.session, roster: p.roster, settings: p.settings });
        };
        const onVisibilityChange = () => {
            if (document.visibilityState === 'hidden') flush();
        };
        window.addEventListener('pagehide', flush);
        document.addEventListener('visibilitychange', onVisibilityChange);
        return () => {
            window.removeEventListener('pagehide', flush);
            document.removeEventListener('visibilitychange', onVisibilityChange);
        };
    }, []);

    // 저장 이펙트 2: archive 변경 시 즉시 저장 (로드 전 렌더는 건너뜀)
    useEffect(() => {
        if (!hydrated) return;
        reportSaveFailure(saveArchive(archive));
    }, [hydrated, archive, reportSaveFailure]);

    // 자동 다음핸드 타이머: pending이 true가 되면 1500ms 후 발화.
    // 리듀서가 멱등(AUTO_NEXT_FIRED는 pending일 때만 적용)이라 stale closure 문제가 없다.
    const autoNextPending = autoNext.pending;
    useEffect(() => {
        if (!autoNextPending) return undefined;
        const timer = setTimeout(() => dispatch({ type: 'AUTO_NEXT_FIRED' }), 1500);
        return () => clearTimeout(timer);
    }, [autoNextPending]);

    // Android 하드웨어 뒤로가기: nav 깊이 > 1이면 pop, 아니면 앱 종료 (웹에서는 무해)
    useEffect(() => {
        let cancelled = false;
        let remove = null;
        (async () => {
            try {
                const { App: CapApp } = await import('@capacitor/app');
                const handle = await CapApp.addListener('backButton', () => {
                    if (stateRef.current.nav.length > 1) dispatch({ type: 'NAV_POP' });
                    else CapApp.exitApp();
                });
                if (cancelled) handle.remove();
                else remove = () => handle.remove();
            } catch {
                // 웹 빌드 등 Capacitor 미지원 환경 — 무시
            }
        })();
        return () => { cancelled = true; if (remove) remove(); };
    }, []);

    // ── 파생값 (useMemo) ───────────────────────────────────────────────
    const currentHand = session ? session.currentHand : null;
    const seats = session ? session.seats : EMPTY_SEATS;
    const dealerSeat = session ? session.dealerSeat : null;
    const sessionHands = session ? session.hands : EMPTY_SEATS;

    const derived = useMemo(
        () => (currentHand ? deriveHandState(currentHand) : EMPTY_DERIVED),
        [currentHand]);
    // 포지션은 진행 중 핸드의 동결 스냅샷에서 파생 — 라이브 좌석 재계산과의 괴리 방지.
    // (핸드 사이 구성 변경 시 currentHand가 재생성되므로 항상 최신이다.)
    const positions = useMemo(() => {
        const map = new Map();
        if (currentHand) {
            for (const s of currentHand.seats) map.set(s.seat, s.position ?? null);
        }
        return map;
    }, [currentHand]);
    const playerStats = useMemo(
        () => computeAllStats(currentHand ? [...sessionHands, currentHand] : sessionHands),
        [sessionHands, currentHand]);
    const legalActionsFor = useCallback(
        (seat) => (currentHand ? engineLegalActionsFor(currentHand, seat) : []),
        [currentHand]);

    // ── 액션 래퍼 (dispatch만 사용 — 안정 참조) ────────────────────────
    const actions = useMemo(() => ({
        navigateTo: (screen) => dispatch({ type: 'NAV_PUSH', screen }),
        goBack: () => dispatch({ type: 'NAV_POP' }),
        startSession: (cfg) => dispatch({ type: 'START_SESSION', cfg }),
        endSession: () => dispatch({ type: 'END_SESSION' }),
        resumeSession: () => { if (stateRef.current.session) dispatch({ type: 'NAV_PUSH', screen: 'game' }); },
        recordAction: (seat, actionType) => dispatch({ type: 'RECORD_ACTION', seat, actionType }),
        undo: () => dispatch({ type: 'UNDO' }),
        nextHand: () => dispatch({ type: 'NEXT_HAND' }),
        cancelAutoNext: () => dispatch({ type: 'CANCEL_AUTO_NEXT' }),
        toggleSitOut: (seat) => dispatch({ type: 'TOGGLE_SITOUT', seat }),
        setDealer: (seat) => dispatch({ type: 'SET_DEALER', seat }),
        cycleStraddle: () => dispatch({ type: 'CYCLE_STRADDLE' }),
        addSeat: () => dispatch({ type: 'ADD_SEAT' }),
        removeSeat: (seat) => dispatch({ type: 'REMOVE_SEAT', seat }),
        renameSeat: (seat, name) => dispatch({ type: 'RENAME_SEAT', seat, name }),
        swapSeats: (a, b) => dispatch({ type: 'SWAP_SEATS', a, b }),
        addToRoster: (name) => dispatch({ type: 'ADD_ROSTER', name }),
        removeFromRoster: (name) => dispatch({ type: 'REMOVE_ROSTER', name }),
        deleteArchivedSession: (id) => dispatch({ type: 'DELETE_ARCHIVED', id }),
        updateSettings: (patch) => dispatch({ type: 'UPDATE_SETTINGS', patch }),
        resetAllData: () => { storageResetAllData(); dispatch({ type: 'RESET_ALL' }); },
    }), []);

    // ── useGame() 계약 (설계 §6 — 이름 변경 금지) ──────────────────────
    const value = {
        screen: state.nav[state.nav.length - 1],
        session,
        seats,
        dealerSeat,
        straddleCount: session ? session.straddleCount : 0,
        blinds: session ? session.blinds : null,
        currency: session ? session.currency : '$',
        handNo: session ? session.handNo : 0,
        currentHand,
        derived,
        positions,
        legalActionsFor,
        sessionHands,
        archive,
        roster,
        settings,
        playerStats,
        autoNextPending,
        ...actions,
    };

    return <GameContext.Provider value={value}>{children}</GameContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useGame() {
    const ctx = useContext(GameContext);
    if (!ctx) throw new Error('useGame은 GameProvider 안에서만 사용할 수 있습니다');
    return ctx;
}
