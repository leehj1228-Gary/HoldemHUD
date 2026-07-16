import { useState } from 'react';
import { resolveAiOptions } from '../../services/aiService.js';
import { analyzeDecision } from '../../analysis/gateway/analysisGateway.js';
import { ANALYSIS_RESULT_SCHEMA_VERSION } from '../../analysis/contracts/analysisResult.js';
import { ANALYSIS_ERROR_SCHEMA_VERSION } from '../../analysis/contracts/analysisError.js';
import { computeStatsAsOf } from '../../engine/statsEngine.js';
import { DETAILED_ACTION_TYPES } from '../../engine/schema.js';
import { useGame } from '../../state/GameContext.jsx';

const CONFIDENCE_CAP = 0.45;
const MAX_DECISIONS = 30;
const MAX_CONCURRENCY = 2;
const ASSESSMENTS = {
    plausible: {
        label: '휴리스틱상 가능',
        color: '#38bdf8',
        background: '#0c4a6e',
        description: '제공된 정보 안에서 설명 가능한 선택입니다.',
    },
    review_needed: {
        label: '다시 볼 필요',
        color: '#fbbf24',
        background: '#78350f',
        description: '정답 판정이 아니라 추가 복기가 필요한 지점입니다.',
    },
    not_gradable: {
        label: '평가 불가',
        color: '#cbd5e1',
        background: '#334155',
        description: '기록된 정보만으로는 해당 결정을 평가할 수 없습니다.',
    },
};
const STREET_LABELS = {
    preflop: 'Preflop',
    flop: 'Flop',
    turn: 'Turn',
    river: 'River',
};
const ACTION_LABELS = {
    fold: 'Fold',
    check: 'Check',
    call: 'Call',
    bet: 'Bet',
    raise: 'Raise',
    'all-in': 'All-in',
};
// 액션 어휘는 schema.js 단일 선언에서 파생 (재선언 금지)
const DETAILED_ACTION_TYPE_SET = new Set(DETAILED_ACTION_TYPES);

function safeArray(value) {
    return Array.isArray(value) ? value : [];
}

function stringValue(value, fallback = '') {
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function assessmentMeta(value) {
    return ASSESSMENTS[value] || ASSESSMENTS.not_gradable;
}

function normalizedConfidence(confidence) {
    const raw = Number(confidence);
    if (!Number.isFinite(raw) || raw < 0) return 0;
    const ratio = raw > 1 ? raw / 100 : raw;
    return Math.min(ratio, CONFIDENCE_CAP);
}

function heroActionAt(hand, decisionSeq) {
    return safeArray(hand?.actions).find(candidate => candidate?.seq === decisionSeq) || null;
}

function actionLabelFor(hand, decisionSeq) {
    const action = heroActionAt(hand, decisionSeq);
    const raw = action?.isAllIn ? 'all-in' : action?.type;
    return ACTION_LABELS[raw] || stringValue(raw, '액션 미상');
}

function streetLabelFor(card, hand, decisionSeq) {
    const street = stringValue(card?.street) || stringValue(heroActionAt(hand, decisionSeq)?.street, 'preflop');
    return STREET_LABELS[street.toLowerCase()] || stringValue(street, 'Street 미상');
}

// 분석 대상 Hero 결정 seq 목록 (aiService.analyzeDetailedHand와 같은 선별 규칙). (테스트용 export)
// eslint-disable-next-line react-refresh/only-export-components
export function heroDecisionSeqs(hand) {
    const heroSeat = hand?.detailed?.heroSeat;
    if (!Number.isInteger(heroSeat) || !Array.isArray(hand?.actions)) return [];
    const seqs = hand.actions
        .filter(action => action && action.seat === heroSeat
            && Number.isInteger(action.seq) && DETAILED_ACTION_TYPE_SET.has(action.type))
        .map(action => action.seq)
        .sort((a, b) => a - b);
    return [...new Set(seqs)];
}

// 게이트웨이가 반환한 검증 통과 형태({result: poker-analysis-result.v1, review})만 카드로
// 매핑한다. 대체 형태 폴백은 validateAnalysisResult를 우회한 미검증 응답을 그대로 화면에
// 올리는 통로가 되므로 금지 — envelope schemaVersion이 다르면 렌더하지 않는다. (테스트용 export)
// eslint-disable-next-line react-refresh/only-export-components
export function cardModelFromOutcome(outcome) {
    const result = outcome?.result;
    if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
    if (result.schemaVersion !== ANALYSIS_RESULT_SCHEMA_VERSION) return null;
    const explanation = result.explanation && typeof result.explanation === 'object' && !Array.isArray(result.explanation)
        ? result.explanation
        : {};
    const review = outcome.review && typeof outcome.review === 'object' && !Array.isArray(outcome.review)
        ? outcome.review
        : null;
    return {
        decisionId: stringValue(result.decisionId),
        analysisMode: stringValue(result.analysisMode),
        assessment: stringValue(review?.assessment, 'not_gradable'),
        street: stringValue(review?.street),
        confidence: result.confidence && typeof result.confidence === 'object' ? result.confidence.overall : null,
        headline: stringValue(explanation.headline),
        reasoning: safeArray(explanation.reasoning),
        alternatives: safeArray(explanation.alternatives),
        unknowns: safeArray(result.unknowns),
        studyQuestion: stringValue(safeArray(explanation.studyQuestions)[0]),
        cached: !!outcome.cached,
    };
}

// 구조화 오류(poker-analysis-error.v1)는 userMessageKo만 표시한다 (진단 문자열은 화면 밖).
function errorMessageFrom(error) {
    if (error && typeof error === 'object' && error.schemaVersion === ANALYSIS_ERROR_SCHEMA_VERSION) {
        return stringValue(error.userMessageKo, '알 수 없는 분석 오류입니다.');
    }
    if (error instanceof Error) return error.message;
    return stringValue(error?.message, '알 수 없는 오류');
}

// 상대 통계 시간축 (연구 기준서 §12.1): 현재 핸드 "이전" 자료만으로 만든 상대 모델 참조.
// computeStatsAsOf(B의 as-of API)의 truncated 플래그가 시간축 보장이다 — 대상 핸드를 목록에서
// 찾지 못하면(보장 실패) 참조를 생략한다. heuristic 모드는 상대 모델을 프롬프트에 싣지 않으므로
// lifetime window의 통계 Map 자체는 버리고, snapshot의 opponentModelRef 참조 필드만 채운다.
// asOfHandId는 "포함된 마지막" 핸드다 — 현재 핸드 id를 넣으면 snapshot 빌더가 거부한다.
function opponentModelRefFor(hand, allHands) {
    if (!hand || typeof hand.id !== 'string' || !Array.isArray(allHands)) return null;
    const asOf = computeStatsAsOf(allHands, { beforeHandId: hand.id, windows: ['lifetime'] });
    if (!asOf.truncated) return null;
    const index = allHands.findIndex(item => item?.id === hand.id);
    if (index <= 0) return null; // 이전 핸드가 없으면 참조할 상대 모델도 없다
    const lastIncluded = allHands[index - 1];
    if (typeof lastIncluded?.id !== 'string') return null;
    return { asOfHandId: lastIncluded.id, includedHands: index };
}

// 결정별 독립 실행 + 동시 호출 상한 (기존 aiService 경로의 동시성 계약 유지)
async function mapWithLimit(entries, limit, mapper) {
    const results = new Array(entries.length);
    let cursor = 0;

    async function worker() {
        while (cursor < entries.length) {
            const index = cursor;
            cursor += 1;
            results[index] = await mapper(entries[index], index);
        }
    }

    const workerCount = Math.min(limit, entries.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results;
}

function preflightWarnings(hand) {
    if (!hand?.detailed?.enabled) return [];
    const warnings = [];
    const detailed = hand.detailed;
    const heroCards = safeArray(detailed.heroCards);
    if (heroCards.length !== 2) {
        warnings.push('Hero 홀카드가 없어 범위·블로커·쇼다운 관련 판단이 제한됩니다.');
    }

    const stackPrecisions = detailed.startingStackPrecisions || {};
    const activeSeats = safeArray(hand.seats).filter(seat => seat && !seat.sittingOut);
    const unknownStacks = activeSeats.filter(seat =>
        (stackPrecisions[seat.seat] ?? stackPrecisions[String(seat.seat)] ?? 'unknown') === 'unknown').length;
    const estimatedStacks = activeSeats.filter(seat => {
        const precision = stackPrecisions[seat.seat] ?? stackPrecisions[String(seat.seat)];
        return precision === 'estimated';
    }).length;
    if (unknownStacks > 0) warnings.push(`시작 스택을 모르는 좌석이 ${unknownStacks}개입니다.`);
    if (estimatedStacks > 0) warnings.push(`시작 스택 ${estimatedStacks}개가 대략값입니다.`);

    const amountActions = safeArray(hand.actions).filter(action =>
        ['call', 'bet', 'raise', 'all-in'].includes(action?.type));
    const unknownAmounts = amountActions.filter(action =>
        action.precision === 'unknown' || action.amountTo === null || action.amountTo === undefined).length;
    const estimatedAmounts = amountActions.filter(action =>
        action.precision === 'estimated').length;
    if (unknownAmounts > 0) warnings.push(`금액을 모르는 액션이 ${unknownAmounts}개입니다.`);
    if (estimatedAmounts > 0) warnings.push(`베팅 금액 ${estimatedAmounts}개가 대략값입니다.`);
    return warnings;
}

// snapshot dataQuality 기반 데이터 제한 안내 (기존 리뷰 dataQuality 표시와 같은 문구 규칙)
function snapshotQualityWarnings(items) {
    const warnings = [];
    items.forEach(item => {
        const quality = item.outcome?.snapshot?.dataQuality;
        if (!quality) return;
        safeArray(quality.unknownFields).forEach(field => {
            const text = stringValue(field);
            if (text) warnings.push(`미상 데이터: ${text}`);
        });
        if (quality.overall && quality.overall !== 'exact') {
            warnings.push(`데이터 품질: ${quality.overall}`);
        }
    });
    return [...new Set(warnings)];
}

function ReasoningItem({ item }) {
    const text = typeof item === 'string' ? item : stringValue(item?.text, '설명이 제공되지 않았습니다.');
    const factRefs = typeof item === 'object' && item ? safeArray(item.factRefs) : [];
    return (
        <li style={styles.listItem}>
            <span>{text}</span>
            {factRefs.length > 0 && (
                <div style={styles.factRefs}>
                    {factRefs.map((ref, index) => <code key={`${ref}-${index}`} style={styles.factRef}>{ref}</code>)}
                </div>
            )}
        </li>
    );
}

function AlternativeItem({ item }) {
    if (typeof item === 'string') return <li style={styles.listItem}>{item}</li>;
    const action = ACTION_LABELS[item?.action] || stringValue(item?.action, '대안');
    return (
        <li style={styles.alternativeItem}>
            <strong style={styles.alternativeAction}>{action}</strong>
            {stringValue(item?.condition) && <span><b>조건:</b> {item.condition}</span>}
            {stringValue(item?.why) && <span><b>이유:</b> {item.why}</span>}
        </li>
    );
}

function ReviewCard({ card, hand, decisionSeq, index, onReanalyze, reanalyzing }) {
    const meta = assessmentMeta(card.assessment);
    const confidence = normalizedConfidence(card.confidence);
    const confidencePercent = Math.round(confidence * 100);
    const street = streetLabelFor(card, hand, decisionSeq);
    const headline = stringValue(card.headline, '이 결정의 복기 결과입니다.');
    const reflectionQuestion = stringValue(card.studyQuestion);

    return (
        <article style={styles.reviewCard}>
            <div style={styles.reviewHeader}>
                <div style={styles.decisionMeta}>
                    <span style={styles.decisionIndex}>#{index + 1}</span>
                    <span style={styles.streetBadge}>{street}</span>
                    <span style={styles.actionBadge}>{actionLabelFor(hand, decisionSeq)}</span>
                    {card.cached && <span style={styles.cachedBadge}>캐시됨</span>}
                </div>
                <span style={{ ...styles.assessmentBadge, color: meta.color, background: meta.background }}>
                    {meta.label}
                </span>
            </div>

            <h3 style={styles.headline}>{headline}</h3>
            <p style={styles.assessmentDescription}>{meta.description}</p>

            <div style={styles.confidenceBox}>
                <div style={styles.confidenceHeader}>
                    <span>휴리스틱 신뢰도</span>
                    <strong>{confidencePercent}% <small style={styles.capText}>/ CAP 45%</small></strong>
                </div>
                <div style={styles.confidenceTrack} aria-label={`신뢰도 ${confidencePercent}%`}>
                    <div style={{ ...styles.confidenceFill, width: `${confidencePercent}%` }} />
                    <div style={styles.capMarker} title="45% confidence cap" />
                </div>
            </div>

            <section style={styles.resultSection}>
                <h4 style={styles.resultTitle}>판단 근거</h4>
                {card.reasoning.length > 0 ? (
                    <ul style={styles.list}>{card.reasoning.map((item, itemIndex) => (
                        <ReasoningItem key={itemIndex} item={item} />
                    ))}</ul>
                ) : <p style={styles.emptyText}>근거가 제공되지 않았습니다.</p>}
            </section>

            <section style={styles.resultSection}>
                <h4 style={styles.resultTitle}>조건부 대안</h4>
                {card.alternatives.length > 0 ? (
                    <ul style={styles.list}>{card.alternatives.map((item, itemIndex) => (
                        <AlternativeItem key={itemIndex} item={item} />
                    ))}</ul>
                ) : <p style={styles.emptyText}>제시된 대안이 없습니다.</p>}
            </section>

            <section style={styles.resultSection}>
                <h4 style={styles.resultTitle}>알 수 없는 정보</h4>
                {card.unknowns.length > 0 ? (
                    <ul style={styles.unknownList}>{card.unknowns.map((item, itemIndex) => (
                        <li key={itemIndex}>{typeof item === 'string' ? item : JSON.stringify(item)}</li>
                    ))}</ul>
                ) : <p style={styles.emptyText}>모델이 별도로 표시한 미상 정보가 없습니다.</p>}
            </section>

            <section style={styles.reflectionBox}>
                <div style={styles.reflectionLabel}>내가 답해 볼 질문</div>
                <p style={styles.reflectionQuestion}>
                    {reflectionQuestion || '이 결정의 목적과 다음 street 계획은 무엇이었나요?'}
                </p>
            </section>

            <button
                type="button"
                onClick={onReanalyze}
                disabled={reanalyzing}
                style={{ ...styles.reanalyzeButton, opacity: reanalyzing ? 0.55 : 1 }}
            >
                {reanalyzing ? '재분석 중…' : '재분석'}
            </button>
        </article>
    );
}

const DetailedReviewPanel = ({ hand, settings = {} }) => {
    const { archive, sessionHands } = useGame();
    // items: [{ decisionSeq, outcome: {result, review, snapshot, cached}|null,
    //           error: poker-analysis-error.v1|Error|null, reanalyzing: boolean }]
    const [request, setRequest] = useState({ hand: null, status: 'idle', items: [], error: '' });
    const isCurrentRequest = request.hand === hand;
    const loading = isCurrentRequest && request.status === 'loading';
    const items = isCurrentRequest && request.status === 'success' ? request.items : [];
    const hasResults = items.length > 0;
    const error = isCurrentRequest && request.status === 'error' ? request.error : '';
    const isDetailed = !!hand?.detailed?.enabled;
    const isCompleted = !!hand?.detailed?.completed;
    const heroSeat = hand?.detailed?.heroSeat;
    const hasHero = typeof heroSeat === 'number'
        && safeArray(hand?.seats).some(seat => seat?.seat === heroSeat && !seat.sittingOut);
    const heroCardsKnown = safeArray(hand?.detailed?.heroCards).length === 2;
    const eligible = isDetailed && isCompleted && hasHero;
    const warnings = preflightWarnings(hand);
    const cards = items
        .filter(item => item.outcome)
        .map(item => ({ item, card: cardModelFromOutcome(item.outcome) }))
        .filter(entry => entry.card);
    const itemErrors = items.filter(item => item.error);
    const returnedQualityWarnings = snapshotQualityWarnings(items);
    const unexpectedMode = cards.some(entry => entry.card.analysisMode !== 'heuristic_no_solver');

    let aiPreview;
    try {
        aiPreview = resolveAiOptions(settings || {});
    } catch {
        aiPreview = { label: 'AI', model: '', apiKey: '' };
    }

    // 아카이브 + 현재 세션 핸드 (시간순) — as-of 상대 모델 참조의 시간축 원본
    const allHands = () => [
        ...safeArray(archive).flatMap(session => safeArray(session?.hands)),
        ...safeArray(sessionHands),
    ];

    const runDecision = async (targetHand, decisionSeq, options, opponentRef, bypassCache) => {
        try {
            return await analyzeDecision({
                hand: targetHand,
                decisionSeq,
                ai: options,
                opponentStatsAsOf: opponentRef,
                bypassCache,
            });
        } catch (caught) {
            // 게이트웨이는 구조화 오류를 반환하는 것이 계약이지만, 예기치 못한 throw도
            // 결정 하나의 실패로만 격리한다 (per-decision independence).
            return { error: caught instanceof Error ? caught : new Error(String(caught)) };
        }
    };

    const analyze = async () => {
        if (!eligible || loading) return;
        const targetHand = hand;
        setRequest({ hand: targetHand, status: 'loading', items: [], error: '' });
        try {
            const options = resolveAiOptions(settings || {});
            if (!options.apiKey) throw new Error(`설정에서 ${options.label || 'AI'} API 키를 입력하세요.`);
            const decisionSeqs = heroDecisionSeqs(targetHand);
            if (decisionSeqs.length === 0) throw new Error('분석할 히어로 액션이 없습니다.');
            if (decisionSeqs.length > MAX_DECISIONS) {
                throw new Error(`한 핸드에서 분석할 수 있는 히어로 결정은 최대 ${MAX_DECISIONS}개입니다.`);
            }
            const opponentRef = opponentModelRefFor(targetHand, allHands());
            const outcomes = await mapWithLimit(decisionSeqs, MAX_CONCURRENCY, seq =>
                runDecision(targetHand, seq, options, opponentRef, false));
            const nextItems = decisionSeqs.map((seq, index) => ({
                decisionSeq: seq,
                outcome: outcomes[index].error ? null : outcomes[index],
                error: outcomes[index].error ?? null,
                reanalyzing: false,
            }));
            setRequest({ hand: targetHand, status: 'success', items: nextItems, error: '' });
        } catch (caught) {
            const message = caught instanceof Error ? caught.message : '상세 핸드 리뷰에 실패했습니다.';
            setRequest({ hand: targetHand, status: 'error', items: [], error: message });
        }
    };

    // 카드 하나만 캐시를 우회해 다시 분석한다 (다른 결정 결과는 그대로 유지)
    const reanalyze = async (decisionSeq) => {
        const targetHand = hand;
        let options;
        try {
            options = resolveAiOptions(settings || {});
        } catch {
            return;
        }
        if (!options.apiKey) return;
        const patchItem = (patch) => setRequest(prev => {
            if (prev.hand !== targetHand || prev.status !== 'success') return prev;
            return {
                ...prev,
                items: prev.items.map(item =>
                    item.decisionSeq === decisionSeq ? { ...item, ...patch } : item),
            };
        });
        patchItem({ reanalyzing: true });
        const opponentRef = opponentModelRefFor(targetHand, allHands());
        const outcome = await runDecision(targetHand, decisionSeq, options, opponentRef, true);
        patchItem({
            outcome: outcome.error ? null : outcome,
            error: outcome.error ?? null,
            reanalyzing: false,
        });
    };

    if (!hand) {
        return <section style={styles.guardPanel}>리뷰할 핸드를 선택하세요.</section>;
    }

    return (
        <section style={styles.container} aria-label="AI 상세 핸드 리뷰">
            <div style={styles.modeWarning} role="note">
                <div style={styles.modeLabel}>HEURISTIC · NO SOLVER</div>
                <div style={styles.modeTitle}>솔버·정확 에퀴티·EV 계산이 아닙니다.</div>
                <p style={styles.modeCopy}>
                    이 리뷰는 기록된 사실을 이용한 사후 휴리스틱 복기입니다.
                    결과와 관계없이 신뢰도는 최대 45%로 제한됩니다.
                </p>
                <div style={styles.capBanner}>CONFIDENCE CAP 45%</div>
            </div>

            {!isDetailed && (
                <div style={styles.guardPanel} role="status">
                    <strong>상세 기록 핸드가 아닙니다.</strong>
                    <span>Board·스택·사이징이 기록된 핸드에서만 AI 복기를 시작할 수 있습니다.</span>
                </div>
            )}
            {isDetailed && !isCompleted && (
                <div style={styles.guardPanel} role="status">
                    <strong>핸드 기록이 아직 완료되지 않았습니다.</strong>
                    <span>리버 또는 폴드 종료 후 상세 기록을 완료하세요.</span>
                </div>
            )}
            {isDetailed && isCompleted && !hasHero && (
                <div style={styles.guardPanel} role="status">
                    <strong>Hero가 지정되지 않았습니다.</strong>
                    <span>어느 좌석의 결정을 복기할지 먼저 지정해 주세요.</span>
                </div>
            )}

            {isDetailed && isCompleted && hasHero && (
                <>
                    <div style={styles.actionPanel}>
                        <div>
                            <strong>Hero Seat {heroSeat + 1}</strong>
                            <div style={styles.providerText}>
                                {aiPreview.label}{aiPreview.model ? ` · ${aiPreview.model}` : ''}
                            </div>
                        </div>
                        <button
                            type="button"
                            onClick={analyze}
                            disabled={loading}
                            style={{ ...styles.analyzeButton, opacity: loading ? 0.55 : 1 }}
                        >
                            {loading ? '현재 시점별 복기 중…' : hasResults ? 'AI 리뷰 다시 실행' : 'AI 핸드 리뷰'}
                        </button>
                    </div>

                    {!heroCardsKnown && (
                        <div style={styles.dataWarning} role="note">
                            <strong>Hero 카드 미입력</strong>
                            <span>리뷰는 가능하지만 카드 상호작용·범위·블로커 판단은 제외됩니다.</span>
                        </div>
                    )}

                    {warnings.length > 0 && (
                        <div style={styles.dataWarning} role="note">
                            <strong>DATA QUALITY · 제한된 분석</strong>
                            <ul style={styles.warningList}>{warnings.map((warning, index) => (
                                <li key={index}>{warning}</li>
                            ))}</ul>
                        </div>
                    )}
                </>
            )}

            {loading && (
                <div style={styles.loadingPanel} role="status" aria-live="polite">
                    <span style={styles.loadingDot} />
                    <div>
                        <strong>결과·쇼다운을 제외하고 각 결정을 복기하고 있습니다.</strong>
                        <p style={styles.loadingCopy}>현재 street에서 알 수 있었던 정보만 사용합니다.</p>
                    </div>
                </div>
            )}

            {error && (
                <div style={styles.errorPanel} role="alert">
                    <strong>AI 리뷰를 완료하지 못했습니다.</strong>
                    <p style={styles.errorMessage}>{error}</p>
                    {eligible && <button type="button" onClick={analyze} style={styles.retryButton}>다시 시도</button>}
                </div>
            )}

            {hasResults && (
                <div style={styles.results}>
                    {unexpectedMode && (
                        <div style={styles.errorPanel} role="alert">
                            예상한 heuristic_no_solver 모드와 다른 응답입니다. 결과를 솔버 판정으로 해석하지 마세요.
                        </div>
                    )}

                    {returnedQualityWarnings.length > 0 && (
                        <div style={styles.dataWarning} role="note">
                            <strong>AI가 확인한 데이터 제한</strong>
                            <ul style={styles.warningList}>{returnedQualityWarnings.map((warning, index) => (
                                <li key={index}>{warning}</li>
                            ))}</ul>
                        </div>
                    )}

                    {itemErrors.length > 0 && (
                        <div style={styles.errorPanel} role="alert">
                            <strong>{itemErrors.length}개 결정은 리뷰하지 못했습니다.</strong>
                            <ul style={styles.warningList}>
                                {itemErrors.map((item, index) => (
                                    <li key={`${item.decisionSeq}-${index}`}>
                                        {streetLabelFor(null, hand, item.decisionSeq)} · {errorMessageFrom(item.error)}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}

                    {cards.length > 0 ? cards.map((entry, index) => (
                        <ReviewCard
                            key={entry.card.decisionId || entry.item.decisionSeq}
                            card={entry.card}
                            hand={hand}
                            decisionSeq={entry.item.decisionSeq}
                            index={index}
                            onReanalyze={() => reanalyze(entry.item.decisionSeq)}
                            reanalyzing={!!entry.item.reanalyzing}
                        />
                    )) : (
                        <div style={styles.guardPanel}>
                            <strong>표시할 Hero 결정 리뷰가 없습니다.</strong>
                            <span>Hero 액션이 기록되었는지 확인하세요.</span>
                        </div>
                    )}
                </div>
            )}
        </section>
    );
};

const styles = {
    container: { display: 'grid', gap: '11px', width: '100%', boxSizing: 'border-box', color: '#e2e8f0' },
    modeWarning: {
        position: 'relative', overflow: 'hidden', padding: '15px', border: '2px solid #f59e0b',
        borderRadius: '14px', background: 'linear-gradient(145deg, #451a03, #1c1917)', boxShadow: '0 8px 24px rgba(0, 0, 0, 0.24)',
    },
    modeLabel: { color: '#fde68a', fontSize: '0.72rem', fontWeight: 1000, letterSpacing: '0.12em' },
    modeTitle: { marginTop: '5px', color: '#fff7ed', fontSize: '0.96rem', fontWeight: 900 },
    modeCopy: { margin: '6px 0 0', maxWidth: '520px', color: '#fed7aa', fontSize: '0.76rem', lineHeight: 1.5 },
    capBanner: {
        display: 'inline-block', marginTop: '9px', padding: '5px 8px', border: '1px solid #fbbf24',
        borderRadius: '7px', background: '#78350f', color: '#fef3c7', fontSize: '0.67rem', fontWeight: 1000,
    },
    guardPanel: {
        display: 'grid', gap: '5px', padding: '14px', border: '1px solid #334155', borderRadius: '12px',
        background: '#111827', color: '#cbd5e1', fontSize: '0.8rem', lineHeight: 1.45,
    },
    actionPanel: {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', padding: '12px',
        border: '1px solid #334155', borderRadius: '12px', background: '#111827',
    },
    providerText: { marginTop: '3px', color: '#94a3b8', fontSize: '0.68rem', wordBreak: 'break-word' },
    analyzeButton: {
        minHeight: '46px', padding: '8px 13px', border: '1px solid #38bdf8', borderRadius: '10px',
        background: '#0369a1', color: '#fff', fontWeight: 900, cursor: 'pointer', whiteSpace: 'nowrap',
    },
    dataWarning: {
        display: 'grid', gap: '5px', padding: '12px', border: '1px solid #f59e0b', borderRadius: '11px',
        background: '#422006', color: '#fde68a', fontSize: '0.75rem', lineHeight: 1.45,
    },
    warningList: { display: 'grid', gap: '3px', margin: '2px 0 0', paddingLeft: '18px' },
    loadingPanel: {
        display: 'flex', alignItems: 'flex-start', gap: '11px', padding: '15px', border: '1px solid #0ea5e9',
        borderRadius: '12px', background: '#082f49', color: '#e0f2fe', fontSize: '0.78rem', lineHeight: 1.45,
    },
    loadingDot: { flexShrink: 0, width: '12px', height: '12px', marginTop: '3px', borderRadius: '50%', background: '#38bdf8', boxShadow: '0 0 0 5px rgba(56, 189, 248, 0.14)' },
    loadingCopy: { margin: '4px 0 0', color: '#bae6fd', fontSize: '0.72rem' },
    errorPanel: {
        padding: '13px', border: '1px solid #f87171', borderRadius: '12px', background: '#450a0a',
        color: '#fecaca', fontSize: '0.78rem', lineHeight: 1.45,
    },
    errorMessage: { margin: '5px 0 0', wordBreak: 'break-word' },
    retryButton: {
        minHeight: '40px', marginTop: '9px', padding: '7px 12px', border: '1px solid #fca5a5', borderRadius: '9px',
        background: '#7f1d1d', color: '#fff', fontWeight: 800, cursor: 'pointer',
    },
    results: { display: 'grid', gap: '11px' },
    reviewCard: { padding: '14px', border: '1px solid #334155', borderRadius: '14px', background: '#111827' },
    reviewHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' },
    decisionMeta: { display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap' },
    decisionIndex: { color: '#64748b', fontSize: '0.67rem', fontWeight: 900 },
    streetBadge: { padding: '4px 7px', borderRadius: '7px', background: '#1e293b', color: '#cbd5e1', fontSize: '0.67rem', fontWeight: 900 },
    actionBadge: { padding: '4px 7px', borderRadius: '7px', background: '#312e81', color: '#e0e7ff', fontSize: '0.67rem', fontWeight: 900 },
    cachedBadge: { padding: '4px 7px', borderRadius: '7px', border: '1px solid #475569', background: '#0f172a', color: '#94a3b8', fontSize: '0.65rem', fontWeight: 900 },
    assessmentBadge: { padding: '5px 8px', borderRadius: '999px', fontSize: '0.65rem', fontWeight: 1000 },
    headline: { margin: '11px 0 0', color: '#f8fafc', fontSize: '1rem', lineHeight: 1.42 },
    assessmentDescription: { margin: '5px 0 0', color: '#94a3b8', fontSize: '0.72rem', lineHeight: 1.45 },
    confidenceBox: { marginTop: '12px', padding: '9px', borderRadius: '10px', background: '#0f172a' },
    confidenceHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', color: '#cbd5e1', fontSize: '0.72rem' },
    capText: { color: '#fbbf24', fontSize: '0.61rem' },
    confidenceTrack: { position: 'relative', height: '7px', marginTop: '7px', borderRadius: '999px', background: '#334155', overflow: 'visible' },
    confidenceFill: { height: '100%', borderRadius: '999px', background: '#38bdf8' },
    capMarker: { position: 'absolute', left: '45%', top: '-3px', width: '2px', height: '13px', background: '#fbbf24' },
    resultSection: { marginTop: '14px' },
    resultTitle: { margin: 0, color: '#cbd5e1', fontSize: '0.77rem' },
    list: { display: 'grid', gap: '7px', margin: '7px 0 0', paddingLeft: '18px' },
    listItem: { color: '#e2e8f0', fontSize: '0.76rem', lineHeight: 1.5 },
    factRefs: { display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '4px' },
    factRef: { padding: '2px 4px', borderRadius: '4px', background: '#1e293b', color: '#94a3b8', fontSize: '0.58rem' },
    alternativeItem: { display: 'grid', gap: '3px', color: '#cbd5e1', fontSize: '0.74rem', lineHeight: 1.45 },
    alternativeAction: { color: '#c4b5fd' },
    unknownList: { display: 'grid', gap: '4px', margin: '7px 0 0', padding: '8px 8px 8px 25px', borderRadius: '9px', background: '#1c1917', color: '#fde68a', fontSize: '0.73rem', lineHeight: 1.45 },
    emptyText: { margin: '6px 0 0', color: '#64748b', fontSize: '0.72rem' },
    reflectionBox: { marginTop: '14px', padding: '11px', border: '1px solid #7c3aed', borderRadius: '11px', background: '#1e1b4b' },
    reflectionLabel: { color: '#c4b5fd', fontSize: '0.66rem', fontWeight: 1000, letterSpacing: '0.06em' },
    reflectionQuestion: { margin: '5px 0 0', color: '#f5f3ff', fontSize: '0.82rem', fontWeight: 700, lineHeight: 1.5 },
    reanalyzeButton: {
        minHeight: '38px', marginTop: '13px', padding: '6px 12px', border: '1px solid #475569', borderRadius: '9px',
        background: '#1e293b', color: '#cbd5e1', fontSize: '0.72rem', fontWeight: 800, cursor: 'pointer',
    },
};

export default DetailedReviewPanel;
