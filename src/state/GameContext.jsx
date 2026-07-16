// 얇은 프로바이더 (docs/REBUILD_DESIGN.md §6 — S1)
// useReducer + 영속화 이펙트 + 자동 다음핸드 타이머. 화면은 useGame()만 사용한다.

import React, { createContext, useContext, useReducer, useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
    reducer,
    initialState,
    isMidHand as isMidHandForSession,
    canDisableDetailedTracking,
    hasIncompleteDetailedHand,
} from './gameReducer.js';
import { deriveHandState, legalActionsFor as engineLegalActionsFor } from '../engine/handEngine.js';
import {
    deriveDetailedState,
    legalDetailedActions,
    deriveSidePots,
    applyDetailedAction,
    chipUnitForBlinds,
} from '../engine/detailedHandEngine.js';
import { computeAllStats } from '../engine/statsEngine.js';
import {
    loadPersisted,
    savePersisted,
    resetAllData as storageResetAllData,
    PERSISTED_SIZE_WARN_BYTES,
} from '../storage/storage.js';

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

    // 저장 실패 알림: 앱 실행당 alert 1회, 로그는 매번 (quota 초과 등).
    // 저장 크기 경고: 임계(4MB) 최초 초과 시 앱 실행당 alert 1회 — 내보내기/삭제 유도.
    const saveFailAlertedRef = useRef(false);
    const sizeWarnAlertedRef = useRef(false);
    const reportSaveResult = useCallback((result) => {
        if (!result.ok) {
            console.error('[GameContext] 저장 실패 — 저장 공간 부족 가능성');
            if (!saveFailAlertedRef.current) {
                saveFailAlertedRef.current = true;
                if (typeof globalThis.alert === 'function') {
                    globalThis.alert('저장 실패: 저장 공간이 부족할 수 있습니다');
                }
            }
            return;
        }
        if (result.bytes > PERSISTED_SIZE_WARN_BYTES && !sizeWarnAlertedRef.current) {
            sizeWarnAlertedRef.current = true;
            if (typeof globalThis.alert === 'function') {
                globalThis.alert('저장 데이터가 커지고 있습니다. 히스토리에서 오래된 세션을 내보내기 후 삭제하세요.');
            }
        }
    }, []);

    // session/roster/settings/archive를 항상 하나의 envelope로 저장한다.
    // END_SESSION에서 session:null과 새 archive가 같은 setItem에 함께 커밋되므로
    // 둘 중 한쪽만 영속화되는 중간 상태가 생기지 않는다.
    // 일반 진행은 300ms 디바운스하고, 세션 정체성·archive 변경은 즉시 저장한다.
    // pagehide/visibilitychange(hidden)에서는 pending envelope를 동기 플러시한다.
    const { session, roster, settings, archive, autoNext } = state;
    const pendingSaveRef = useRef({ state: null, archive: [], dirty: false });
    const prevSessionRef = useRef(null);
    const prevArchiveRef = useRef(archive);
    useEffect(() => {
        if (!hydrated) return undefined;
        const stateAtom = { session, roster, settings };
        pendingSaveRef.current = { state: stateAtom, archive, dirty: true };

        const identityChanged = (prevSessionRef.current === null) !== (session === null);
        const archiveChanged = prevArchiveRef.current !== archive;
        prevSessionRef.current = session;
        prevArchiveRef.current = archive;
        if (identityChanged || archiveChanged) {
            pendingSaveRef.current.dirty = false;
            reportSaveResult(savePersisted({ state: stateAtom, archive }));
            return undefined;
        }

        const timer = setTimeout(() => {
            pendingSaveRef.current.dirty = false;
            reportSaveResult(savePersisted({ state: stateAtom, archive }));
        }, 300);
        return () => clearTimeout(timer);
    }, [hydrated, session, roster, settings, archive, reportSaveResult]);

    // 페이지 이탈 시 디바운스 대기 중인 envelope를 동기 플러시
    useEffect(() => {
        const flush = () => {
            const p = pendingSaveRef.current;
            if (!p.dirty) return;
            p.dirty = false;
            reportSaveResult(savePersisted({ state: p.state, archive: p.archive }));
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
    }, [reportSaveResult]);

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

    const isDetailed = !!currentHand?.detailed?.enabled;
    const derived = useMemo(() => {
        if (!currentHand) return EMPTY_DERIVED;
        if (!currentHand.detailed?.enabled) return deriveHandState(currentHand);
        const detail = deriveDetailedState(currentHand);
        const sidePotState = deriveSidePots(currentHand);
        const foldedSeats = new Set(detail.players.filter(player => player.folded).map(player => player.seat));
        const livePlayers = detail.players.filter(player => player.active && !player.folded);
        return {
            ...detail,
            foldedSeats,
            actedSinceLastRaise: new Set(),
            isOver: detail.handOver,
            endedByFold: livePlayers.length <= 1,
            streetComplete: detail.streetClosed,
            handComplete: detail.isComplete || detail.handOver,
            sidePotState,
            legalActions: detail.toActSeat === null ? [] : legalDetailedActions(currentHand, detail.toActSeat),
        };
    }, [currentHand]);
    // 포지션은 진행 중 핸드의 동결 스냅샷에서 파생 — 라이브 좌석 재계산과의 괴리 방지.
    // (핸드 사이 구성 변경 시 currentHand가 재생성되므로 항상 최신이다.)
    const positions = useMemo(() => {
        const map = new Map();
        if (currentHand) {
            for (const s of currentHand.seats) map.set(s.seat, s.position ?? null);
        }
        return map;
    }, [currentHand]);
    // 라이브 스탯은 §6 계약대로 currentHand를 포함한다. includeInProgressDetailed는
    // 진행 중 상세 핸드(완료 전)도 리플레이하게 한다 — session.hands에는 미완료 상세
    // 핸드가 존재할 수 없으므로(advanceHand가 차단) 이 플래그는 currentHand에만 작용한다.
    const playerStats = useMemo(
        () => computeAllStats(
            currentHand ? [...sessionHands, currentHand] : sessionHands,
            { includeInProgressDetailed: true }),
        [sessionHands, currentHand]);
    // 상세 UI가 쓰는 칩 단위 — 화면이 엔진을 직접 import하지 않도록 컨텍스트에서 계산.
    // 상세 추적 중이면 핸드에 동결된 단위를, 아니면 블라인드에서 유도한 단위를 쓴다.
    const chipUnit = useMemo(() => {
        const detailedUnit = currentHand?.detailed?.enabled ? currentHand.detailed.chipUnit : null;
        return typeof detailedUnit === 'number' && Number.isFinite(detailedUnit) && detailedUnit > 0
            ? detailedUnit
            : chipUnitForBlinds(session ? session.blinds : null);
    }, [currentHand, session]);
    const legalActionsFor = useCallback(
        (seat) => {
            if (!currentHand) return [];
            return currentHand.detailed?.enabled
                ? legalDetailedActions(currentHand, seat)
                : engineLegalActionsFor(currentHand, seat);
        },
        [currentHand]);

    // ── 액션 래퍼 (dispatch만 사용 — 안정 참조) ────────────────────────
    const actions = useMemo(() => ({
        navigateTo: (screen) => dispatch({ type: 'NAV_PUSH', screen }),
        goBack: () => dispatch({ type: 'NAV_POP' }),
        startSession: (cfg) => dispatch({ type: 'START_SESSION', cfg }),
        endSession: () => dispatch({ type: 'END_SESSION' }),
        resumeSession: () => { if (stateRef.current.session) dispatch({ type: 'NAV_PUSH', screen: 'game' }); },
        recordAction: (seat, actionType) => dispatch({ type: 'RECORD_ACTION', seat, actionType }),
        enableDetailedTracking: (options) => dispatch({ type: 'ENABLE_DETAILED_TRACKING', options }),
        disableDetailedTracking: () => dispatch({ type: 'DISABLE_DETAILED_TRACKING' }),
        // 리듀서와 같은 엔진 호출로 no-op 여부를 선판정해 boolean 반환 — UI가 거부 피드백을 줄 수 있다
        recordDetailedAction: (seat, actionType, options) => {
            const cur = stateRef.current.session?.currentHand;
            if (!cur?.detailed?.enabled) return false;
            if (applyDetailedAction(cur, seat, actionType, options || {}) === cur) return false;
            dispatch({ type: 'RECORD_DETAILED_ACTION', seat, actionType, options });
            return true;
        },
        advanceDetailedStreet: (cards) => dispatch({ type: 'ADVANCE_DETAILED_STREET', cards }),
        setDetailedCards: (payload) => dispatch({ type: 'SET_DETAILED_CARDS', payload }),
        completeDetailedHand: (payload) => dispatch({ type: 'COMPLETE_DETAILED_HAND', payload }),
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
        isDetailed,
        isMidHand: session ? isMidHandForSession(session) : false,
        canDisableDetailed: canDisableDetailedTracking(session),
        detailedIncomplete: hasIncompleteDetailedHand(session),
        chipUnit,
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
