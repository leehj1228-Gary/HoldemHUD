import { describe, expect, it } from 'vitest';
import { canonicalStringify, computeInputHash } from '../../src/analysis/hash.js';

describe('canonicalStringify', () => {
    it('객체 키 순서와 무관하게 같은 정본 문자열을 만든다 (중첩 포함)', () => {
        const a = { b: 2, a: 1, nested: { y: [1, 2], x: 'ㄱ' } };
        const b = { nested: { x: 'ㄱ', y: [1, 2] }, a: 1, b: 2 };
        expect(canonicalStringify(a)).toBe(canonicalStringify(b));
    });

    it('배열 순서는 의미가 있으므로 보존한다', () => {
        expect(canonicalStringify([1, 2])).not.toBe(canonicalStringify([2, 1]));
    });

    it('null과 undefined를 구분한다 (unknown ≠ 부재)', () => {
        expect(canonicalStringify({ a: null })).not.toBe(canonicalStringify({ a: undefined }));
        expect(canonicalStringify({ a: null })).not.toBe(canonicalStringify({}));
        expect(canonicalStringify([null])).not.toBe(canonicalStringify([undefined]));
    });

    it('문자열 "null"과 null 값이 충돌하지 않는다', () => {
        expect(canonicalStringify('null')).not.toBe(canonicalStringify(null));
        expect(canonicalStringify('undefined')).not.toBe(canonicalStringify(undefined));
    });

    it('직렬화 불가능한 타입은 거부한다', () => {
        expect(() => canonicalStringify({ f: () => {} })).toThrow(/unsupported/);
    });
});

describe('computeInputHash', () => {
    it('같은 입력(키 순서만 다름) → 동일한 sha256:<64 hex>', async () => {
        const first = await computeInputHash({ pot: 12.5, seat: 3, cards: ['Ah', 'Qh'] });
        const second = await computeInputHash({ cards: ['Ah', 'Qh'], seat: 3, pot: 12.5 });
        expect(first).toBe(second);
        expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);
    });

    it('필드 하나만 바뀌어도 해시가 달라진다', async () => {
        const base = await computeInputHash({ pot: 12.5, seat: 3 });
        expect(await computeInputHash({ pot: 12.6, seat: 3 })).not.toBe(base);
        expect(await computeInputHash({ pot: 12.5, seat: 3, extra: null })).not.toBe(base);
        expect(await computeInputHash({ pot: null, seat: 3 })).not.toBe(base);
    });
});
