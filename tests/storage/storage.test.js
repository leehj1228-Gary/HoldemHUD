// storage.js 테스트 — v1 왕복 / quota 흡수 / v33 마이그레이션 골든 / 리셋 / 빈 스토리지
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    STATE_KEY,
    ARCHIVE_KEY,
    LEGACY_KEYS,
    setStorageAdapter,
    loadPersisted,
    savePersistedState,
    saveArchive,
    resetAllData,
    migrateFromLegacy,
} from '../../src/storage/storage.js';

// in-memory localStorage mock (node 환경엔 localStorage 없음)
function memoryStorage() {
    const map = new Map();
    return {
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => { map.set(k, String(v)); },
        removeItem: (k) => { map.delete(k); },
        _map: map,
    };
}

let mem;

beforeEach(() => {
    mem = memoryStorage();
    setStorageAdapter(mem);
});

afterEach(() => {
    setStorageAdapter(null);
    vi.restoreAllMocks();
});

// ── 골든 레거시 픽스처 (실제 v33 GameContext.nextHand가 만드는 형태 그대로) ──
function buildLegacyFixture() {
    // 정상 핸드 1: '2-Bet'/'3-Bet' detail 포함, SitOut 스냅샷 포함, 1-based seat 필드 포함
    const goodHand1 = {
        id: 1720000000001,
        handId: 1,
        timestamp: '2026-06-01T10:01:00.000Z',
        dealerIndex: 0,
        playersCount: 5,
        straddleCount: 0,
        actions: [
            // 구코드는 seat: playerIndex+1 (1-based!) — 마이그레이션은 이걸 무시해야 함
            { seq: 1, playerIndex: 3, seat: 4, name: 'Gary', position: 'UTG', type: 'raise', action: 'Raise', detail: '2-Bet', street: 'Preflop', timestamp: 1 },
            { seq: 2, playerIndex: 0, seat: 1, name: 'HD', position: 'BTN', type: 'raise', action: 'Raise', detail: '3-Bet', street: 'Preflop', timestamp: 2 },
            { seq: 3, playerIndex: 1, seat: 2, name: 'Inu', position: 'SB', type: 'fold', action: 'Fold', detail: '', street: 'Preflop', timestamp: 3 },
            { seq: 4, playerIndex: 2, seat: 3, name: 'Sim', position: 'BB', type: 'fold', action: 'Fold', detail: '', street: 'Preflop', timestamp: 4 },
            { seq: 5, playerIndex: 3, seat: 4, name: 'Gary', position: 'UTG', type: 'fold', action: 'Fold', detail: '', street: 'Preflop', timestamp: 5 },
        ],
        playersSnapshot: [
            { seat: 0, name: 'HD', position: 'BTN' },
            { seat: 1, name: 'Inu', position: 'SB' },
            { seat: 2, name: 'Sim', position: 'BB' },
            { seat: 3, name: 'Gary', position: 'UTG' },
            { seat: 4, name: 'PSC', position: 'SitOut' }, // SitOut 스냅샷
        ],
    };

    // 정상 핸드 2: detail 없는 raise → 리플레이 순번으로 raiseLevel 계산, '' position 스냅샷 포함
    const goodHand2 = {
        id: 1720000000002,
        handId: 2,
        timestamp: '2026-06-01T10:02:00.000Z',
        dealerIndex: 1,
        playersCount: 5,
        straddleCount: 1,
        actions: [
            { seq: 1, playerIndex: 2, seat: 3, name: 'Sim', position: 'UTG', type: 'raise', action: 'Raise', detail: '', street: 'Preflop', timestamp: 1 },
            { seq: 2, playerIndex: 0, seat: 1, name: 'HD', position: 'CO', type: 'raise', action: 'Raise', street: 'Preflop', timestamp: 2 }, // detail 자체가 없음
            { seq: 3, playerIndex: 2, seat: 3, name: 'Sim', position: 'UTG', type: 'call', action: 'Call', detail: '', street: 'Preflop', timestamp: 3 },
        ],
        playersSnapshot: [
            { seat: 0, name: 'HD', position: 'CO' },
            { seat: 1, name: 'Inu', position: 'BTN' },
            { seat: 2, name: 'Sim', position: 'UTG' },
            { seat: 3, name: 'Gary', position: '' }, // '' → sittingOut 처리
            { seat: 4, name: 'PSC', position: 'SB' },
        ],
    };

    // 손상 핸드: playerIndex가 숫자로 파싱 불가 → 통째로 스킵되어야 함
    const corruptHand = {
        id: 1720000000003,
        handId: 3,
        timestamp: '2026-06-01T10:03:00.000Z',
        dealerIndex: 2,
        playersCount: 5,
        straddleCount: 0,
        actions: [
            { seq: 1, playerIndex: 'oops', seat: 1, name: '???', position: 'BTN', type: 'raise', detail: '2-Bet', street: 'Preflop' },
        ],
        playersSnapshot: [
            { seat: 0, name: 'HD', position: 'BTN' },
        ],
    };

    const legacySession = {
        id: 1720000000000,
        date: '2026-06-01T10:00:00.000Z',
        players: [{ name: 'HD' }, { name: 'Inu' }], // 구 플레이어 객체 (마이그레이션에서 안 씀)
        totalHands: 3,
        hands: [goodHand1, goodHand2, corruptHand],
    };

    mem.setItem(LEGACY_KEYS.HISTORY, JSON.stringify([legacySession]));
    mem.setItem(LEGACY_KEYS.ROSTER, JSON.stringify(['Gary', 'HD', '  Inu ', 42, '']));
    mem.setItem(LEGACY_KEYS.CURRENCY, '₩');
    mem.setItem(LEGACY_KEYS.DEALER, '1');
    mem.setItem(LEGACY_KEYS.BLINDS, JSON.stringify({ sb: 1, bb: 2 }));
}

// ── 1. v1 왕복 ──────────────────────────────────────────────────────
describe('v1 roundtrip', () => {
    it('savePersistedState → loadPersisted 왕복 보존', () => {
        const atom = {
            schemaVersion: 1,
            session: { id: 'sess_x', handNo: 3, seats: [{ seat: 0, name: 'A', sittingOut: false }] },
            roster: ['A', 'B'],
            settings: { geminiApiKey: 'k', aiModel: 'gemini-3-pro-preview' },
        };
        const archive = [{ id: 's1', schemaVersion: 1, totalHands: 2, hands: [] }];

        expect(savePersistedState(atom)).toBe(true);
        expect(saveArchive(archive)).toBe(true);

        const loaded = loadPersisted();
        expect(loaded.state).toEqual(atom);
        expect(loaded.archive).toEqual(archive);
    });

    it('schemaVersion 누락 시 저장할 때 채워 넣음', () => {
        savePersistedState({ session: null, roster: [], settings: {} });
        const loaded = loadPersisted();
        expect(loaded.state.schemaVersion).toBe(1);
    });

    it('손상된 v1 JSON은 throw 없이 무시', () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        mem.setItem(STATE_KEY, '{not json');
        mem.setItem(ARCHIVE_KEY, '[broken');
        const loaded = loadPersisted();
        expect(loaded.state).toBeNull();
        expect(loaded.archive).toEqual([]);
    });
});

// ── 2. quota 에러 흡수 ──────────────────────────────────────────────
describe('quota error swallowed', () => {
    it('setItem throw 시 false 반환, 예외 전파 없음', () => {
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        setStorageAdapter({
            getItem: () => null,
            setItem: () => { throw new DOMException('quota', 'QuotaExceededError'); },
            removeItem: () => {},
        });
        expect(savePersistedState({ session: null })).toBe(false);
        expect(saveArchive([{ id: 'x' }])).toBe(false);
        expect(errSpy).toHaveBeenCalled();
    });
});

// ── 3. v33 마이그레이션 골든 픽스처 ─────────────────────────────────
describe('migrateFromLegacy', () => {
    it('세션·핸드·액션이 설계 매핑대로 변환된다', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        buildLegacyFixture();

        const { state, archive } = migrateFromLegacy();

        // state: roster 이식(문자열만, trim, 빈문자열 제거) + 기본 settings
        expect(state).not.toBeNull();
        expect(state.schemaVersion).toBe(1);
        expect(state.session).toBeNull();
        expect(state.roster).toEqual(['Gary', 'HD', 'Inu']);
        expect(state.settings).toEqual({ geminiApiKey: '', aiModel: 'gemini-3-pro-preview' });

        // 세션 레코드 매핑
        expect(archive).toHaveLength(1);
        const sess = archive[0];
        expect(sess.legacy).toBe(true);
        expect(sess.blinds).toBeNull();
        expect(sess.currency).toBe('₩'); // 구 CURRENCY 키 값
        expect(sess.schemaVersion).toBe(1);
        expect(sess.id).toBe('1720000000000');
        expect(sess.startedAt).toBe('2026-06-01T10:00:00.000Z');
        expect(sess.totalHands).toBe(3);

        // 손상 핸드 1개 스킵 → 2개만 남고, 경고 로그는 1회
        expect(sess.hands).toHaveLength(2);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0][0]).toContain('1');

        const [h1, h2] = sess.hands;

        // 핸드 1: dealerSeat=dealerIndex, seat=playerIndex (1-based seat 필드 무시)
        expect(h1.dealerSeat).toBe(0);
        expect(h1.handNo).toBe(1);
        expect(h1.straddleCount).toBe(0);
        expect(h1.blinds).toBeNull();
        expect(h1.actions[0].seat).toBe(3); // playerIndex — 구 seat:4가 아님!
        expect(h1.actions[1].seat).toBe(0);
        expect(h1.actions.every(a => a.street === 'preflop')).toBe(true);

        // raiseLevel: detail 우선 ('2-Bet'→1, '3-Bet'→2), raise 아니면 0
        expect(h1.actions[0].raiseLevel).toBe(1);
        expect(h1.actions[1].raiseLevel).toBe(2);
        expect(h1.actions[2].raiseLevel).toBe(0);

        // 스냅샷: SitOut → sittingOut:true, position:null / 그 외 저장값 유지
        const sitOutSeat = h1.seats.find(s => s.seat === 4);
        expect(sitOutSeat.sittingOut).toBe(true);
        expect(sitOutSeat.position).toBeNull();
        const btnSeat = h1.seats.find(s => s.seat === 0);
        expect(btnSeat.sittingOut).toBe(false);
        expect(btnSeat.position).toBe('BTN');

        // 핸드 2: detail 없는 raise → 리플레이 순번 계산 (1번째=1, 2번째=2)
        expect(h2.actions[0].raiseLevel).toBe(1);
        expect(h2.actions[1].raiseLevel).toBe(2);
        expect(h2.straddleCount).toBe(1);
        // '' position → sittingOut 처리
        const emptyPosSeat = h2.seats.find(s => s.seat === 3);
        expect(emptyPosSeat.sittingOut).toBe(true);
        expect(emptyPosSeat.position).toBeNull();
    });

    it('마이그레이션은 레거시 키를 삭제하지 않는다 (롤백 안전)', () => {
        buildLegacyFixture();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        migrateFromLegacy();
        expect(mem.getItem(LEGACY_KEYS.HISTORY)).not.toBeNull();
        expect(mem.getItem(LEGACY_KEYS.ROSTER)).not.toBeNull();
        expect(mem.getItem(LEGACY_KEYS.CURRENCY)).toBe('₩');
    });

    it('레거시 데이터가 없으면 { state:null, archive:[] }', () => {
        expect(migrateFromLegacy()).toEqual({ state: null, archive: [] });
    });

    it('loadPersisted: v1 없으면 마이그레이션으로 폴백하고 결과를 v1에 저장', () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        buildLegacyFixture();

        const loaded = loadPersisted();
        expect(loaded.state).not.toBeNull();
        expect(loaded.state.roster).toEqual(['Gary', 'HD', 'Inu']);
        expect(loaded.archive).toHaveLength(1);
        expect(loaded.archive[0].legacy).toBe(true);

        // 다음 로드부터 v1 경로를 타도록 저장됨
        expect(mem.getItem(STATE_KEY)).not.toBeNull();
        expect(mem.getItem(ARCHIVE_KEY)).not.toBeNull();

        // 재로드 시 동일 결과 (마이그레이션 재실행 아님)
        const reloaded = loadPersisted();
        expect(reloaded.state.roster).toEqual(['Gary', 'HD', 'Inu']);
        expect(reloaded.archive).toHaveLength(1);
    });
});

// ── 4. resetAllData: 두 세대 키 전부 삭제 ───────────────────────────
describe('resetAllData', () => {
    it('v1 키와 레거시 v33 키를 모두 지운다', () => {
        buildLegacyFixture();
        savePersistedState({ session: null, roster: [], settings: {} });
        saveArchive([{ id: 's1' }]);

        expect(resetAllData()).toBe(true);

        expect(mem.getItem(STATE_KEY)).toBeNull();
        expect(mem.getItem(ARCHIVE_KEY)).toBeNull();
        for (const key of Object.values(LEGACY_KEYS)) {
            expect(mem.getItem(key)).toBeNull();
        }
        expect(mem._map.size).toBe(0);
    });
});

// ── 5. 빈 스토리지 ──────────────────────────────────────────────────
describe('empty storage', () => {
    it('loadPersisted는 { state:null, archive:[] } 반환', () => {
        expect(loadPersisted()).toEqual({ state: null, archive: [] });
    });

    it('어댑터도 localStorage도 없으면 안전하게 기본값', () => {
        setStorageAdapter(null); // node 환경: globalThis.localStorage 없음
        expect(loadPersisted()).toEqual({ state: null, archive: [] });
        expect(savePersistedState({})).toBe(false);
        expect(saveArchive([])).toBe(false);
        expect(resetAllData()).toBe(false);
    });
});
