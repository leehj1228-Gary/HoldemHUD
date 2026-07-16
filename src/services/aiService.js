// AI 코치 서비스 (docs/REBUILD_DESIGN.md §7 — S5)
// 멀티 프로바이더: Gemini / OpenAI(ChatGPT) / Anthropic(Claude).
// 키/모델은 인자로 주입한다 (settings — 모듈이 storage 직접 접근 금지).
// 브라우저 클라이언트 앱이므로 세 프로바이더 모두 raw fetch로 직접 호출한다 (CORS 지원 확인됨).
// 프롬프트의 핸드 데이터는 새 스키마 기준: seat은 전부 0-based, 액션은 name/position/raiseLevel 포함.

import {
    buildDetailedReviewPayload,
    buildDecisionPrompt,
    validateDecisionReview,
} from './detailedReview.js';

const TIMEOUT_MS = 60000;

// 프로바이더 메타데이터 — 설정 UI와 옵션 해석이 공유하는 단일 정의
export const AI_PROVIDERS = {
    gemini: {
        label: 'Gemini',
        defaultModel: 'gemini-3-pro-preview',
        keyPlaceholder: 'AIza...',
        keyField: 'geminiApiKey',
        modelField: 'geminiModel',
    },
    openai: {
        label: 'ChatGPT (OpenAI)',
        defaultModel: 'gpt-5.6-sol', // GPT-5.6 플래그십 티어 (Sol)
        keyPlaceholder: 'sk-...',
        keyField: 'openaiApiKey',
        modelField: 'openaiModel',
    },
    anthropic: {
        label: 'Claude (Anthropic)',
        defaultModel: 'claude-opus-4-8',
        keyPlaceholder: 'sk-ant-...',
        keyField: 'anthropicApiKey',
        modelField: 'anthropicModel',
    },
};

/**
 * settings에서 현재 선택된 프로바이더의 호출 옵션을 만든다.
 * @param {object} settings - useGame().settings
 * @returns {{provider: string, label: string, apiKey: string, model: string}}
 */
export function resolveAiOptions(settings = {}) {
    const provider = AI_PROVIDERS[settings.aiProvider] ? settings.aiProvider : 'gemini';
    const meta = AI_PROVIDERS[provider];
    // 레거시 호환: 구 설정(aiModel)은 gemini 모델명으로 취급
    const legacyModel = provider === 'gemini' ? settings.aiModel : undefined;
    return {
        provider,
        label: meta.label,
        apiKey: settings[meta.keyField] || '',
        model: settings[meta.modelField] || legacyModel || meta.defaultModel,
    };
}

function requireKey(apiKey, meta) {
    const key = typeof apiKey === 'string' ? apiKey.trim() : '';
    if (!key) throw new Error(`설정에서 ${meta.label} API 키를 입력하세요`);
    return key;
}

function pickModel(model, meta) {
    return (typeof model === 'string' && model.trim()) ? model.trim() : meta.defaultModel;
}

async function readErrorBody(response) {
    try {
        const text = await response.text();
        try {
            const data = JSON.parse(text);
            // Gemini/OpenAI: {error:{message}}, Anthropic: {error:{message}}
            return data?.error?.message || text;
        } catch { return text; }
    } catch { return ''; }
}

// ── 프로바이더별 요청/응답 (요청 body 생성 + 응답에서 텍스트 추출) ─────────────

const PROVIDER_CALLS = {
    gemini: {
        request(prompt, key, model) {
            return {
                url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`,
                headers: { 'Content-Type': 'application/json' },
                body: {
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: { responseMimeType: 'application/json' },
                },
            };
        },
        extractText(data) {
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!text) {
                const details = [];
                const finishReason = data.candidates?.[0]?.finishReason;
                if (finishReason) details.push(`finishReason: ${finishReason}`);
                if (data.promptFeedback) details.push(`promptFeedback: ${JSON.stringify(data.promptFeedback)}`);
                throw new Error(`AI 응답에 텍스트가 없습니다${details.length ? ` (${details.join(', ')})` : ''}`);
            }
            return text;
        },
    },
    openai: {
        request(prompt, key, model) {
            return {
                url: 'https://api.openai.com/v1/chat/completions',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${key}`,
                },
                // 프롬프트가 JSON 출력을 명시하므로 json_object 모드 사용 가능
                body: {
                    model,
                    messages: [{ role: 'user', content: prompt }],
                    response_format: { type: 'json_object' },
                },
            };
        },
        extractText(data) {
            const choice = data.choices?.[0];
            if (choice?.message?.refusal) {
                throw new Error(`AI가 요청을 거절했습니다: ${choice.message.refusal}`);
            }
            const text = choice?.message?.content;
            if (!text) {
                const finish = choice?.finish_reason;
                throw new Error(`AI 응답에 텍스트가 없습니다${finish ? ` (finish_reason: ${finish})` : ''}`);
            }
            return text;
        },
    },
    anthropic: {
        request(prompt, key, model) {
            return {
                url: 'https://api.anthropic.com/v1/messages',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': key,
                    'anthropic-version': '2023-06-01',
                    // 브라우저에서 직접 호출하기 위한 CORS 옵트인 (키는 사용자 기기에만 저장됨)
                    'anthropic-dangerous-direct-browser-access': 'true',
                },
                body: {
                    model,
                    max_tokens: 16000,
                    thinking: { type: 'adaptive' },
                    messages: [{ role: 'user', content: prompt }],
                },
            };
        },
        extractText(data) {
            if (data.stop_reason === 'refusal') {
                const why = data.stop_details?.explanation || data.stop_details?.category || '';
                throw new Error(`AI가 요청을 거절했습니다${why ? ` (${why})` : ''}`);
            }
            const block = Array.isArray(data.content) ? data.content.find(b => b?.type === 'text') : null;
            if (!block?.text) {
                throw new Error(`AI 응답에 텍스트가 없습니다${data.stop_reason ? ` (stop_reason: ${data.stop_reason})` : ''}`);
            }
            return block.text;
        },
    },
};

// 공통 호출: 프로바이더 디스패치 + JSON 파싱 + 응답 구조 가드 + 60초 타임아웃
async function callAI(prompt, { provider = 'gemini', apiKey, model } = {}) {
    const meta = AI_PROVIDERS[provider] || AI_PROVIDERS.gemini;
    const impl = PROVIDER_CALLS[provider] || PROVIDER_CALLS.gemini;
    const key = requireKey(apiKey, meta);
    const m = pickModel(model, meta);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const { url, headers, body } = impl.request(prompt, key, m);
        const response = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: controller.signal,
        });

        if (!response.ok) {
            const detail = await readErrorBody(response);
            throw new Error(`API Error: ${response.status} ${response.statusText}${detail ? ` - ${detail}` : ''}`);
        }

        const data = await response.json();
        const text = impl.extractText(data);

        // JSON 모드를 지정해도 방어적으로 마크다운 펜스 제거.
        // 선두/말미 펜스만 벗긴다 — 전역 치환은 JSON 문자열 값 안의 백틱까지 파괴하므로 금지.
        let jsonString = text.trim();
        if (jsonString.startsWith('```')) {
            jsonString = jsonString.replace(/^```(?:json)?\s*/i, '');
        }
        if (jsonString.endsWith('```')) {
            jsonString = jsonString.replace(/\s*```$/, '');
        }
        return JSON.parse(jsonString.trim());
    } catch (error) {
        if (error && error.name === 'AbortError') {
            throw new Error('AI 요청이 60초를 초과했습니다. 잠시 후 다시 시도하세요.');
        }
        console.error(`${meta.label} API Call Failed:`, error);
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

const DETAILED_ANALYSIS_MODE = 'heuristic_no_solver';
const DETAILED_MAX_DECISIONS = 30;
const DETAILED_MAX_CONCURRENCY = 2;
const DETAILED_ACTION_TYPES = new Set(['fold', 'check', 'call', 'bet', 'raise']);

function detailedError(error, type) {
    const message = error instanceof Error ? error.message : String(error || '알 수 없는 오류');
    return {
        type,
        message: message.slice(0, 1000),
    };
}

async function mapDetailedWithLimit(entries, mapper) {
    const results = new Array(entries.length);
    let cursor = 0;

    async function worker() {
        while (cursor < entries.length) {
            const index = cursor;
            cursor += 1;
            results[index] = await mapper(entries[index], index);
        }
    }

    const workerCount = Math.min(DETAILED_MAX_CONCURRENCY, entries.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results;
}

function detailedDecisionStub(hand, action) {
    return {
        decisionId: `${hand.id}:a${action.seq}`,
        decisionSeq: action.seq,
        street: typeof action.street === 'string' ? action.street.toLowerCase() : 'preflop',
    };
}

/**
 * Analyze every recorded Hero decision in one detailed hand.
 * Each decision gets an independent provider call containing only its knowledge-cutoff
 * snapshot. Provider/response failures are isolated per item; configuration errors such
 * as a missing API key still throw, matching the existing AI coach entry points.
 *
 * @param {object} hand detailed HandRecord
 * @param {{provider?: string, apiKey: string, model?: string}} options
 * @returns {Promise<{analysisMode:string, handId:string, generatedAt:string,
 *   items:Array<{decision:object, review:object|null, error:object|null}>}>}
 */
export async function analyzeDetailedHand(hand, options) {
    const aiOptions = options && typeof options === 'object' ? options : {};
    const providerMeta = AI_PROVIDERS[aiOptions.provider] || AI_PROVIDERS.gemini;
    // Existing analyzeTable/analyzeSessionLeaks surface missing credentials as a blocking
    // setup error. Avoid returning the same missing-key error once per decision.
    requireKey(aiOptions.apiKey, providerMeta);

    if (!hand || typeof hand !== 'object' || !hand.detailed?.enabled) {
        throw new Error('상세 기록이 활성화된 핸드가 필요합니다');
    }
    if (typeof hand.id !== 'string' || !hand.id.trim()) {
        throw new Error('상세 핸드 ID가 필요합니다');
    }
    if (!Array.isArray(hand.actions) || !Number.isInteger(hand.detailed.heroSeat)) {
        throw new Error('상세 핸드의 히어로 또는 액션 기록이 올바르지 않습니다');
    }

    const heroSeat = hand.detailed.heroSeat;
    const heroActions = hand.actions
        .filter(action => action && action.seat === heroSeat
            && Number.isInteger(action.seq) && DETAILED_ACTION_TYPES.has(action.type))
        .slice()
        .sort((a, b) => a.seq - b.seq);
    if (heroActions.length === 0) throw new Error('분석할 히어로 액션이 없습니다');
    if (heroActions.length > DETAILED_MAX_DECISIONS) {
        throw new Error(`한 핸드에서 분석할 수 있는 히어로 결정은 최대 ${DETAILED_MAX_DECISIONS}개입니다`);
    }
    if (new Set(heroActions.map(action => action.seq)).size !== heroActions.length) {
        throw new Error('히어로 액션 seq가 중복되었습니다');
    }

    const prepared = heroActions.map(action => {
        const fallbackDecision = detailedDecisionStub(hand, action);
        try {
            const payload = buildDetailedReviewPayload(hand, [{ decisionSeq: action.seq }]);
            return {
                shared: payload.shared,
                decision: payload.decisions[0],
                error: null,
            };
        } catch (error) {
            return {
                shared: null,
                decision: fallbackDecision,
                error: detailedError(error, 'payload'),
            };
        }
    });

    const items = await mapDetailedWithLimit(prepared, async entry => {
        if (entry.error) return { decision: entry.decision, review: null, error: entry.error };

        let prompt;
        try {
            prompt = buildDecisionPrompt(entry.shared, entry.decision);
        } catch (error) {
            return {
                decision: entry.decision,
                review: null,
                error: detailedError(error, 'payload'),
            };
        }
        let raw;
        try {
            raw = await callAI(prompt, aiOptions);
        } catch (error) {
            return {
                decision: entry.decision,
                review: null,
                error: detailedError(error, 'provider'),
            };
        }

        try {
            return {
                decision: entry.decision,
                review: validateDecisionReview(raw, entry.decision),
                error: null,
            };
        } catch (error) {
            return {
                decision: entry.decision,
                review: null,
                error: detailedError(error, 'validation'),
            };
        }
    });

    return {
        analysisMode: DETAILED_ANALYSIS_MODE,
        handId: hand.id.trim(),
        generatedAt: new Date().toISOString(),
        items,
    };
}

/**
 * 테이블 상태를 분석해 프리플랍 전략(추천 레인지 169콤보/요약/플레이어 팁)을 받는다.
 * @param {object} tableData - { blinds:{sb,bb}|null, currency, straddleCount,
 *   players:[{seat(0-based), position, name, stackBB, isHero, stats:{vpip,pfr}|null, style, action}],
 *   heroPosition }
 * @param {{provider?: string, apiKey: string, model?: string}} options - 설정에서 주입되는 프로바이더/키/모델
 * @returns {Promise<object>} { recommendedRange, rangeSummary|null, strategySummary, playerTips }
 */
export async function analyzeTable(tableData, options) {
    const prompt = `
    You are the world's best poker coach and an expert in GTO and Exploitative strategies.
    Based on the provided JSON data representing a poker table state, return a JSON object with the following analysis results.

    ** Input Data Notes:**
    - 'seat' is a 0-based fixed seat number.
    - 'blinds' is an object { sb, bb } (small blind / big blind amounts) and 'currency' is the currency symbol. It may be null for a hypothetical table.
    - 'straddleCount' is the number of live straddles posted (0 = none). A straddle is NOT a raise; an open raise over a straddle is still the first raise.
    - 'stackBB' indicates the player's stack size in Big Blinds (BB). Do not treat it as a monetary amount.
    - 'stats' (when present) are live-tracked percentages: { vpip, pfr } (integer %, may be null when the sample is empty).
    - 'action' (when present) is the player's preflop action so far: "fold", "call" or "raise".

    ** Input Data:**
    ${JSON.stringify(tableData, null, 2)}

    ** Required Output Format(JSON Only):**
    {
        "recommendedRange": {
            "AA": "Raise",
            "AKs": "Raise",
            "72o": "Fold",
            ... (Map all 169 hand combinations to "Raise", "Call", or "Fold")
        },
        "rangeSummary": "(Optional) One short sentence summarizing the recommended range strategy",
        "strategySummary": [
            { "icon": "🎯", "text": "Short bullet point 1 (e.g., Target the Whale)" },
            { "icon": "⚠️", "text": "Short bullet point 2 (e.g., Avoid Maniac)" },
            { "icon": "💰", "text": "Short bullet point 3 (e.g., Value bet sizing)" }
        ],
        "playerTips": [
            {
                "seat": 2,
                "name": "Maniac",
                "tag": "Danger",
                "tagColor": "red",
                "tip": "Detailed tip on how to play against this specific player."
            },
            ... (One object per relevant opponent)
        ]
    }

    ** Instructions:**
    1. ** Recommended Range:** Calculate the optimal preflop range for the 'Hero' based on their position, effective stack size, ** preflop actions of other players (e.g., facing a raise, limpers) **, and the tendencies of opponents behind. Include exploitative adjustments. You MUST cover all 169 combinations (pairs like "AA", suited like "AKs", offsuit like "AKo"). Optionally include a top-level "rangeSummary" string: one short sentence (Korean) summarizing the recommended range.
    2. ** Strategy Summary:** Provide exactly 3 high-level, actionable bullet points. Use emojis.
    3. ** Player Tips:** Provide specific advice for key opponents. Use "red" tag for threats, "blue" for targets / fish. Echo each opponent's 0-based 'seat' value from the input.
    4. ** Response:** Return ONLY the valid JSON string. Do not include markdown formatting like \`\`\`json.
    `;

    const raw = await callAI(prompt, options);
    // 응답 형태 검증/보정 — UI(StrategyResults/RangeChart)가 malformed 응답으로 크래시하지 않도록
    const result = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
    const recommendedRange = (result.recommendedRange && typeof result.recommendedRange === 'object'
        && !Array.isArray(result.recommendedRange)) ? result.recommendedRange : {};
    const rangeSummary = (typeof result.rangeSummary === 'string' && result.rangeSummary.trim())
        ? result.rangeSummary.trim() : null;
    // 기존 UI 경로(recommendedRange.description)로도 노출 — RangeChart가 있으면 렌더, 없으면 생략
    if (rangeSummary && typeof recommendedRange.description !== 'string') {
        recommendedRange.description = rangeSummary;
    }
    return {
        ...result,
        recommendedRange,
        rangeSummary,
        strategySummary: Array.isArray(result.strategySummary) ? result.strategySummary : [],
        playerTips: Array.isArray(result.playerTips) ? result.playerTips : [],
    };
}

/**
 * 세션 리크 분석 대상 핸드를 고른다 (컴포넌트와 프롬프트가 같은 목록을 공유하기 위한 헬퍼).
 * 1) 히어로가 액션한 핸드 → 없으면 2) 히어로가 착석(sittingOut 아님)한 핸드로 폴백.
 * 마지막 limit개만 남기고, evidenceHands 링크가 유일하도록 handNo를 1..N으로 재부여한다.
 * @param {Array<object>} hands - HandRecord 배열 (여러 세션 합산 가능)
 * @param {string} heroName - 히어로 이름 (trim 후 비교)
 * @param {number} [limit] - 최대 핸드 수 (기본 50)
 * @returns {Array<object>} handNo가 재부여된 얕은 복사 HandRecord 배열
 */
export function selectHeroHands(hands, heroName, limit = 50) {
    const hero = typeof heroName === 'string' ? heroName.trim() : '';
    const list = Array.isArray(hands)
        ? hands.filter(hand => !hand?.detailed?.enabled || hand.detailed.completed === true)
        : [];
    if (!hero) return [];

    let relevant = list.filter(h =>
        h && Array.isArray(h.actions) &&
        h.actions.some(a => a && typeof a.name === 'string' && a.name.trim() === hero));

    if (relevant.length === 0) {
        relevant = list.filter(h =>
            h && Array.isArray(h.seats) &&
            h.seats.some(s => s && !s.sittingOut && typeof s.name === 'string' && s.name.trim() === hero));
    }

    return relevant.slice(-limit).map((h, i) => ({ ...h, handNo: i + 1 }));
}

// 토큰 절약을 위한 핸드 축약 (새 스키마 필드만 — 0-based seat 일관)
function compactHand(hand) {
    return {
        handNo: hand.handNo,
        dealerSeat: hand.dealerSeat,
        straddleCount: hand.straddleCount || 0,
        seats: (hand.seats || [])
            .filter(s => s && !s.sittingOut)
            .map(s => ({ seat: s.seat, name: s.name, position: s.position ?? null })),
        actions: (hand.actions || [])
            .filter(a => !a.street || String(a.street).toLowerCase() === 'preflop')
            .map(a => ({
                seq: a.seq,
                seat: a.seat,
                name: a.name,
                position: a.position ?? null,
                type: a.type,
                raiseLevel: a.raiseLevel || 0,
            })),
    };
}

/**
 * 세션 핸드에서 히어로의 프리플랍 리크를 분석한다.
 * @param {object} args
 * @param {Array<object>} args.hands - selectHeroHands()로 준비된 분석 대상 핸드 (handNo 1..N)
 * @param {string} args.heroName - 히어로 이름
 * @param {Array<object>} [args.opponentStats] - statsEngine 퍼센트 기반:
 *   [{ name, hands(=dealt 표본), vpip, pfr, threeBet, ft3b, fts }] — 각 % 는 정수 또는 null
 * @param {{provider?: string, apiKey: string, model?: string}} options - 설정에서 주입되는 프로바이더/키/모델
 * @returns {Promise<object>} { majorLeaks, goodPlays, overallScore, summary }
 */
export async function analyzeSessionLeaks({ hands, heroName, opponentStats = [] }, options) {
    const hero = typeof heroName === 'string' ? heroName.trim() : '';
    if (!hero) throw new Error('히어로를 선택하세요');
    const analyzedHands = Array.isArray(hands) ? hands : [];
    if (analyzedHands.length === 0) throw new Error('선택한 세션에 해당 히어로의 핸드가 없습니다');

    const compactHands = analyzedHands.map(compactHand);

    const prompt = `
    You are an elite Poker Coach specializing in PRE-FLOP leak finding and GTO/Exploitative adjustments.

    IMPORTANT DATA LIMITATIONS (must follow):
    - You ONLY have preflop action logs (no hole cards, no postflop).
    - Raise sizing is NOT available (only the raise level via "raiseLevel").
    - DO NOT invent specific cards, exact sizes, or postflop lines.
    - Focus ONLY on frequency-based and decision-structure leaks inferable from the preflop sequence.

    Hero name: "${hero}"

    Opponent Statistics (context — all values are percentages computed from tracked hands):
    ${JSON.stringify(opponentStats, null, 2)}
    Rules for stats:
    - "hands" is the sample size (number of hands the player was dealt in).
    - "vpip", "pfr", "threeBet", "ft3b", "fts" are integer percentages, or null when there was no opportunity sample.
    - If hands < 50, treat as LOW confidence and explicitly mention it in analysis.
    - If a stat is null, do NOT use it for exploit advice.

    Session Hands (each object is one hand):
    ${JSON.stringify(compactHands, null, 2)}

    HAND PARSING RULES (critical — the data uses one consistent schema):
    1) "seat" is a 0-based fixed seat number and is consistent everywhere (seats[] and actions[]).
       Every action also carries "name" and "position" — identify players by "name".
    2) All actions are preflop, ordered by "seq" (ascending).
    3) "raiseLevel" on raise actions is authoritative: 1 = open raise (2-bet), 2 = 3-bet, 3 = 4-bet, and so on.
       Use it directly — never infer the raise level from anything else.
    4) "straddleCount" on each hand is the number of live straddles posted (0 = none).
       A straddle is NOT a raise: an open raise over a straddle still has raiseLevel 1.
    5) "position" values (BTN, SB, BB, UTG, ..., CO) are pre-computed and trustworthy.
    6) Determine Hero's FIRST preflop action in each hand (smallest seq for hero).
    7) Determine Hero "spotType" from actions before Hero's first action:
       - FIRST_IN: no prior call/raise (only folds)
       - VS_LIMP: prior call(s) exist but no raise
       - VS_OPEN: exactly one raise (raiseLevel 1) exists before Hero acts
       - SQUEEZE_OPP: a raise exists and at least one call exists between that raise and Hero
       - VS_3BET: Hero raised earlier in the hand and later faces a re-raise (a raise with a higher raiseLevel)

    WHAT TO COACH (preflop only):
    - Too much limping or cold-calling (especially OOP)
    - Too tight/loose opening frequencies by position (FIRST_IN)
    - Too low/high 3bet frequency (VS_OPEN) and missed squeeze spots (SQUEEZE_OPP)
    - Over-folding / under-defending to 3bets (VS_OPEN then faces 3bet)
    - Blind defense tendencies (SB/BB vs steals) if enough opportunities
    - Exploit adjustments using opponent stats:
      - Use blinds' fts for steal strategy (CO/BTN/SB FIRST_IN)
      - Use opener's ft3b for 3bet bluff frequency (VS_OPEN)
      - Use vpip/pfr to adjust value vs bluff emphasis (but no hand-specific combos)

    REQUIRED OUTPUT (JSON only, no markdown, no extra text):
    {
      "majorLeaks": [
        {
          "title": "",
          "severity": "High",
          "description": "",
          "fix": "",
          "evidenceHands": [1, 2],
          "observedPattern": {
            "spotType": "",
            "opportunities": 0,
            "heroActionCounts": {
              "fold": 0,
              "call": 0,
              "raise": 0
            }
          },
          "confidence": "High",
          "opponentAdjustments": [
            {
              "vsPlayer": "",
              "basedOnStat": "",
              "advice": "",
              "statSampleNote": ""
            }
          ]
        }
      ],
      "goodPlays": [
        { "handNo": 2, "text": "(한국어로) 좋은 프리플랍 선택 1개" }
      ],
      "overallScore": 0,
      "summary": ""
    }

    EVIDENCE RULES (critical):
    - "evidenceHands" MUST be an array of integers, each being the "handNo" value of a hand in the provided data.
    - "goodPlays" entries MUST be objects with "handNo" (integer from the data, or null if not tied to one hand) and "text" (Korean).
    - NEVER reference hands inside free text (no "Hand #3" / "handId=3" strings) — use the handNo fields only.

    SCORING RUBRIC (for consistency):
    - Start from 85.
    - Subtract: High leak -15, Medium -8, Low -3.
    - Add: each good play +2 (max +6).
    - Clamp to 0..100.

    Rules:
    - Max 10 major leaks.
    - If opportunities < 8 for a spot, do NOT label it High severity; lower severity and confidence.
    - Provide all text content in KOREAN (한국어).
    - Return ONLY a single valid JSON object.
    `;

    const raw = await callAI(prompt, options);
    // 응답 형태 검증/보정 — SessionLeaks.jsx가 malformed 응답으로 크래시하지 않도록
    const result = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
    const score = Number(result.overallScore);
    return {
        ...result,
        majorLeaks: Array.isArray(result.majorLeaks) ? result.majorLeaks : [],
        goodPlays: Array.isArray(result.goodPlays) ? result.goodPlays : [],
        overallScore: Number.isFinite(score) ? score : 0,
        summary: typeof result.summary === 'string' ? result.summary : '',
    };
}
