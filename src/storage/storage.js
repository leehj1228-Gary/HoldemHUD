// 버전드 영속화 + v33 레거시 마이그레이션 (docs/REBUILD_DESIGN.md §5)
// 순수 모듈: React·DOM import 금지. localStorage는 주입 가능한 어댑터로 접근.

import { SCHEMA_VERSION, newId, isValidActionType, isValidHandRecord, createAction } from '../engine/schema.js';

// ── 키 정의 ──────────────────────────────────────────────────────────
export const STATE_KEY = 'hh:v1:state';
export const ARCHIVE_KEY = 'hh:v1:archive';

// STATE_KEY의 최신 포맷. 상태와 아카이브를 같은 localStorage 값에 넣어
// setItem 1회로 커밋한다. ARCHIVE_KEY는 구 split 포맷을 읽기 위한 호환 키다.
export const PERSISTENCE_ENVELOPE_VERSION = 1;

// 저장 크기 경고 임계값 (바이트). localStorage는 UTF-16으로 저장하므로
// 문자열 길이 × 2로 근사한다. 초과 시 savePersisted가 console.warn을 남기고,
// GameContext가 내보내기/삭제를 안내하는 alert를 1회 띄운다.
export const PERSISTED_SIZE_WARN_BYTES = 4 * 1024 * 1024;

// 구 버전(v33) 키 전체 목록 — resetAllData에서 함께 삭제, 마이그레이션에서 읽기만 함
export const LEGACY_KEYS = {
    PLAYERS: 'poker_players_v33',
    DEALER: 'poker_dealer_v33',
    ROSTER: 'poker_roster_v33',
    RAISE_COUNT: 'poker_raise_count_v33',
    STRADDLE: 'poker_straddle_v33',
    ACTION_INDEX: 'poker_action_index_v33',
    AGGRESSOR: 'poker_aggressor_v33',
    STRAD_FLAG: 'poker_strad_flag_v33',
    HISTORY: 'poker_history_v33',
    SESSION_HANDS: 'poker_session_hands_v33',
    SESSION_HANDS_LIST: 'poker_session_hands_list_v33',
    HAND_ACTIONS: 'poker_hand_actions_v33',
    BLINDS: 'poker_blinds_v33',
    CURRENCY: 'poker_currency_v33',
    SESSION_DATE: 'poker_session_date_v33',
};

// ── 스토리지 어댑터 (node 테스트 환경에서 in-memory mock 주입 가능) ──
let storageAdapter = null;

/**
 * localStorage 대체 어댑터 주입. null을 넘기면 기본(globalThis.localStorage)으로 복귀.
 * @param {{getItem:Function,setItem:Function,removeItem:Function}|null} obj
 */
export function setStorageAdapter(obj) {
    storageAdapter = obj || null;
}

function getStorage() {
    if (storageAdapter) return storageAdapter;
    try {
        if (typeof globalThis !== 'undefined' && globalThis.localStorage) {
            return globalThis.localStorage;
        }
    } catch {
        // 일부 환경(SecurityError 등)에서 localStorage 접근 자체가 throw할 수 있음
    }
    return null;
}

// ── 내부 헬퍼: 모든 읽기/파싱을 가드 ─────────────────────────────────
function safeGetItem(key) {
    const storage = getStorage();
    if (!storage) return null;
    try {
        const v = storage.getItem(key);
        return v === undefined ? null : v;
    } catch (e) {
        console.error(`[storage] ${key} 읽기 실패:`, e);
        return null;
    }
}

function safeParseJSON(key, defaultValue) {
    const raw = safeGetItem(key);
    if (raw === null || raw === '') return defaultValue;
    try {
        return JSON.parse(raw);
    } catch (e) {
        console.error(`[storage] ${key} JSON 파싱 실패:`, e);
        return defaultValue;
    }
}

function safeSetString(key, serialized) {
    const storage = getStorage();
    if (!storage) return false;
    try {
        storage.setItem(key, serialized);
        return true;
    } catch (e) {
        // QuotaExceededError 포함 — 흡수하고 boolean으로 알림
        console.error(`[storage] ${key} 저장 실패:`, e);
        return false;
    }
}

// localStorage는 문자열을 UTF-16으로 저장한다 — 코드 유닛당 2바이트로 근사
function utf16ByteSize(serialized) {
    return typeof serialized === 'string' ? serialized.length * 2 : 0;
}

function isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isPersistenceEnvelope(value) {
    return isObject(value)
        && value.persistenceEnvelopeVersion === PERSISTENCE_ENVELOPE_VERSION
        && Object.prototype.hasOwnProperty.call(value, 'state')
        && Object.prototype.hasOwnProperty.call(value, 'archive');
}

function normalizeStateAtom(value) {
    if (!isObject(value)) return null;
    return { schemaVersion: SCHEMA_VERSION, ...value };
}

// 마이그레이션을 실행하지 않고 현재 v1 저장값만 읽는다. 호환 API가 나머지
// 절반을 보존한 채 새 envelope를 쓸 때도 사용한다.
function readV1Snapshot() {
    const rawState = safeParseJSON(STATE_KEY, null);
    if (isPersistenceEnvelope(rawState)) {
        return {
            state: normalizeStateAtom(rawState.state),
            archive: Array.isArray(rawState.archive) ? rawState.archive : [],
            envelope: true,
        };
    }

    const rawArchive = safeParseJSON(ARCHIVE_KEY, null);
    return {
        state: isObject(rawState) ? rawState : null,
        archive: Array.isArray(rawArchive) ? rawArchive : [],
        envelope: false,
    };
}

// NaN-safe 정수 파싱: 실패 시 fallback 반환
function toInt(value, fallback) {
    const n = Number.parseInt(value, 10);
    return Number.isNaN(n) ? fallback : n;
}

// ── 공개 API ─────────────────────────────────────────────────────────

/**
 * 영속화된 v1 상태·아카이브 로드.
 * v1 상태가 없으면 migrateFromLegacy()를 시도하고, 성공 시 결과를 v1 키에 저장한다.
 * @returns {{state: object|null, archive: Array}}
 */
export function loadPersisted() {
    const stored = readV1Snapshot();

    // envelope가 있으면 이것만 권위 있는 스냅샷으로 취급한다. 구 ARCHIVE_KEY에
    // stale 값이 남아 있어도 섞지 않는다.
    if (stored.envelope) {
        return { state: stored.state, archive: stored.archive };
    }

    if (stored.state) {
        // 기존 split 저장을 읽은 즉시 한 값으로 승격한다. 실패하면 기존 두 키를
        // 그대로 읽을 수 있으므로 데이터는 훼손되지 않는다.
        savePersisted({ state: stored.state, archive: stored.archive });
        return { state: stored.state, archive: stored.archive };
    }

    // v1 상태 없음 → 레거시(v33) 마이그레이션 시도
    const migrated = migrateFromLegacy();
    if (migrated.state) {
        // 다음 로드부터는 v1 경로를 타도록 원자 저장
        // (실패해도 무해 — 다음에 다시 마이그레이션됨)
        savePersisted(migrated);
        return migrated;
    }

    return { state: null, archive: stored.archive };
}

/**
 * 상태 원자와 아카이브를 단일 envelope로 저장한다. localStorage.setItem 1회가
 * 성공해야만 둘 다 새 스냅샷으로 보이므로 END_SESSION 중간 상태가 남지 않는다.
 * 직렬화된 envelope 크기를 함께 반환하고, 경고 임계(4MB) 초과 시 console.warn.
 * @param {{state: object|null, archive: Array}} snapshot
 * @returns {{ok: boolean, bytes: number}} 저장 성공 여부 + envelope 크기(바이트)
 */
export function savePersisted(snapshot) {
    const state = normalizeStateAtom(snapshot?.state);
    const archive = Array.isArray(snapshot?.archive) ? snapshot.archive : [];
    let serialized;
    try {
        serialized = JSON.stringify({
            persistenceEnvelopeVersion: PERSISTENCE_ENVELOPE_VERSION,
            schemaVersion: SCHEMA_VERSION,
            state,
            archive,
        });
    } catch (e) {
        // 순환 참조 등 직렬화 자체 실패 — 흡수하고 실패로 알림
        console.error(`[storage] ${STATE_KEY} 직렬화 실패:`, e);
        return { ok: false, bytes: 0 };
    }
    const bytes = utf16ByteSize(serialized);
    if (bytes > PERSISTED_SIZE_WARN_BYTES) {
        console.warn(`[storage] 저장 데이터 ${(bytes / (1024 * 1024)).toFixed(1)}MB — 경고 임계 4MB 초과`);
    }
    return { ok: safeSetString(STATE_KEY, serialized), bytes };
}

/**
 * 현재 저장된 envelope 크기 정보 (저장 없이 조회).
 * @returns {{bytes: number, warnThresholdBytes: number, exceedsWarnThreshold: boolean}}
 */
export function getPersistedSizeInfo() {
    const bytes = utf16ByteSize(safeGetItem(STATE_KEY));
    return {
        bytes,
        warnThresholdBytes: PERSISTED_SIZE_WARN_BYTES,
        exceedsWarnThreshold: bytes > PERSISTED_SIZE_WARN_BYTES,
    };
}

/**
 * 상태 원자({schemaVersion, session, roster, settings}) 저장.
 * quota 초과 등 예외는 흡수하고 false 반환.
 * @param {object} partialAtom
 * @returns {boolean} 저장 성공 여부
 */
export function savePersistedState(partialAtom) {
    const payload = { schemaVersion: SCHEMA_VERSION, ...(partialAtom || {}) };
    const current = readV1Snapshot();
    return savePersisted({ state: payload, archive: current.archive }).ok;
}

/**
 * 아카이브(SessionRecord[]) 저장. 예외는 흡수하고 false 반환.
 * @param {Array} archive
 * @returns {boolean} 저장 성공 여부
 */
export function saveArchive(archive) {
    const current = readV1Snapshot();
    return savePersisted({ state: current.state, archive }).ok;
}

/**
 * v1 키 + 레거시 v33 키 전부 삭제 (완전 초기화).
 * @returns {boolean} 성공 여부
 */
export function resetAllData() {
    const storage = getStorage();
    if (!storage) return false;
    const allKeys = [STATE_KEY, ARCHIVE_KEY, ...Object.values(LEGACY_KEYS)];
    let ok = true;
    for (const key of allKeys) {
        try {
            storage.removeItem(key);
        } catch (e) {
            console.error(`[storage] ${key} 삭제 실패:`, e);
            ok = false;
        }
    }
    return ok;
}

// ── v33 → v1 마이그레이션 ────────────────────────────────────────────

// 레거시 detail 문자열('2-Bet','3-Bet',…) → raiseLevel (2-Bet→1, 3-Bet→2 …). 파싱 불가 시 null.
function raiseLevelFromDetail(detail) {
    if (typeof detail !== 'string') return null;
    const m = /^(\d+)-Bet$/i.exec(detail.trim());
    if (!m) return null;
    const n = Number.parseInt(m[1], 10);
    if (Number.isNaN(n) || n < 2) return null;
    return n - 1;
}

// 레거시 스냅샷 position → { sittingOut, position }
// 'SitOut' 또는 '' (또는 null/undefined) → sittingOut:true, position:null
function normalizeSnapshotPosition(rawPosition) {
    if (rawPosition === 'SitOut' || rawPosition === '' || rawPosition === null || rawPosition === undefined) {
        return { sittingOut: true, position: null };
    }
    return { sittingOut: false, position: String(rawPosition) };
}

// 레거시 핸드 1개 → HandRecord. 파싱 불가면 null (호출부가 스킵·카운트).
function convertLegacyHand(legacyHand, fallbackHandNo) {
    if (!legacyHand || typeof legacyHand !== 'object') return null;
    if (!Array.isArray(legacyHand.playersSnapshot) || !Array.isArray(legacyHand.actions)) return null;

    const dealerSeat = toInt(legacyHand.dealerIndex, NaN);
    if (Number.isNaN(dealerSeat)) return null;

    // seats: playersSnapshot의 seat는 0-based 그대로 사용
    const seats = [];
    for (const snap of legacyHand.playersSnapshot) {
        if (!snap || typeof snap !== 'object') return null;
        const seat = toInt(snap.seat, NaN);
        if (Number.isNaN(seat)) return null;
        const { sittingOut, position } = normalizeSnapshotPosition(snap.position);
        seats.push({
            seat,
            name: typeof snap.name === 'string' ? snap.name.trim() : String(snap.name ?? ''),
            sittingOut,
            position,
        });
    }

    // actions: seat := playerIndex (구 1-based `seat` 필드는 무시!)
    const actions = [];
    let raiseCountSoFar = 0; // detail 없는 raise의 raiseLevel 리플레이 계산용
    for (let i = 0; i < legacyHand.actions.length; i++) {
        const la = legacyHand.actions[i];
        if (!la || typeof la !== 'object') return null;

        const seat = toInt(la.playerIndex, NaN);
        if (Number.isNaN(seat)) return null;

        const type = la.type;
        if (!isValidActionType(type)) return null;

        let raiseLevel = 0;
        if (type === 'raise') {
            const fromDetail = raiseLevelFromDetail(la.detail);
            raiseLevel = fromDetail !== null ? fromDetail : raiseCountSoFar + 1;
            raiseCountSoFar += 1;
        }

        const posRaw = la.position;
        const position = (posRaw === 'SitOut' || posRaw === '' || posRaw === null || posRaw === undefined)
            ? null
            : String(posRaw);

        actions.push(createAction({
            seq: toInt(la.seq, i + 1),
            seat,
            name: typeof la.name === 'string' ? la.name.trim() : String(la.name ?? ''),
            position,
            type,
            raiseLevel,
        }));
    }

    const hand = {
        id: legacyHand.id !== undefined && legacyHand.id !== null ? String(legacyHand.id) : newId('hand'),
        handNo: toInt(legacyHand.handId, fallbackHandNo),
        startedAt: typeof legacyHand.timestamp === 'string' ? legacyHand.timestamp : null,
        endedAt: typeof legacyHand.timestamp === 'string' ? legacyHand.timestamp : null,
        dealerSeat,
        straddleCount: toInt(legacyHand.straddleCount, 0),
        blinds: null,
        seats,
        actions,
    };

    return isValidHandRecord(hand) ? hand : null;
}

// 레거시 세션 1개 → SessionRecord. 세션 자체가 파싱 불가면 null.
function convertLegacySession(legacySession, currency, skipCounter) {
    if (!legacySession || typeof legacySession !== 'object') return null;

    const legacyHands = Array.isArray(legacySession.hands) ? legacySession.hands : [];
    const hands = [];
    for (let i = 0; i < legacyHands.length; i++) {
        let converted = null;
        try {
            converted = convertLegacyHand(legacyHands[i], i + 1);
        } catch {
            converted = null;
        }
        if (converted) {
            hands.push(converted);
        } else {
            skipCounter.count += 1;
        }
    }

    const date = typeof legacySession.date === 'string' ? legacySession.date : null;

    return {
        id: legacySession.id !== undefined && legacySession.id !== null ? String(legacySession.id) : newId('sess'),
        schemaVersion: SCHEMA_VERSION,
        startedAt: date,
        endedAt: date,
        blinds: null,
        currency,
        totalHands: toInt(legacySession.totalHands, hands.length),
        hands,
        legacy: true,
    };
}

/**
 * 구 poker_*_v33 키 → v1 형식으로 변환. **구 키는 삭제하지 않음** (롤백 안전).
 * 레거시 데이터가 전혀 없으면 { state: null, archive: [] }.
 * 파싱 실패 핸드는 건너뛰고 개수를 1회 로깅한다.
 * @returns {{state: object|null, archive: Array}}
 */
export function migrateFromLegacy() {
    const legacyHistory = safeParseJSON(LEGACY_KEYS.HISTORY, null);
    const legacyRoster = safeParseJSON(LEGACY_KEYS.ROSTER, null);

    const hasHistory = Array.isArray(legacyHistory) && legacyHistory.length > 0;
    const hasRoster = Array.isArray(legacyRoster) && legacyRoster.length > 0;
    if (!hasHistory && !hasRoster) {
        return { state: null, archive: [] };
    }

    const currencyRaw = safeGetItem(LEGACY_KEYS.CURRENCY);
    const currency = (typeof currencyRaw === 'string' && currencyRaw !== '') ? currencyRaw : '$';

    const skipCounter = { count: 0 };
    const archive = [];
    if (hasHistory) {
        for (const legacySession of legacyHistory) {
            let converted = null;
            try {
                converted = convertLegacySession(legacySession, currency, skipCounter);
            } catch {
                converted = null;
            }
            if (converted) archive.push(converted);
        }
    }

    if (skipCounter.count > 0) {
        console.warn(`[storage] v33 마이그레이션: 파싱 불가 핸드 ${skipCounter.count}개 건너뜀`);
    }

    const roster = hasRoster
        ? legacyRoster.filter(n => typeof n === 'string').map(n => n.trim()).filter(n => n !== '')
        : [];

    const state = {
        schemaVersion: SCHEMA_VERSION,
        session: null,
        roster,
        settings: { geminiApiKey: '', aiModel: 'gemini-3-pro-preview' },
    };

    return { state, archive };
}
