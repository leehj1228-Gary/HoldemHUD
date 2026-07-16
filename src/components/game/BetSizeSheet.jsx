import { useState } from 'react';

const QUALITY_LABELS = {
    exact: '정확',
    approximate: '대략',
    unknown: '모름',
};

function asPositiveNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
}

function roundedAmount(value, chipUnit = 0.01) {
    if (!Number.isFinite(value)) return null;
    const unit = asPositiveNumber(chipUnit) || 0.01;
    return Math.round((Math.round(value / unit) * unit) * 1e6) / 1e6;
}

function formatAmount(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '—';
    return new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 }).format(number);
}

function uniquePresets(items) {
    const seen = new Set();
    return items.filter(item => {
        const amount = asPositiveNumber(item.amount);
        if (amount === null || seen.has(amount)) return false;
        seen.add(amount);
        return true;
    });
}

function makePresets({ street, actionType, pot, currentBet, bigBlind, playerStack, chipUnit }) {
    const normalizedStreet = String(street || 'preflop').toLowerCase();
    const normalizedAction = String(actionType || 'bet').toLowerCase();
    const potAmount = asPositiveNumber(pot);
    const betAmount = asPositiveNumber(currentBet);
    const bbAmount = asPositiveNumber(bigBlind);
    const stackAmount = asPositiveNumber(playerStack);
    const items = [];

    if (normalizedAction === 'all-in') {
        if (stackAmount !== null) {
            items.push({ label: `스택 전체 ${formatAmount(stackAmount)}`, amount: stackAmount, source: 'stack' });
        }
        return items;
    }

    if (normalizedStreet === 'preflop') {
        const base = betAmount || bbAmount;
        if (base !== null) {
            [2.5, 3, 4].forEach(multiplier => {
                items.push({
                    label: betAmount
                        ? `${multiplier}× → ${formatAmount(roundedAmount(base * multiplier, chipUnit))}`
                        : `${multiplier} BB → ${formatAmount(roundedAmount(base * multiplier, chipUnit))}`,
                    amount: roundedAmount(base * multiplier, chipUnit),
                    source: `${multiplier}x`,
                });
            });
        }
    } else if (normalizedAction === 'bet' && potAmount !== null) {
        [
            { fraction: 1 / 3, label: '⅓ Pot' },
            { fraction: 1 / 2, label: '½ Pot' },
            { fraction: 2 / 3, label: '⅔ Pot' },
            { fraction: 3 / 4, label: '¾ Pot' },
            { fraction: 1, label: 'Pot' },
        ].forEach(item => {
            const amount = roundedAmount(potAmount * item.fraction, chipUnit);
            items.push({
                label: `${item.label} · ${formatAmount(amount)}`,
                amount,
                source: `pot:${item.fraction}`,
            });
        });
    } else if (betAmount !== null) {
        [2.5, 3, 4].forEach(multiplier => {
            const amount = roundedAmount(betAmount * multiplier, chipUnit);
            items.push({
                label: `총 ${formatAmount(amount)} · ${multiplier}×`,
                amount,
                source: `${multiplier}x`,
            });
        });
    }

    if (stackAmount !== null) {
        items.push({ label: `All-in · ${formatAmount(stackAmount)}`, amount: stackAmount, source: 'stack' });
    }

    return uniquePresets(items);
}

function BetSizePanel({
    title,
    actionType,
    street,
    pot,
    potQuality,
    currentBet,
    toCall,
    minRaiseTo,
    bigBlind,
    playerStack,
    chipUnit,
    currency,
    initialAmount,
    initialQuality,
    requiresAllInKind,
    onConfirm,
    onClose,
}) {
    const [amountText, setAmountText] = useState(
        asPositiveNumber(initialAmount) === null ? '' : String(initialAmount));
    const [quality, setQuality] = useState(initialQuality);
    const [source, setSource] = useState('manual');
    const [allInKind, setAllInKind] = useState(requiresAllInKind ? 'call' : null);
    const presets = makePresets({ street, actionType, pot, currentBet, bigBlind, playerStack, chipUnit });
    const amount = asPositiveNumber(amountText);
    // 엔진이 거부할 최소 미달 금액은 확인 전에 차단한다 (숫자 비교만 — 규칙 계산 없음).
    // 명시적 올인(all-in 액션·스택 프리셋)은 최소 미달이어도 합법(short all-in)이라 검사하지 않는다.
    const minRequired = (actionType === 'bet' || actionType === 'raise') && source !== 'stack'
        ? asPositiveNumber(minRaiseTo)
        : null;
    const belowMinimum = quality !== 'unknown' && amount !== null
        && minRequired !== null && amount < minRequired;
    const canConfirm = (quality === 'unknown' || amount !== null) && !belowMinimum;
    const qualityPrefix = potQuality === 'approximate' || potQuality === 'estimated'
        ? '≈'
        : potQuality === 'unknown' ? '?' : '=';

    const selectPreset = (preset) => {
        setAmountText(String(preset.amount));
        setSource(preset.source);
        if (potQuality !== 'exact' && preset.source.startsWith('pot:')) {
            setQuality('approximate');
        } else if (quality === 'unknown') {
            setQuality('exact');
        }
    };

    return (
        <div
            role="dialog"
            aria-modal="true"
            aria-label={title}
            style={styles.overlay}
            onClick={(event) => {
                if (event.target === event.currentTarget) onClose();
            }}
        >
            <div style={styles.sheet}>
                <div style={styles.grabber} />
                <div style={styles.header}>
                    <div>
                        <div style={styles.title}>{title}</div>
                        <div style={styles.summary}>
                            Pot {qualityPrefix}{formatAmount(pot)}
                            {asPositiveNumber(toCall) !== null ? ` · Call ${formatAmount(toCall)}` : ''}
                            {asPositiveNumber(currentBet) !== null ? ` · 현재 베팅 ${formatAmount(currentBet)}` : ''}
                        </div>
                    </div>
                    <button type="button" onClick={onClose} style={styles.closeButton} aria-label="닫기">
                        ×
                    </button>
                </div>

                {presets.length > 0 && (
                    <div style={styles.presetGrid}>
                        {presets.map(preset => (
                            <button
                                type="button"
                                key={`${preset.source}-${preset.amount}`}
                                onClick={() => selectPreset(preset)}
                                style={{
                                    ...styles.presetButton,
                                    ...(source === preset.source && amount === preset.amount ? styles.presetButtonActive : null),
                                }}
                            >
                                {preset.label}
                            </button>
                        ))}
                    </div>
                )}

                <label style={styles.inputLabel}>
                    {actionType === 'raise' || actionType === 'all-in' ? '액션 후 총금액' : '기록할 금액'}
                    <div style={styles.inputWrap}>
                        {currency && <span style={styles.currency}>{currency}</span>}
                        <input
                            type="number"
                            min="0"
                            step="any"
                            inputMode="decimal"
                            value={amountText}
                            disabled={quality === 'unknown'}
                            onChange={(event) => {
                                setAmountText(event.target.value);
                                setSource('manual');
                            }}
                            placeholder="예: 1200"
                            style={styles.amountInput}
                        />
                    </div>
                </label>

                {belowMinimum && (
                    <div role="alert" style={styles.minError}>
                        {actionType === 'raise'
                            ? `최소 레이즈는 ${formatAmount(minRequired)}입니다`
                            : `최소 벳은 ${formatAmount(minRequired)}입니다`}
                    </div>
                )}

                {actionType === 'all-in' && requiresAllInKind && (
                    <div style={styles.allInKindSection}>
                        <div style={styles.kindLabel}>올인의 성격</div>
                        <div style={styles.allInKindRow}>
                            {[
                                { value: 'call', label: '콜 올인' },
                                { value: 'raise', label: '레이즈 올인' },
                            ].map(option => (
                                <button
                                    type="button"
                                    key={option.value}
                                    onClick={() => setAllInKind(option.value)}
                                    style={{
                                        ...styles.qualityButton,
                                        ...(allInKind === option.value ? styles.qualityButtonActive : null),
                                    }}
                                >
                                    {option.label}
                                </button>
                            ))}
                        </div>
                        <div style={styles.kindHint}>금액을 모를 때도 다음 액션 순서를 유지합니다.</div>
                    </div>
                )}

                <div style={styles.qualityRow} aria-label="금액 품질">
                    {Object.keys(QUALITY_LABELS).map(option => (
                        <button
                            type="button"
                            key={option}
                            onClick={() => setQuality(option)}
                            style={{
                                ...styles.qualityButton,
                                ...(quality === option ? styles.qualityButtonActive : null),
                            }}
                        >
                            <span style={styles.qualityMark}>
                                {option === 'exact' ? '=' : option === 'approximate' ? '≈' : '?'}
                            </span>
                            {QUALITY_LABELS[option]}
                        </button>
                    ))}
                </div>

                <div style={styles.hint}>
                    {quality === 'exact' && '실제 칩 금액으로 기록합니다.'}
                    {quality === 'approximate' && '대략적인 금액으로 표시하여 분석 확신도를 낮춥니다.'}
                    {quality === 'unknown' && '금액을 추정하지 않고 모름으로 저장합니다.'}
                </div>

                <div style={styles.footer}>
                    <button type="button" onClick={onClose} style={styles.secondaryButton}>
                        취소
                    </button>
                    <button
                        type="button"
                        disabled={!canConfirm}
                        onClick={() => onConfirm({
                            amount: quality === 'unknown' ? null : amount,
                            quality,
                            unit: 'chips',
                            source: quality === 'unknown' ? 'unknown' : source,
                            allInKind,
                            actionType,
                            street,
                        })}
                        style={{
                            ...styles.primaryButton,
                            opacity: canConfirm ? 1 : 0.45,
                        }}
                    >
                        {quality === 'unknown' ? '모름으로 기록' : '금액 확인'}
                    </button>
                </div>
            </div>
        </div>
    );
}

const BetSizeSheet = ({
    open = false,
    title = '베팅 금액',
    actionType = 'bet',
    street = 'preflop',
    pot = null,
    potQuality = 'unknown',
    currentBet = null,
    toCall = null,
    minRaiseTo = null,
    bigBlind = null,
    playerStack = null,
    chipUnit = 0.01,
    currency = '',
    initialAmount = null,
    initialQuality,
    requiresAllInKind = false,
    onConfirm = () => {},
    onClose = () => {},
}) => {
    if (!open) return null;
    const safeInitialQuality = initialQuality
        || (potQuality === 'exact' ? 'exact' : 'approximate');

    return (
        <BetSizePanel
            title={title}
            actionType={actionType}
            street={street}
            pot={pot}
            potQuality={potQuality}
            currentBet={currentBet}
            toCall={toCall}
            minRaiseTo={minRaiseTo}
            bigBlind={bigBlind}
            playerStack={playerStack}
            chipUnit={chipUnit}
            currency={currency}
            initialAmount={initialAmount}
            initialQuality={safeInitialQuality}
            requiresAllInKind={requiresAllInKind}
            onConfirm={onConfirm}
            onClose={onClose}
        />
    );
};

const styles = {
    overlay: {
        position: 'fixed',
        inset: 0,
        zIndex: 1200,
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
        background: 'rgba(2, 6, 23, 0.72)',
        paddingTop: 'env(safe-area-inset-top)',
    },
    sheet: {
        width: '100%',
        maxWidth: '640px',
        maxHeight: '90dvh',
        overflowY: 'auto',
        boxSizing: 'border-box',
        padding: '8px 16px calc(16px + env(safe-area-inset-bottom))',
        borderRadius: '22px 22px 0 0',
        background: '#111827',
        color: '#f8fafc',
        boxShadow: '0 -18px 45px rgba(0, 0, 0, 0.45)',
    },
    grabber: { width: '42px', height: '4px', margin: '2px auto 12px', borderRadius: '999px', background: '#475569' },
    header: { display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'flex-start' },
    title: { fontSize: '1.08rem', fontWeight: 900 },
    summary: { marginTop: '4px', color: '#94a3b8', fontSize: '0.8rem', lineHeight: 1.45 },
    closeButton: {
        minWidth: '44px', minHeight: '44px', padding: 0, border: 0, borderRadius: '12px',
        background: '#1e293b', color: '#e2e8f0', fontSize: '1.6rem', cursor: 'pointer',
    },
    presetGrid: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '8px', marginTop: '16px' },
    presetButton: {
        minHeight: '48px', padding: '8px', border: '1px solid #334155', borderRadius: '11px',
        background: '#1e293b', color: '#e2e8f0', fontWeight: 800, cursor: 'pointer',
    },
    presetButtonActive: { border: '1px solid #38bdf8', background: '#0c4a6e', color: '#f0f9ff' },
    inputLabel: { display: 'block', marginTop: '16px', color: '#cbd5e1', fontSize: '0.8rem', fontWeight: 800 },
    inputWrap: {
        display: 'flex', alignItems: 'center', marginTop: '7px', border: '1px solid #475569',
        borderRadius: '12px', background: '#0f172a', overflow: 'hidden',
    },
    currency: { paddingLeft: '14px', color: '#94a3b8', fontWeight: 800 },
    amountInput: {
        width: '100%', minHeight: '52px', boxSizing: 'border-box', padding: '10px 14px', border: 0,
        outline: 'none', background: 'transparent', color: '#f8fafc', fontSize: '1.15rem', fontWeight: 900,
    },
    minError: { marginTop: '8px', color: '#fb7185', fontSize: '0.78rem', fontWeight: 800 },
    qualityRow: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px', marginTop: '14px' },
    allInKindSection: { marginTop: '13px' },
    kindLabel: { color: '#cbd5e1', fontSize: '0.8rem', fontWeight: 800 },
    allInKindRow: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginTop: '7px' },
    kindHint: { marginTop: '6px', color: '#94a3b8', fontSize: '0.7rem' },
    qualityButton: {
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px', minHeight: '44px',
        border: '1px solid #334155', borderRadius: '10px', background: '#1e293b', color: '#cbd5e1',
        fontWeight: 800, cursor: 'pointer',
    },
    qualityButtonActive: { border: '1px solid #38bdf8', background: '#075985', color: '#fff' },
    qualityMark: { fontSize: '1.05rem' },
    hint: { minHeight: '38px', marginTop: '10px', color: '#94a3b8', fontSize: '0.78rem', lineHeight: 1.45 },
    footer: { display: 'grid', gridTemplateColumns: '1fr 1.5fr', gap: '10px', marginTop: '8px' },
    secondaryButton: {
        minHeight: '48px', border: '1px solid #475569', borderRadius: '12px', background: '#1e293b',
        color: '#e2e8f0', fontWeight: 800, cursor: 'pointer',
    },
    primaryButton: {
        minHeight: '48px', border: 0, borderRadius: '12px', background: '#0284c7', color: '#fff',
        fontWeight: 900, cursor: 'pointer',
    },
};

export default BetSizeSheet;
