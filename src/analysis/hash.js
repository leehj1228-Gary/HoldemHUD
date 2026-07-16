// 분석 입력 정본 직렬화 + 입력 해시 (연구 기준서 §15.1 불변조건 8: 같은 canonical input → 같은 inputHash)
// 순수 모듈: React·DOM·storage import 금지. 브라우저와 Node(>=18)의 WebCrypto를 공유한다.

/**
 * 결정론적 정본 직렬화.
 * - 객체 키는 항상 정렬해 직렬화한다 (삽입 순서 무관 — 같은 내용이면 같은 문자열).
 * - 배열 순서는 의미가 있으므로 그대로 보존한다.
 * - null과 undefined는 서로 다른 토큰으로 유지한다 (불변조건 9: unknown ≠ 0 ≠ 부재).
 * 출력은 해시 입력용 정본 문자열이며, undefined 토큰 때문에 항상 유효한 JSON은 아니다.
 * @param {*} value
 * @returns {string}
 */
export function canonicalStringify(value) {
    if (value === undefined) return 'undefined';
    if (value === null) return 'null';
    const type = typeof value;
    if (type === 'number') {
        // NaN/Infinity는 JSON.stringify가 null로 뭉개므로 (null과 충돌) 문자 토큰으로 구분한다.
        return Number.isFinite(value) ? JSON.stringify(value) : String(value);
    }
    if (type === 'boolean' || type === 'string') return JSON.stringify(value);
    if (Array.isArray(value)) {
        return `[${value.map(canonicalStringify).join(',')}]`;
    }
    if (type === 'object') {
        const keys = Object.keys(value).sort();
        return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(',')}}`;
    }
    throw new TypeError(`canonicalStringify: unsupported value type ${type}`);
}

/**
 * canonical 직렬화의 SHA-256 해시 → 'sha256:<hex>'.
 * WebCrypto(globalThis.crypto.subtle)를 사용해 브라우저·Electron renderer·Node 18+에서 동일하게 동작한다.
 * @param {*} value
 * @returns {Promise<string>}
 */
export async function computeInputHash(value) {
    const bytes = new TextEncoder().encode(canonicalStringify(value));
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    const hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
    return `sha256:${hex}`;
}
