import { useState } from 'react';
import { analyzeDetailedHand, resolveAiOptions } from '../../services/aiService.js';

const CONFIDENCE_CAP = 0.45;
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
    const raw = typeof confidence === 'object' && confidence !== null
        ? Number(confidence.value)
        : Number(confidence);
    if (!Number.isFinite(raw) || raw < 0) return 0;
    const ratio = raw > 1 ? raw / 100 : raw;
    return Math.min(ratio, CONFIDENCE_CAP);
}

function actionFromHand(review, hand) {
    const decisionId = stringValue(review?.decisionId);
    const sequenceMatch = decisionId.match(/:a(\d+)$/);
    if (!sequenceMatch) return null;
    const sequence = Number(sequenceMatch[1]);
    const action = safeArray(hand?.actions).find(candidate => candidate?.seq === sequence);
    return action?.isAllIn ? 'all-in' : (action?.type || null);
}

function reviewAction(review, hand) {
    const raw = actionFromHand(review, hand)
        ?? review?.action
        ?? review?.actualAction?.type
        ?? review?.decision?.actualAction?.type
        ?? review?.decision?.action;
    const type = typeof raw === 'object' ? raw.type : raw;
    return ACTION_LABELS[type] || stringValue(type, '액션 미상');
}

function reviewsFromResult(result) {
    if (Array.isArray(result)) return result;
    if (!result || typeof result !== 'object') return [];
    if (Array.isArray(result.reviews)) return result.reviews;
    if (Array.isArray(result.results)) return result.results;
    if (Array.isArray(result.items)) {
        return result.items.map(item => {
            if (item?.review) {
                return {
                    ...item.review,
                    decision: item.decision,
                    dataQuality: item.decision?.dataQuality,
                };
            }
            return item?.assessment ? item : null;
        }).filter(Boolean);
    }
    if (Array.isArray(result.decisions)) {
        return result.decisions.map(item => item?.review || item?.analysis || item).filter(Boolean);
    }
    if (result.review && typeof result.review === 'object') return [result.review];
    return result.assessment ? [result] : [];
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
        return precision === 'estimated' || precision === 'approximate';
    }).length;
    if (unknownStacks > 0) warnings.push(`시작 스택을 모르는 좌석이 ${unknownStacks}개입니다.`);
    if (estimatedStacks > 0) warnings.push(`시작 스택 ${estimatedStacks}개가 대략값입니다.`);

    const amountActions = safeArray(hand.actions).filter(action =>
        ['call', 'bet', 'raise', 'all-in'].includes(action?.type));
    const unknownAmounts = amountActions.filter(action =>
        action.precision === 'unknown' || action.amountTo === null || action.amountTo === undefined).length;
    const estimatedAmounts = amountActions.filter(action =>
        action.precision === 'estimated' || action.precision === 'approximate').length;
    if (unknownAmounts > 0) warnings.push(`금액을 모르는 액션이 ${unknownAmounts}개입니다.`);
    if (estimatedAmounts > 0) warnings.push(`베팅 금액 ${estimatedAmounts}개가 대략값입니다.`);
    return warnings;
}

function resultQualityWarnings(result, reviews) {
    const warnings = [];
    const qualityObjects = [result?.dataQuality, ...reviews.map(review => review?.dataQuality)].filter(Boolean);
    qualityObjects.forEach(quality => {
        safeArray(quality.warnings).forEach(item => {
            const text = stringValue(item);
            if (text) warnings.push(text);
        });
        safeArray(quality.unknownFields).forEach(item => {
            const text = stringValue(item);
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

function ReviewCard({ review, index, hand }) {
    const meta = assessmentMeta(review?.assessment);
    const confidence = normalizedConfidence(review?.confidence);
    const confidencePercent = Math.round(confidence * 100);
    const street = STREET_LABELS[String(review?.street || '').toLowerCase()]
        || stringValue(review?.street, 'Street 미상');
    const reasoning = safeArray(review?.reasoning);
    const alternatives = safeArray(review?.alternatives);
    const unknowns = safeArray(review?.unknowns);
    const headline = stringValue(review?.headline, '이 결정의 복기 결과입니다.');
    const reflectionQuestion = stringValue(review?.reflectionQuestion);

    return (
        <article style={styles.reviewCard}>
            <div style={styles.reviewHeader}>
                <div style={styles.decisionMeta}>
                    <span style={styles.decisionIndex}>#{index + 1}</span>
                    <span style={styles.streetBadge}>{street}</span>
                    <span style={styles.actionBadge}>{reviewAction(review, hand)}</span>
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
                {reasoning.length > 0 ? (
                    <ul style={styles.list}>{reasoning.map((item, itemIndex) => (
                        <ReasoningItem key={itemIndex} item={item} />
                    ))}</ul>
                ) : <p style={styles.emptyText}>근거가 제공되지 않았습니다.</p>}
            </section>

            <section style={styles.resultSection}>
                <h4 style={styles.resultTitle}>조건부 대안</h4>
                {alternatives.length > 0 ? (
                    <ul style={styles.list}>{alternatives.map((item, itemIndex) => (
                        <AlternativeItem key={itemIndex} item={item} />
                    ))}</ul>
                ) : <p style={styles.emptyText}>제시된 대안이 없습니다.</p>}
            </section>

            <section style={styles.resultSection}>
                <h4 style={styles.resultTitle}>알 수 없는 정보</h4>
                {unknowns.length > 0 ? (
                    <ul style={styles.unknownList}>{unknowns.map((item, itemIndex) => (
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
        </article>
    );
}

const DetailedReviewPanel = ({ hand, settings = {} }) => {
    const [request, setRequest] = useState({ hand: null, status: 'idle', result: null, error: '' });
    const isCurrentRequest = request.hand === hand;
    const loading = isCurrentRequest && request.status === 'loading';
    const result = isCurrentRequest && request.status === 'success' ? request.result : null;
    const error = isCurrentRequest && request.status === 'error' ? request.error : '';
    const isDetailed = !!hand?.detailed?.enabled;
    const isCompleted = !!hand?.detailed?.completed;
    const heroSeat = hand?.detailed?.heroSeat;
    const hasHero = typeof heroSeat === 'number'
        && safeArray(hand?.seats).some(seat => seat?.seat === heroSeat && !seat.sittingOut);
    const heroCardsKnown = safeArray(hand?.detailed?.heroCards).length === 2;
    const eligible = isDetailed && isCompleted && hasHero;
    const warnings = preflightWarnings(hand);
    const reviews = reviewsFromResult(result);
    const itemErrors = safeArray(result?.items).filter(item => item?.error);
    const returnedQualityWarnings = resultQualityWarnings(result, reviews);
    const unexpectedMode = result?.analysisMode && result.analysisMode !== 'heuristic_no_solver';

    let aiPreview;
    try {
        aiPreview = resolveAiOptions(settings || {});
    } catch {
        aiPreview = { label: 'AI', model: '', apiKey: '' };
    }

    const analyze = async () => {
        if (!eligible || loading) return;
        const targetHand = hand;
        setRequest({ hand: targetHand, status: 'loading', result: null, error: '' });
        try {
            const options = resolveAiOptions(settings || {});
            if (!options.apiKey) throw new Error(`설정에서 ${options.label || 'AI'} API 키를 입력하세요.`);
            const nextResult = await analyzeDetailedHand(targetHand, options);
            if (!nextResult) throw new Error('AI 리뷰 결과가 비어 있습니다.');
            setRequest({ hand: targetHand, status: 'success', result: nextResult, error: '' });
        } catch (caught) {
            const message = caught instanceof Error ? caught.message : '상세 핸드 리뷰에 실패했습니다.';
            setRequest({ hand: targetHand, status: 'error', result: null, error: message });
        }
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
                            {loading ? '현재 시점별 복기 중…' : result ? 'AI 리뷰 다시 실행' : 'AI 핸드 리뷰'}
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

            {result && (
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
                                    <li key={`${item.decision?.decisionId || 'decision'}-${index}`}>
                                        {STREET_LABELS[item.decision?.street] || item.decision?.street || 'Street 미상'} · {' '}
                                        {item.error?.message || '알 수 없는 오류'}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}

                    {reviews.length > 0 ? reviews.map((review, index) => (
                        <ReviewCard key={review?.decisionId || index} review={review} index={index} hand={hand} />
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
};

export default DetailedReviewPanel;
