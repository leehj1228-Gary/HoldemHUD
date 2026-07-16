// analysisCache 테스트 — 왕복 / LRU 200개 / 1MB 직렬화 상한 / 손상 JSON 리셋 / quota 무시
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    ANALYSIS_CACHE_KEY,
    ANALYSIS_CACHE_MAX_ENTRIES,
    setAnalysisCacheStorageAdapter,
    getCachedAnalysis,
    putCachedAnalysis,
    clearAnalysisCache,
} from '../../src/storage/analysisCache.js';

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

function entryFor(index, overrides = {}) {
    return {
        inputHash: `sha256:${String(index).padStart(64, '0')}`,
        adapterId: 'heuristic-llm',
        adapterVersion: '1.0.0',
        promptVersion: 'detailed-review-payload.v1',
        decisionId: `hand_${index}:seq:1`,
        handId: `hand_${index}`,
        result: { schemaVersion: 'poker-analysis-result.v1', index },
        createdAt: '2026-07-16T00:00:00.000Z',
        ...overrides,
    };
}

function storedCount(mem) {
    const raw = mem._map.get(ANALYSIS_CACHE_KEY);
    return raw ? JSON.parse(raw).entries.length : 0;
}

let mem;

beforeEach(() => {
    mem = memoryStorage();
    setAnalysisCacheStorageAdapter(mem);
});

afterEach(() => {
    setAnalysisCacheStorageAdapter(null);
});

describe('analysisCache', () => {
    it('put/get 왕복: (inputHash, adapterId, promptVersion) 3중 키가 전부 일치해야 히트', () => {
        const entry = entryFor(1);
        expect(putCachedAnalysis(entry)).toBe(true);

        const hit = getCachedAnalysis(entry.inputHash, entry.adapterId, entry.promptVersion);
        expect(hit).toMatchObject({
            inputHash: entry.inputHash,
            decisionId: 'hand_1:seq:1',
            result: { index: 1 },
        });

        expect(getCachedAnalysis('sha256:없는해시', entry.adapterId, entry.promptVersion)).toBeNull();
        expect(getCachedAnalysis(entry.inputHash, 'other-adapter', entry.promptVersion)).toBeNull();
        expect(getCachedAnalysis(entry.inputHash, entry.adapterId, 'other-prompt.v9')).toBeNull();
    });

    it('같은 3중 키는 교체된다 (중복 저장 없음)', () => {
        putCachedAnalysis(entryFor(1));
        putCachedAnalysis(entryFor(1, { result: { schemaVersion: 'poker-analysis-result.v1', updated: true } }));
        expect(storedCount(mem)).toBe(1);
        const hit = getCachedAnalysis(entryFor(1).inputHash, 'heuristic-llm', 'detailed-review-payload.v1');
        expect(hit.result.updated).toBe(true);
    });

    it('LRU: 200개 상한 초과 시 가장 오래 안 쓴 항목부터 축출, get은 최신으로 갱신', () => {
        for (let i = 0; i < ANALYSIS_CACHE_MAX_ENTRIES; i++) {
            putCachedAnalysis(entryFor(i));
        }
        expect(storedCount(mem)).toBe(ANALYSIS_CACHE_MAX_ENTRIES);

        // 0번을 조회해 최신으로 올린다 → 다음 축출 대상은 1번
        expect(getCachedAnalysis(entryFor(0).inputHash, 'heuristic-llm', 'detailed-review-payload.v1')).not.toBeNull();
        putCachedAnalysis(entryFor(ANALYSIS_CACHE_MAX_ENTRIES));

        expect(storedCount(mem)).toBe(ANALYSIS_CACHE_MAX_ENTRIES);
        expect(getCachedAnalysis(entryFor(0).inputHash, 'heuristic-llm', 'detailed-review-payload.v1')).not.toBeNull();
        expect(getCachedAnalysis(entryFor(1).inputHash, 'heuristic-llm', 'detailed-review-payload.v1')).toBeNull();
    });

    it('직렬화 1MB 상한: 초과하면 가장 오래된 항목부터 축출한다', () => {
        // 항목당 약 0.6MB (UTF-16 근사 length×2) — 두 개째부터 상한 초과
        const bigBlob = 'x'.repeat(300 * 1024);
        putCachedAnalysis(entryFor(1, { result: { blob: bigBlob } }));
        putCachedAnalysis(entryFor(2, { result: { blob: bigBlob } }));

        expect(getCachedAnalysis(entryFor(1).inputHash, 'heuristic-llm', 'detailed-review-payload.v1')).toBeNull();
        expect(getCachedAnalysis(entryFor(2).inputHash, 'heuristic-llm', 'detailed-review-payload.v1')).not.toBeNull();
        expect(storedCount(mem)).toBe(1);
    });

    it('단독으로 1MB를 넘는 항목은 기존 캐시를 건드리지 않고 저장을 포기한다', () => {
        putCachedAnalysis(entryFor(1));
        const oversized = entryFor(2, { result: { blob: 'x'.repeat(600 * 1024) } });
        expect(putCachedAnalysis(oversized)).toBe(false);
        expect(getCachedAnalysis(entryFor(1).inputHash, 'heuristic-llm', 'detailed-review-payload.v1')).not.toBeNull();
        expect(getCachedAnalysis(oversized.inputHash, 'heuristic-llm', 'detailed-review-payload.v1')).toBeNull();
    });

    it('손상된 JSON은 빈 캐시로 리셋한다 (throw 없음, 이후 put 정상)', () => {
        mem.setItem(ANALYSIS_CACHE_KEY, '{손상된 json!!');
        expect(getCachedAnalysis('sha256:x', 'a', 'p')).toBeNull();
        expect(mem._map.has(ANALYSIS_CACHE_KEY)).toBe(false); // 리셋됨

        expect(putCachedAnalysis(entryFor(3))).toBe(true);
        expect(getCachedAnalysis(entryFor(3).inputHash, 'heuristic-llm', 'detailed-review-payload.v1')).not.toBeNull();
    });

    it('quota 초과(setItem throw)는 조용히 저장을 건너뛴다 (절대 throw하지 않음)', () => {
        const throwing = {
            getItem: () => null,
            setItem: () => { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; },
            removeItem: () => { throw new Error('removeItem 실패'); },
        };
        setAnalysisCacheStorageAdapter(throwing);
        expect(() => {
            expect(putCachedAnalysis(entryFor(1))).toBe(false);
            expect(getCachedAnalysis(entryFor(1).inputHash, 'heuristic-llm', 'detailed-review-payload.v1')).toBeNull();
            expect(clearAnalysisCache()).toBe(false);
        }).not.toThrow();
    });

    it('필수 필드가 빠진 항목은 저장하지 않는다', () => {
        expect(putCachedAnalysis(null)).toBe(false);
        expect(putCachedAnalysis({})).toBe(false);
        expect(putCachedAnalysis(entryFor(1, { result: null }))).toBe(false);
        expect(putCachedAnalysis(entryFor(1, { inputHash: '' }))).toBe(false);
        expect(storedCount(mem)).toBe(0);
    });

    it('clearAnalysisCache는 캐시 키만 지운다', () => {
        putCachedAnalysis(entryFor(1));
        mem.setItem('hh:v1:state', '{"keep":true}');
        expect(clearAnalysisCache()).toBe(true);
        expect(mem._map.has(ANALYSIS_CACHE_KEY)).toBe(false);
        expect(mem._map.get('hh:v1:state')).toBe('{"keep":true}');
    });
});
