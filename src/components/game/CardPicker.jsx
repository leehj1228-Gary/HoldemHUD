import { useState } from 'react';
import { CARD_RANKS, CARD_SUITS } from '../../engine/schema.js';

// 랭크/수트 어휘(멤버십)는 schema.js에서만 온다 — 여기서는 표시 순서와 표기만 정한다.
const RANK_DISPLAY_ORDER = 'AKQJT98765432';
const RANKS = [...CARD_RANKS].sort(
    (a, b) => RANK_DISPLAY_ORDER.indexOf(a) - RANK_DISPLAY_ORDER.indexOf(b));
const SUIT_DISPLAY_ORDER = 'shdc';
const SUIT_PRESENTATION = {
    s: { symbol: '♠', label: '스페이드', color: '#e5e7eb' },
    h: { symbol: '♥', label: '하트', color: '#fb7185' },
    d: { symbol: '♦', label: '다이아몬드', color: '#60a5fa' },
    c: { symbol: '♣', label: '클로버', color: '#4ade80' },
};
const SUITS = [...CARD_SUITS]
    .sort((a, b) => SUIT_DISPLAY_ORDER.indexOf(a) - SUIT_DISPLAY_ORDER.indexOf(b))
    .map(key => ({ key, ...(SUIT_PRESENTATION[key] || { symbol: key, label: key, color: '#e5e7eb' }) }));

// 키는 schema DETAILED_PRECISIONS 토큰 그대로 — 한국어는 표시 라벨만
const QUALITY_LABELS = {
    exact: '정확',
    estimated: '대략',
    unknown: '모름',
};

function normalizeSuit(suit) {
    const value = String(suit || '').toLowerCase();
    if (value === '♠' || value === 'spade' || value === 'spades') return 's';
    if (value === '♥' || value === 'heart' || value === 'hearts') return 'h';
    if (value === '♦' || value === 'diamond' || value === 'diamonds') return 'd';
    if (value === '♣' || value === 'club' || value === 'clubs') return 'c';
    return value.charAt(0);
}

function normalizeCard(card) {
    if (!card) return '';
    if (typeof card === 'object') {
        const rank = String(card.rank || '').toUpperCase().replace('10', 'T');
        return rank && card.suit ? `${rank}${normalizeSuit(card.suit)}` : '';
    }
    const raw = String(card).trim().replace('10', 'T');
    if (raw.length < 2) return '';
    return `${raw.slice(0, -1).toUpperCase()}${normalizeSuit(raw.slice(-1))}`;
}

function cardDisplay(card) {
    const normalized = normalizeCard(card);
    const rank = normalized.slice(0, -1);
    const suit = SUITS.find(item => item.key === normalized.slice(-1));
    return {
        text: `${rank}${suit ? suit.symbol : ''}`,
        color: suit ? suit.color : '#e5e7eb',
    };
}

function CardPickerPanel({
    title,
    count,
    value,
    usedCards,
    qualityOptions,
    initialQuality,
    onConfirm,
    onClose,
}) {
    const [selected, setSelected] = useState(() =>
        (Array.isArray(value) ? value : []).map(normalizeCard).filter(Boolean).slice(0, count));
    const [pendingRank, setPendingRank] = useState(null);
    const [quality, setQuality] = useState(
        qualityOptions.includes(initialQuality) ? initialQuality : qualityOptions[0]);

    const unavailable = new Set(
        (Array.isArray(usedCards) ? usedCards : []).map(normalizeCard).filter(Boolean));

    const chooseSuit = (suit) => {
        if (!pendingRank || quality === 'unknown' || selected.length >= count) return;
        const card = `${pendingRank}${suit}`;
        if (unavailable.has(card) || selected.includes(card)) return;
        setSelected(current => [...current, card]);
        setPendingRank(null);
    };

    const removeCard = (index) => {
        setSelected(current => current.filter((_, itemIndex) => itemIndex !== index));
    };

    const canConfirm = quality === 'unknown' || selected.length === count;

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
                        <div style={styles.subtitle}>
                            {quality === 'unknown'
                                ? '카드를 모르는 상태로 기록합니다.'
                                : `랭크와 무늬를 순서대로 선택하세요 (${selected.length}/${count})`}
                        </div>
                    </div>
                    <button type="button" onClick={onClose} style={styles.closeButton} aria-label="닫기">
                        ×
                    </button>
                </div>

                <div style={styles.qualityRow} aria-label="기록 품질">
                    {qualityOptions.map(option => (
                        <button
                            type="button"
                            key={option}
                            onClick={() => {
                                setQuality(option);
                                setPendingRank(null);
                            }}
                            style={{
                                ...styles.qualityButton,
                                ...(quality === option ? styles.qualityButtonActive : null),
                            }}
                        >
                            {QUALITY_LABELS[option] || option}
                        </button>
                    ))}
                </div>

                <div style={styles.cardSlots}>
                    {Array.from({ length: count }, (_, index) => {
                        const card = selected[index];
                        const display = cardDisplay(card);
                        return (
                            <button
                                type="button"
                                key={index}
                                onClick={() => card && removeCard(index)}
                                disabled={!card || quality === 'unknown'}
                                aria-label={card ? `${display.text} 삭제` : `카드 ${index + 1} 비어 있음`}
                                style={{
                                    ...styles.cardSlot,
                                    color: display.color,
                                    ...(card ? styles.cardSlotFilled : null),
                                }}
                            >
                                {card ? display.text : '—'}
                            </button>
                        );
                    })}
                </div>

                <div style={{ opacity: quality === 'unknown' ? 0.35 : 1, pointerEvents: quality === 'unknown' ? 'none' : 'auto' }}>
                    <div style={styles.sectionLabel}>랭크</div>
                    <div style={styles.rankGrid}>
                        {RANKS.map(rank => (
                            <button
                                type="button"
                                key={rank}
                                onClick={() => setPendingRank(rank)}
                                disabled={selected.length >= count}
                                style={{
                                    ...styles.rankButton,
                                    ...(pendingRank === rank ? styles.rankButtonActive : null),
                                }}
                            >
                                {rank === 'T' ? '10' : rank}
                            </button>
                        ))}
                    </div>

                    <div style={styles.sectionLabel}>무늬</div>
                    <div style={styles.suitGrid}>
                        {SUITS.map(suit => {
                            const candidate = pendingRank ? `${pendingRank}${suit.key}` : '';
                            const disabled = !pendingRank
                                || selected.length >= count
                                || unavailable.has(candidate)
                                || selected.includes(candidate);
                            return (
                                <button
                                    type="button"
                                    key={suit.key}
                                    onClick={() => chooseSuit(suit.key)}
                                    disabled={disabled}
                                    aria-label={suit.label}
                                    style={{
                                        ...styles.suitButton,
                                        color: suit.color,
                                        opacity: disabled ? 0.35 : 1,
                                    }}
                                >
                                    {suit.symbol}
                                </button>
                            );
                        })}
                    </div>
                </div>

                <div style={styles.footer}>
                    <button type="button" onClick={onClose} style={styles.secondaryButton}>
                        취소
                    </button>
                    <button
                        type="button"
                        disabled={!canConfirm}
                        onClick={() => onConfirm({
                            cards: quality === 'unknown' ? [] : selected,
                            quality,
                        })}
                        style={{
                            ...styles.primaryButton,
                            opacity: canConfirm ? 1 : 0.45,
                        }}
                    >
                        {quality === 'unknown' ? '모름으로 기록' : '카드 확인'}
                    </button>
                </div>
            </div>
        </div>
    );
}

const CardPicker = ({
    open = false,
    title = '카드 선택',
    count = 1,
    value = [],
    usedCards = [],
    qualityOptions = ['exact', 'unknown'],
    initialQuality = 'exact',
    onConfirm = () => {},
    onClose = () => {},
}) => {
    if (!open) return null;
    const safeCount = Math.max(1, Number(count) || 1);
    const safeQualityOptions = Array.isArray(qualityOptions) && qualityOptions.length > 0
        ? qualityOptions
        : ['exact', 'unknown'];

    return (
        <CardPickerPanel
            title={title}
            count={safeCount}
            value={value}
            usedCards={usedCards}
            qualityOptions={safeQualityOptions}
            initialQuality={initialQuality}
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
        maxHeight: '92dvh',
        overflowY: 'auto',
        boxSizing: 'border-box',
        padding: '8px 16px calc(16px + env(safe-area-inset-bottom))',
        borderRadius: '22px 22px 0 0',
        background: '#111827',
        color: '#f8fafc',
        boxShadow: '0 -18px 45px rgba(0, 0, 0, 0.45)',
    },
    grabber: {
        width: '42px',
        height: '4px',
        margin: '2px auto 12px',
        borderRadius: '999px',
        background: '#475569',
    },
    header: {
        display: 'flex',
        justifyContent: 'space-between',
        gap: '12px',
        alignItems: 'flex-start',
    },
    title: { fontSize: '1.08rem', fontWeight: 800 },
    subtitle: { marginTop: '4px', color: '#94a3b8', fontSize: '0.8rem', lineHeight: 1.4 },
    closeButton: {
        minWidth: '44px',
        minHeight: '44px',
        padding: 0,
        border: 0,
        borderRadius: '12px',
        background: '#1e293b',
        color: '#e2e8f0',
        fontSize: '1.6rem',
        cursor: 'pointer',
    },
    qualityRow: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px', marginTop: '14px' },
    qualityButton: {
        minHeight: '42px',
        border: '1px solid #334155',
        borderRadius: '10px',
        background: '#1e293b',
        color: '#cbd5e1',
        fontWeight: 700,
        cursor: 'pointer',
    },
    qualityButtonActive: { border: '1px solid #38bdf8', background: '#0c4a6e', color: '#f0f9ff' },
    cardSlots: { display: 'flex', justifyContent: 'center', gap: '10px', margin: '18px 0 14px' },
    cardSlot: {
        width: '54px',
        height: '68px',
        border: '1px dashed #475569',
        borderRadius: '10px',
        background: '#0f172a',
        fontSize: '1.35rem',
        fontWeight: 900,
    },
    cardSlotFilled: { border: '1px solid #64748b', background: '#1e293b', cursor: 'pointer' },
    sectionLabel: { margin: '12px 0 7px', color: '#cbd5e1', fontSize: '0.8rem', fontWeight: 800 },
    rankGrid: { display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: '6px' },
    rankButton: {
        minHeight: '42px',
        padding: '4px',
        border: '1px solid #334155',
        borderRadius: '9px',
        background: '#1e293b',
        color: '#f8fafc',
        fontWeight: 800,
        cursor: 'pointer',
    },
    rankButtonActive: { border: '1px solid #38bdf8', background: '#075985' },
    suitGrid: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px' },
    suitButton: {
        minHeight: '54px',
        border: '1px solid #334155',
        borderRadius: '11px',
        background: '#1e293b',
        fontSize: '1.7rem',
        cursor: 'pointer',
    },
    footer: { display: 'grid', gridTemplateColumns: '1fr 1.5fr', gap: '10px', marginTop: '18px' },
    secondaryButton: {
        minHeight: '48px',
        border: '1px solid #475569',
        borderRadius: '12px',
        background: '#1e293b',
        color: '#e2e8f0',
        fontWeight: 800,
        cursor: 'pointer',
    },
    primaryButton: {
        minHeight: '48px',
        border: 0,
        borderRadius: '12px',
        background: '#0284c7',
        color: '#fff',
        fontWeight: 900,
        cursor: 'pointer',
    },
};

export default CardPicker;
