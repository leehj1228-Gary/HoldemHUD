// 단일 리듀서 + 상태 원자 (docs/REBUILD_DESIGN.md §6 — S1)
// 순수 모듈: React·storage import 금지 (engine/만 의존) — 단위 테스트 가능.
// 모든 액션은 불변 업데이트. no-op이면 반드시 기존 state 참조를 그대로 반환한다.

import {
    SCHEMA_VERSION,
    SCREENS,
    createSeat,
    createHand,
    newId,
    isValidHandRecord,
    normalizeDetailedHandRecord,
} from '../engine/schema.js';
import {
    positionsForHand,
    deriveHandState,
    applyAction,
    forceFold,
    nextDealerSeat,
} from '../engine/handEngine.js';
import {
    enableDetailedTracking,
    applyDetailedAction,
    advanceDetailedStreet,
    setDetailedCards,
    completeDetailedHand,
    undoDetailedStep,
} from '../engine/detailedHandEngine.js';

export const DEFAULT_BLINDS = { sb: 1, bb: 2 };
export const DEFAULT_SETTINGS = {
    aiProvider: 'gemini', // 'gemini' | 'openai' | 'anthropic'
    geminiApiKey: '', geminiModel: 'gemini-3-pro-preview',
    openaiApiKey: '', openaiModel: 'gpt-5.6-sol',
    anthropicApiKey: '', anthropicModel: 'claude-opus-4-8',
};

// 저장된 설정 정규화 — 구버전 설정({geminiApiKey, aiModel})을 새 멀티 프로바이더 형태로 옮긴다
export function normalizeSettings(loadedSettings) {
    const loaded = (loadedSettings && typeof loadedSettings === 'object') ? loadedSettings : {};
    const settings = { ...DEFAULT_SETTINGS, ...loaded };
    // 레거시: aiModel은 Gemini 모델명이었다 — geminiModel이 없을 때만 이식
    if (!loaded.geminiModel && typeof loaded.aiModel === 'string' && loaded.aiModel.trim()) {
        settings.geminiModel = loaded.aiModel.trim();
    }
    if (!AI_PROVIDER_IDS.includes(settings.aiProvider)) settings.aiProvider = 'gemini';
    // 과거 기본값 승격: gpt-5.1은 이 앱이 잠시 쓰던 기본 모델명 — 새 기본(gpt-5.6-sol)으로 올린다
    if (settings.openaiModel === 'gpt-5.1') settings.openaiModel = DEFAULT_SETTINGS.openaiModel;
    return settings;
}

const AI_PROVIDER_IDS = ['gemini', 'openai', 'anthropic'];

const MIN_SEATS = 2;
const MAX_SEATS = 9;
const DEFAULT_PLAYER_COUNT = 6;

export function createInitialState() {
    return {
        schemaVersion: SCHEMA_VERSION,
        nav: ['home'], // 'home'|'game'|'history'|'profile'|'coach' 스택
        roster: [],
        settings: { ...DEFAULT_SETTINGS },
        session: null,
        archive: [],
        autoNext: { pending: false },
    };
}

export const initialState = createInitialState();

// ---------------------------------------------------------------------------
// 순수 헬퍼
// ---------------------------------------------------------------------------

function toPositiveNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
}

/** NaN·음수 블라인드 거부 → 기본값 대체 (설계 §6 START_SESSION) */
function sanitizeBlinds(blinds) {
    const sb = toPositiveNumber(blinds && blinds.sb);
    const bb = toPositiveNumber(blinds && blinds.bb);
    if (sb === null || bb === null) return { ...DEFAULT_BLINDS };
    return { sb, bb };
}

/**
 * straddleCount를 [0, max(0, 액티브 인원-3)]로 클램프한 세션 반환.
 * 좌석 구성이 바뀌어 스트래들이 불가능해진 경우(stale straddleCount) 방지 — 새 핸드를
 * 만드는 모든 경로(withRegeneratedHand·advanceHand)가 이 헬퍼를 거친다.
 */
function clampStraddle(session) {
    const active = session.seats.filter(x => !x.sittingOut).length;
    const max = Math.max(0, active - 3); // 스트래들 뒤에 최소 1명은 남아야 함
    const clamped = Math.min(Math.max(0, session.straddleCount || 0), max);
    return clamped === session.straddleCount ? session : { ...session, straddleCount: clamped };
}

/** 세션의 현재 좌석·딜러·스트래들로 새 currentHand 생성 (포지션 계산 포함) */
function buildCurrentHand(session, startedAt) {
    const positions = positionsForHand(session.seats, session.dealerSeat);
    return createHand({
        handNo: session.handNo,
        dealerSeat: session.dealerSeat,
        straddleCount: session.straddleCount,
        blinds: session.blinds,
        seats: session.seats,
        positions,
        startedAt: startedAt !== undefined ? startedAt : Date.now(),
    });
}

/**
 * 테이블 구성 변경(좌석·딜러·스트래들) 후 호출.
 * 액션이 아직 없는 핸드만 재생성한다 — 진행 중 핸드의 스냅샷은 보존.
 * 재생성 전 straddleCount를 클램프해 세션에도 반영한다.
 */
function withRegeneratedHand(session) {
    if (session.currentHand && session.currentHand.actions.length > 0) return session;
    const clamped = clampStraddle(session);
    const startedAt = clamped.currentHand ? clamped.currentHand.startedAt : undefined;
    return { ...clamped, currentHand: buildCurrentHand(clamped, startedAt) };
}

/** 진행 중 핸드(액션 1개 이상) 여부 — 구성 변경 액션의 가드 */
function isMidHand(session) {
    return !!(session.currentHand
        && (session.currentHand.actions.length > 0 || session.currentHand.detailed?.enabled));
}

function isCompletedSample(hand) {
    return !!hand && (!hand.detailed?.enabled || hand.detailed.completed === true);
}

function normalizeLoadedHand(hand) {
    if (hand?.detailed?.enabled) return normalizeDetailedHandRecord(hand);
    return isValidHandRecord(hand) ? hand : null;
}

/**
 * NEXT_HAND 핵심 로직 (AUTO_NEXT_FIRED와 공유).
 * currentHand.actions가 비었으면 레코드 저장 없이 딜러만 회전(쓰레기 레코드 방지, handNo 유지).
 * 있으면 endedAt 찍고 hands에 push, 딜러 회전, handNo+1, 새 currentHand 생성.
 */
function advanceHand(session, endedAt) {
    const cur = session.currentHand;
    if (cur?.detailed?.enabled && !cur.detailed.completed) return session;
    const shouldPersist = !!cur && (cur.actions.length > 0 || cur.detailed?.completed);
    if (!shouldPersist) {
        const next = clampStraddle({
            ...session,
            dealerSeat: nextDealerSeat(session.seats, session.dealerSeat),
        });
        return { ...next, currentHand: buildCurrentHand(next, undefined) };
    }
    const finished = { ...cur, endedAt: endedAt !== undefined ? endedAt : Date.now() };
    const next = clampStraddle({
        ...session,
        hands: [...session.hands, finished],
        dealerSeat: nextDealerSeat(session.seats, session.dealerSeat),
        handNo: session.handNo + 1,
    });
    return { ...next, currentHand: buildCurrentHand(next, undefined) };
}

// ---------------------------------------------------------------------------
// 리듀서
// ---------------------------------------------------------------------------

export function reducer(state, action) {
    switch (action.type) {
        // ── 영속화 ─────────────────────────────────────────────────────
        case 'LOAD_PERSISTED': {
            const payload = action.payload || {};
            const loaded = payload.state && typeof payload.state === 'object' ? payload.state : null;
            let session = loaded && loaded.session ? loaded.session : null;
            // 방어: 손상된 저장 데이터가 파생 계산(deriveHandState 등)에서 throw하지 않도록 검증
            if (session && Array.isArray(session.seats)) {
                const hands = Array.isArray(session.hands)
                    ? session.hands.map(normalizeLoadedHand).filter(Boolean)
                    : [];
                session = { ...session, hands };
                const currentHand = normalizeLoadedHand(session.currentHand);
                if (!currentHand) {
                    session = withRegeneratedHand({ ...session, currentHand: null });
                } else {
                    session = { ...session, currentHand };
                }
            } else if (session) {
                session = null; // 좌석 배열조차 없는 세션은 복원 불가
            }
            const archive = Array.isArray(payload.archive)
                ? payload.archive.map(rec =>
                    rec && typeof rec === 'object' && Array.isArray(rec.hands)
                        ? { ...rec, hands: rec.hands.map(normalizeLoadedHand).filter(Boolean) }
                        : rec)
                : state.archive;
            return {
                ...state,
                session,
                roster: loaded && Array.isArray(loaded.roster) ? loaded.roster : state.roster,
                settings: normalizeSettings(loaded && loaded.settings),
                archive,
                autoNext: { pending: !!session?.currentHand?.detailed?.completed },
            };
        }

        // ── 세션 수명 ──────────────────────────────────────────────────
        case 'START_SESSION': {
            const cfg = action.cfg || {};
            const requested = Number.parseInt(cfg.playerCount, 10);
            const playerCount = Number.isNaN(requested)
                ? DEFAULT_PLAYER_COUNT
                : Math.min(MAX_SEATS, Math.max(MIN_SEATS, requested));
            const names = Array.isArray(cfg.seatNames) ? cfg.seatNames : [];
            const seats = Array.from({ length: playerCount }, (_, i) =>
                createSeat(i, typeof names[i] === 'string' ? names[i] : undefined));
            const session = {
                id: newId('sess'),
                startedAt: cfg.startedAt !== undefined ? cfg.startedAt : Date.now(),
                blinds: sanitizeBlinds(cfg.blinds),
                currency: typeof cfg.currency === 'string' && cfg.currency !== '' ? cfg.currency : '$',
                seats,
                dealerSeat: 0,
                straddleCount: 0,
                handNo: 1,
                hands: [],
                currentHand: null,
            };
            session.currentHand = buildCurrentHand(session, session.startedAt);
            return { ...state, session, nav: ['home', 'game'], autoNext: { pending: false } };
        }

        case 'END_SESSION': {
            if (!state.session) return state; // 두 번째 END_SESSION은 no-op (이중 집계 차단)
            const s = state.session;
            const endedAt = action.endedAt !== undefined ? action.endedAt : Date.now();
            const hasCurrentRecord = s.currentHand
                && (s.currentHand.actions.length > 0 || s.currentHand.detailed?.enabled);
            const finishedCurrent = hasCurrentRecord
                ? {
                    ...s.currentHand,
                    endedAt,
                    status: s.currentHand.detailed?.enabled && !s.currentHand.detailed.completed
                        ? 'incomplete'
                        : (s.currentHand.status || 'complete'),
                }
                : null;
            const hands = finishedCurrent
                ? [...s.hands, finishedCurrent]
                : s.hands;
            const record = {
                id: s.id,
                schemaVersion: SCHEMA_VERSION,
                startedAt: s.startedAt,
                endedAt,
                blinds: s.blinds,
                currency: s.currency,
                totalHands: hands.filter(isCompletedSample).length,
                incompleteHands: hands.filter(hand => !isCompletedSample(hand)).length,
                hands,
            };
            return {
                ...state,
                session: null,
                archive: [...state.archive, record],
                nav: ['home'],
                autoNext: { pending: false },
            };
        }

        // ── 핸드 진행 ──────────────────────────────────────────────────
        case 'RECORD_ACTION': {
            if (!state.session || !state.session.currentHand) return state;
            const cur = state.session.currentHand;
            const next = applyAction(cur, action.seat, action.actionType);
            if (next === cur) return state; // 불법 액션 → no-op (참조 유지)
            const isOver = deriveHandState(next).isOver;
            return {
                ...state,
                session: { ...state.session, currentHand: next },
                autoNext: { pending: isOver },
            };
        }

        case 'ENABLE_DETAILED_TRACKING': {
            if (!state.session || !state.session.currentHand) return state;
            const cur = state.session.currentHand;
            const enabled = enableDetailedTracking(cur, action.options || {});
            if (enabled === cur) {
                return state.autoNext.pending ? { ...state, autoNext: { pending: false } } : state;
            }
            const currentHand = {
                ...enabled,
                schemaVersion: 2,
                status: 'in_progress',
                captureLevel: 'detailed',
                currency: state.session.currency,
            };
            return {
                ...state,
                session: { ...state.session, currentHand },
                autoNext: { pending: false },
            };
        }

        case 'DISABLE_DETAILED_TRACKING': {
            if (!state.session || !state.session.currentHand?.detailed?.enabled) return state;
            const cur = state.session.currentHand;
            const hasPostflopActions = cur.actions.some(a => a.street && a.street !== 'preflop');
            const hasBoard = Object.values(cur.detailed.board || {}).some(cards => Array.isArray(cards) && cards.length > 0);
            if (hasPostflopActions || hasBoard || cur.detailed.street !== 'preflop') return state;
            const quickHand = { ...cur };
            delete quickHand.detailed;
            delete quickHand.schemaVersion;
            delete quickHand.status;
            delete quickHand.captureLevel;
            return {
                ...state,
                session: { ...state.session, currentHand: quickHand },
                autoNext: { pending: deriveHandState(quickHand).isOver },
            };
        }

        case 'RECORD_DETAILED_ACTION': {
            if (!state.session || !state.session.currentHand?.detailed?.enabled) return state;
            const cur = state.session.currentHand;
            const next = applyDetailedAction(cur, action.seat, action.actionType, action.options || {});
            if (next === cur) return state;
            return {
                ...state,
                session: { ...state.session, currentHand: next },
                autoNext: { pending: false },
            };
        }

        case 'ADVANCE_DETAILED_STREET': {
            if (!state.session || !state.session.currentHand?.detailed?.enabled) return state;
            const cur = state.session.currentHand;
            const next = advanceDetailedStreet(cur, action.cards || []);
            if (next === cur) return state;
            return {
                ...state,
                session: { ...state.session, currentHand: next },
                autoNext: { pending: false },
            };
        }

        case 'SET_DETAILED_CARDS': {
            if (!state.session || !state.session.currentHand?.detailed?.enabled) return state;
            const cur = state.session.currentHand;
            const next = setDetailedCards(cur, action.payload || {});
            if (next === cur) return state;
            return { ...state, session: { ...state.session, currentHand: next } };
        }

        case 'COMPLETE_DETAILED_HAND': {
            if (!state.session || !state.session.currentHand?.detailed?.enabled) return state;
            const cur = state.session.currentHand;
            const next = completeDetailedHand(cur, action.payload || {});
            if (next === cur) return state;
            const currentHand = { ...next, status: 'complete' };
            return {
                ...state,
                session: { ...state.session, currentHand },
                autoNext: { pending: true },
            };
        }

        case 'UNDO': {
            if (!state.session) return state;
            const s = state.session;
            const cur = s.currentHand;
            if (cur?.detailed?.enabled) {
                const previous = undoDetailedStep(cur);
                if (previous === cur) return state;
                return {
                    ...state,
                    session: { ...s, currentHand: previous },
                    autoNext: { pending: false },
                };
            }
            if (cur && cur.actions.length > 0) {
                // 현재 핸드에서 마지막 액션 제거
                const trimmed = { ...cur, actions: cur.actions.slice(0, -1) };
                return { ...state, session: { ...s, currentHand: trimmed }, autoNext: { pending: false } };
            }
            if (s.hands.length > 0) {
                // 핸드 경계 넘기: 마지막 완료 핸드 pop → dealer/straddle/handNo 복원,
                // 마지막 액션 제거한 상태로 currentHand 복귀
                const prev = s.hands[s.hands.length - 1];
                const restoredBase = { ...prev, endedAt: null };
                const restored = prev.detailed?.enabled
                    ? undoDetailedStep(restoredBase)
                    : { ...restoredBase, actions: prev.actions.slice(0, -1) };
                return {
                    ...state,
                    session: {
                        ...s,
                        hands: s.hands.slice(0, -1),
                        dealerSeat: prev.dealerSeat,
                        straddleCount: prev.straddleCount,
                        handNo: prev.handNo,
                        currentHand: restored,
                    },
                    autoNext: { pending: false },
                };
            }
            // 되돌릴 것이 없어도 자동 다음핸드는 항상 취소
            return state.autoNext.pending ? { ...state, autoNext: { pending: false } } : state;
        }

        case 'NEXT_HAND': {
            if (!state.session) return state;
            const session = advanceHand(state.session, action.endedAt);
            if (session === state.session) return state;
            return { ...state, session, autoNext: { pending: false } };
        }

        case 'AUTO_NEXT_FIRED': {
            if (!state.autoNext.pending) return state; // 멱등 — 타이머가 몇 번 울려도 1회만 적용
            if (!state.session) return { ...state, autoNext: { pending: false } };
            return { ...state, session: advanceHand(state.session, action.endedAt), autoNext: { pending: false } };
        }

        case 'CANCEL_AUTO_NEXT':
            return state.autoNext.pending ? { ...state, autoNext: { pending: false } } : state;

        // ── 테이블 구성 ────────────────────────────────────────────────
        case 'TOGGLE_SITOUT': {
            if (!state.session) return state;
            const s = state.session;
            if (s.currentHand?.detailed?.enabled) return state;
            const seatRec = s.seats.find(x => x.seat === action.seat);
            if (!seatRec) return state;

            let currentHand = s.currentHand;
            let pending = state.autoNext.pending;
            if (!seatRec.sittingOut && currentHand && currentHand.actions.length > 0) {
                // 진행 중 핸드의 살아있는(미폴드) 플레이어면 차례와 무관하게 fold 기록
                // (자리 비움 = 아웃오브턴 강제 폴드; 이미 폴드·핸드 종료면 forceFold가 no-op)
                const afterFold = forceFold(currentHand, action.seat);
                if (afterFold !== currentHand) {
                    currentHand = afterFold;
                    pending = deriveHandState(afterFold).isOver;
                }
            }
            const seats = s.seats.map(x =>
                x.seat === action.seat ? { ...x, sittingOut: !x.sittingOut } : x);
            const session = withRegeneratedHand({ ...s, seats, currentHand });
            return { ...state, session, autoNext: { pending } };
        }

        case 'SET_DEALER': {
            if (!state.session) return state;
            const s = state.session;
            if (isMidHand(s)) return state; // 핸드 사이 전용 — 진행 중에는 no-op
            if (s.dealerSeat === action.seat || !s.seats.some(x => x.seat === action.seat)) return state;
            return { ...state, session: withRegeneratedHand({ ...s, dealerSeat: action.seat }) };
        }

        case 'CYCLE_STRADDLE': {
            if (!state.session) return state;
            const s = state.session;
            if (isMidHand(s)) return state; // 핸드 사이 전용 — 진행 중에는 no-op
            const active = s.seats.filter(x => !x.sittingOut).length;
            const maxStraddle = Math.max(0, active - 3); // 스트래들 뒤에 최소 1명은 남아야 함
            const next = maxStraddle === 0 ? 0 : (s.straddleCount + 1) % (maxStraddle + 1);
            if (next === s.straddleCount) return state;
            return { ...state, session: withRegeneratedHand({ ...s, straddleCount: next }) };
        }

        case 'ADD_SEAT': {
            if (!state.session) return state;
            const s = state.session;
            if (isMidHand(s)) return state; // 핸드 사이 전용 — 진행 중에는 no-op
            if (s.seats.length >= MAX_SEATS) return state;
            const nextNo = s.seats.reduce((m, x) => Math.max(m, x.seat), -1) + 1;
            const seats = [...s.seats, createSeat(nextNo, typeof action.name === 'string' ? action.name : undefined)];
            return { ...state, session: withRegeneratedHand({ ...s, seats }) };
        }

        case 'REMOVE_SEAT': {
            if (!state.session) return state;
            const s = state.session;
            if (isMidHand(s)) return state; // 핸드 사이 전용 — toActSeat 고아화 방지
            if (s.seats.length <= MIN_SEATS) return state;
            const target = typeof action.seat === 'number' ? action.seat : s.seats[s.seats.length - 1].seat;
            if (!s.seats.some(x => x.seat === target)) return state;
            const seats = s.seats.filter(x => x.seat !== target);
            const dealerSeat = s.dealerSeat === target ? nextDealerSeat(seats, target) : s.dealerSeat;
            return { ...state, session: withRegeneratedHand({ ...s, seats, dealerSeat }) };
        }

        case 'RENAME_SEAT': {
            // 진행 중에도 허용 (이름 교정 기능) — 스냅샷·액션 레코드에도 새 이름 전파
            if (!state.session) return state;
            const s = state.session;
            const name = typeof action.name === 'string' ? action.name.trim() : '';
            if (name === '') return state;
            const seatRec = s.seats.find(x => x.seat === action.seat);
            if (!seatRec || seatRec.name === name) return state;
            const seats = s.seats.map(x => (x.seat === action.seat ? { ...x, name } : x));
            if (isMidHand(s)) {
                const cur = s.currentHand;
                const currentHand = {
                    ...cur,
                    seats: cur.seats.map(x => (x.seat === action.seat ? { ...x, name } : x)),
                    actions: cur.actions.map(a => (a.seat === action.seat ? { ...a, name } : a)),
                };
                return { ...state, session: { ...s, seats, currentHand } };
            }
            return { ...state, session: withRegeneratedHand({ ...s, seats }) };
        }

        case 'SWAP_SEATS': {
            if (!state.session) return state;
            const s = state.session;
            if (isMidHand(s)) return state; // 핸드 사이 전용 — 진행 중에는 no-op
            const a = s.seats.find(x => x.seat === action.a);
            const b = s.seats.find(x => x.seat === action.b);
            if (!a || !b || a === b) return state;
            const seats = s.seats.map(x => {
                if (x.seat === a.seat) return { ...x, name: b.name, sittingOut: b.sittingOut };
                if (x.seat === b.seat) return { ...x, name: a.name, sittingOut: a.sittingOut };
                return x;
            });
            return { ...state, session: withRegeneratedHand({ ...s, seats }) };
        }

        // ── 로스터 · 아카이브 · 설정 ───────────────────────────────────
        case 'ADD_ROSTER': {
            const name = typeof action.name === 'string' ? action.name.trim() : '';
            if (name === '' || state.roster.includes(name)) return state;
            return { ...state, roster: [...state.roster, name] };
        }

        case 'REMOVE_ROSTER': {
            const name = typeof action.name === 'string' ? action.name.trim() : '';
            if (!state.roster.includes(name)) return state;
            return { ...state, roster: state.roster.filter(n => n !== name) };
        }

        case 'DELETE_ARCHIVED': {
            const next = state.archive.filter(x => x.id !== action.id);
            return next.length === state.archive.length ? state : { ...state, archive: next };
        }

        case 'UPDATE_SETTINGS':
            return { ...state, settings: { ...state.settings, ...(action.patch || {}) } };

        // ── 내비게이션 ─────────────────────────────────────────────────
        case 'NAV_PUSH': {
            if (!SCREENS.includes(action.screen)) return state;
            if (state.nav[state.nav.length - 1] === action.screen) return state; // 중복 push 방지
            return { ...state, nav: [...state.nav, action.screen] };
        }

        case 'NAV_POP':
            return state.nav.length > 1 ? { ...state, nav: state.nav.slice(0, -1) } : state;

        case 'NAV_HOME':
            return state.nav.length === 1 && state.nav[0] === 'home'
                ? state
                : { ...state, nav: ['home'] };

        // ── 초기화 ─────────────────────────────────────────────────────
        case 'RESET_ALL':
            // 리듀서는 순수하게 초기 상태만 반환 — 실제 스토리지 삭제는 GameContext 래퍼가 수행
            return createInitialState();

        default:
            return state;
    }
}
