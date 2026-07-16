// AI 분석 결과 캐시 (연구 기준서 §16.2 idempotent input hash cache)
// 같은 canonical 입력(inputHash) + 같은 adapter/prompt 버전이면 프로바이더를 재호출하지
// 않는다. storage.js의 주입형 어댑터 패턴을 그대로 따르되, storage.js는 어댑터를 밖으로
// 노출하지 않으므로 이 모듈이 자체 주입 지점을 가진다 (storage.js는 수정하지 않는다).
// 계약: 이 모듈의 어떤 함수도 절대 throw하지 않는다 — 캐시 실패가 분석 흐름을 막으면 안 된다.

export const ANALYSIS_CACHE_KEY = 'hh:v1:analysis';
export const ANALYSIS_CACHE_MAX_ENTRIES = 200;
// 직렬화 크기 상한 — localStorage는 UTF-16이므로 문자열 길이 × 2로 근사 (storage.js와 동일)
export const ANALYSIS_CACHE_MAX_BYTES = 1024 * 1024;

// 저장 항목 필드 화이트리스트 — 이 밖의 필드는 저장하지 않는다.
const ENTRY_FIELDS = [
    'inputHash', 'adapterId', 'adapterVersion', 'promptVersion',
    'decisionId', 'handId', 'result', 'review', 'createdAt',
];

let cacheStorageAdapter = null;

/**
 * localStorage 대체 어댑터 주입 (node 테스트용). null이면 기본으로 복귀.
 * @param {{getItem:Function,setItem:Function,removeItem:Function}|null} obj
 */
export function setAnalysisCacheStorageAdapter(obj) {
    cacheStorageAdapter = obj || null;
}

function getStorage() {
    if (cacheStorageAdapter) return cacheStorageAdapter;
    try {
        if (typeof globalThis !== 'undefined' && globalThis.localStorage) {
            return globalThis.localStorage;
        }
    } catch {
        // 일부 환경(SecurityError 등)에서 localStorage 접근 자체가 throw할 수 있음
    }
    return null;
}

function utf16ByteSize(serialized) {
    return typeof serialized === 'string' ? serialized.length * 2 : 0;
}

function isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isCacheEntry(entry) {
    return isObject(entry)
        && typeof entry.inputHash === 'string' && entry.inputHash !== ''
        && typeof entry.adapterId === 'string' && entry.adapterId !== ''
        && typeof entry.promptVersion === 'string' && entry.promptVersion !== ''
        && isObject(entry.result);
}

function sanitizeEntry(entry) {
    const sanitized = {};
    for (const field of ENTRY_FIELDS) {
        if (entry[field] !== undefined) sanitized[field] = entry[field];
    }
    return sanitized;
}

function serializeEntries(entries) {
    return JSON.stringify({ version: 1, entries });
}

// 저장값 전체를 읽는다. 손상된 JSON은 빈 캐시로 리셋한다 (캐시는 유일 사본이 아니라서 안전).
function readEntries() {
    const storage = getStorage();
    if (!storage) return [];
    let raw = null;
    try {
        raw = storage.getItem(ANALYSIS_CACHE_KEY);
    } catch {
        return [];
    }
    if (raw === null || raw === undefined || raw === '') return [];
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        try {
            storage.removeItem(ANALYSIS_CACHE_KEY);
        } catch {
            // 리셋 실패도 무시 — 다음 put이 덮어쓴다
        }
        return [];
    }
    if (!isObject(parsed) || !Array.isArray(parsed.entries)) return [];
    return parsed.entries.filter(isCacheEntry);
}

// quota 초과 등 저장 실패는 조용히 포기한다 (boolean만 반환).
function writeEntries(entries) {
    const storage = getStorage();
    if (!storage) return false;
    try {
        storage.setItem(ANALYSIS_CACHE_KEY, serializeEntries(entries));
        return true;
    } catch {
        return false;
    }
}

function sameKey(a, inputHash, adapterId, promptVersion) {
    return a.inputHash === inputHash && a.adapterId === adapterId && a.promptVersion === promptVersion;
}

/**
 * 캐시 조회. 히트하면 해당 항목을 최신(LRU 꼬리)으로 갱신한다.
 * @param {string} inputHash 'sha256:<hex>'
 * @param {string} adapterId
 * @param {string} promptVersion
 * @returns {object|null} 저장된 entry 또는 null (절대 throw하지 않음)
 */
export function getCachedAnalysis(inputHash, adapterId, promptVersion) {
    try {
        const entries = readEntries();
        const index = entries.findIndex(entry => sameKey(entry, inputHash, adapterId, promptVersion));
        if (index === -1) return null;
        const [entry] = entries.splice(index, 1);
        entries.push(entry); // LRU: 히트 항목을 최신으로
        writeEntries(entries); // 갱신 실패해도 조회 결과에는 영향 없음
        return entry;
    } catch {
        return null;
    }
}

/**
 * 캐시 저장. 같은 (inputHash, adapterId, promptVersion) 항목은 교체하고,
 * 항목 수 200개·직렬화 1MB를 넘으면 가장 오래된 항목부터 축출한다.
 * @param {{inputHash:string, adapterId:string, adapterVersion?:string, promptVersion:string,
 *   decisionId?:string, handId?:string, result:object, review?:object, createdAt?:string}} entry
 * @returns {boolean} 실제로 저장됐는지 (quota/오버사이즈 실패는 false — 절대 throw하지 않음)
 */
export function putCachedAnalysis(entry) {
    try {
        if (!isCacheEntry(entry)) return false;
        const sanitized = sanitizeEntry(entry);
        // 새 항목 하나만으로 상한을 넘으면 기존 캐시를 건드리지 않고 저장을 포기한다.
        if (utf16ByteSize(serializeEntries([sanitized])) > ANALYSIS_CACHE_MAX_BYTES) return false;

        const entries = readEntries()
            .filter(existing => !sameKey(existing, sanitized.inputHash, sanitized.adapterId, sanitized.promptVersion));
        entries.push(sanitized);
        while (entries.length > ANALYSIS_CACHE_MAX_ENTRIES) entries.shift();
        let serialized = serializeEntries(entries);
        while (utf16ByteSize(serialized) > ANALYSIS_CACHE_MAX_BYTES && entries.length > 1) {
            entries.shift(); // 가장 오래된 항목부터 축출 (새 항목은 위에서 단독 크기를 보장)
            serialized = serializeEntries(entries);
        }

        const storage = getStorage();
        if (!storage) return false;
        try {
            storage.setItem(ANALYSIS_CACHE_KEY, serialized);
            return true;
        } catch {
            return false; // quota 초과 등 — 캐시는 조용히 건너뛴다
        }
    } catch {
        return false;
    }
}

/**
 * 캐시 전체 삭제.
 * @returns {boolean} 성공 여부 (절대 throw하지 않음)
 */
export function clearAnalysisCache() {
    const storage = getStorage();
    if (!storage) return false;
    try {
        storage.removeItem(ANALYSIS_CACHE_KEY);
        return true;
    } catch {
        return false;
    }
}
