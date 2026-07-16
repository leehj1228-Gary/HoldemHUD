import { useState } from 'react';

const STACK_PRESETS = [25, 50, 100, 150];
const PRECISION_OPTIONS = [
    { value: 'exact', mark: '=', label: '정확' },
    { value: 'estimated', mark: '≈', label: '대략' },
    { value: 'unknown', mark: '?', label: '모름' },
];

function finiteNonNegative(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
}

function positiveNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
}

function formatAmount(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '—';
    return new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 }).format(number);
}

function roundAmount(value) {
    return Math.round(value * 100) / 100;
}

// 정밀도 어휘는 schema DETAILED_PRECISIONS 토큰만 — 값이 있는데 토큰이 없으면 estimated
function normalizePrecision(value, hasValue) {
    if (value === 'exact') return 'exact';
    if (value === 'estimated') return 'estimated';
    return hasValue ? 'estimated' : 'unknown';
}

function stackInBB(seat, bigBlind) {
    const directBB = finiteNonNegative(seat?.startingStackBB ?? seat?.stackBB);
    if (directBB !== null) return directBB;

    const chips = finiteNonNegative(seat?.startingStack ?? seat?.stackAmount ?? seat?.chips ?? seat?.stack);
    const bb = positiveNumber(bigBlind);
    if (chips !== null && bb !== null) return roundAmount(chips / bb);
    return null;
}

function initialEntries(seats, bigBlind) {
    const entries = {};
    seats.forEach(seat => {
        const bb = stackInBB(seat, bigBlind);
        const existingPrecision = seat?.startingStackPrecision ?? seat?.stackPrecision;
        entries[String(seat.seat)] = {
            bb: bb === null ? '' : String(bb),
            precision: normalizePrecision(existingPrecision, bb !== null),
        };
    });
    return entries;
}

function SetupPanel({ seats, bigBlind, onConfirm, onSkip, onClose }) {
    const activeSeats = seats.filter(seat => seat && !seat.sittingOut);
    const initialHero = activeSeats.find(seat => seat.isHero)?.seat ?? null;
    const [heroSeat, setHeroSeat] = useState(initialHero);
    const [entries, setEntries] = useState(() => initialEntries(activeSeats, bigBlind));
    const bbValue = positiveNumber(bigBlind) || 1;

    const updateEntry = (seat, patch) => {
        const key = String(seat);
        setEntries(current => ({
            ...current,
            [key]: { ...(current[key] || { bb: '', precision: 'unknown' }), ...patch },
        }));
    };

    const setAllUnknown = () => {
        const next = {};
        activeSeats.forEach(seat => {
            next[String(seat.seat)] = { bb: '', precision: 'unknown' };
        });
        setEntries(next);
    };

    const setAllOneHundred = () => {
        const next = {};
        activeSeats.forEach(seat => {
            next[String(seat.seat)] = { bb: '100', precision: 'estimated' };
        });
        setEntries(next);
    };

    const invalidSeats = activeSeats.filter(seat => {
        const entry = entries[String(seat.seat)] || { bb: '', precision: 'unknown' };
        return entry.precision !== 'unknown' && finiteNonNegative(entry.bb) === null;
    });
    const canConfirm = heroSeat !== null && heroSeat !== undefined && invalidSeats.length === 0;

    const submit = () => {
        if (!canConfirm) return;
        const startingStacks = {};
        const stackPrecisions = {};

        activeSeats.forEach(seat => {
            const entry = entries[String(seat.seat)] || { bb: '', precision: 'unknown' };
            const precision = normalizePrecision(entry.precision, finiteNonNegative(entry.bb) !== null);
            const stackBB = finiteNonNegative(entry.bb);
            startingStacks[seat.seat] = precision === 'unknown' || stackBB === null
                ? null
                : roundAmount(stackBB * bbValue);
            stackPrecisions[seat.seat] = precision;
        });

        onConfirm({ heroSeat, startingStacks, stackPrecisions });
    };

    return (
        <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="detailed-setup-title"
            style={styles.overlay}
            onClick={(event) => {
                if (event.target === event.currentTarget) onClose();
            }}
        >
            <section style={styles.sheet}>
                <div style={styles.grabber} />

                <header style={styles.header}>
                    <div>
                        <div style={styles.eyebrow}>DETAIL TRACKER</div>
                        <h2 id="detailed-setup-title" style={styles.title}>상세 기록 준비</h2>
                        <p style={styles.subtitle}>
                            Hero를 고르고 알고 있는 시작 스택만 입력하세요.
                            {' '}1BB = {formatAmount(bbValue)}
                        </p>
                    </div>
                    <button type="button" onClick={onClose} style={styles.closeButton} aria-label="닫기">
                        ×
                    </button>
                </header>

                <div style={styles.scrollArea}>
                    {activeSeats.length === 0 ? (
                        <div style={styles.emptyState}>상세 기록할 플레이어가 없습니다.</div>
                    ) : (
                        <>
                            <section style={styles.section}>
                                <div style={styles.sectionTitle}>1. Hero 선택</div>
                                <div style={styles.heroGrid}>
                                    {activeSeats.map(seat => {
                                        const selected = String(heroSeat) === String(seat.seat);
                                        return (
                                            <button
                                                type="button"
                                                key={seat.seat}
                                                aria-pressed={selected}
                                                onClick={() => setHeroSeat(seat.seat)}
                                                style={{
                                                    ...styles.heroButton,
                                                    ...(selected ? styles.heroButtonActive : null),
                                                }}
                                            >
                                                <span style={styles.heroPosition}>{seat.position || `Seat ${Number(seat.seat) + 1}`}</span>
                                                <span style={styles.heroName}>{seat.name || `Seat ${Number(seat.seat) + 1}`}</span>
                                            </button>
                                        );
                                    })}
                                </div>
                            </section>

                            <section style={styles.section}>
                                <div style={styles.sectionHeadingRow}>
                                    <div>
                                        <div style={styles.sectionTitle}>2. 시작 스택</div>
                                        <div style={styles.sectionHint}>모르는 좌석은 추정하지 않아도 됩니다.</div>
                                    </div>
                                </div>

                                <div style={styles.bulkActions}>
                                    <button type="button" onClick={setAllUnknown} style={styles.bulkSecondary}>
                                        ? 모두 모름
                                    </button>
                                    <button type="button" onClick={setAllOneHundred} style={styles.bulkPrimary}>
                                        ≈ 모두 약 100BB
                                    </button>
                                </div>

                                <div style={styles.seatList}>
                                    {activeSeats.map(seat => {
                                        const key = String(seat.seat);
                                        const entry = entries[key] || { bb: '', precision: 'unknown' };
                                        const stackBB = finiteNonNegative(entry.bb);
                                        const isHero = String(heroSeat) === key;
                                        const hasInvalidAmount = entry.precision !== 'unknown' && stackBB === null;

                                        return (
                                            <article key={seat.seat} style={styles.seatCard}>
                                                <div style={styles.seatHeader}>
                                                    <div style={styles.seatIdentity}>
                                                        <span style={styles.positionBadge}>{seat.position || `S${Number(seat.seat) + 1}`}</span>
                                                        <strong style={styles.seatName}>{seat.name || `Seat ${Number(seat.seat) + 1}`}</strong>
                                                        {isHero && <span style={styles.heroBadge}>HERO</span>}
                                                    </div>
                                                    <span style={styles.stackPreview}>
                                                        {entry.precision === 'unknown' || stackBB === null
                                                            ? '스택 모름'
                                                            : `${entry.precision === 'estimated' ? '≈' : '='}${formatAmount(stackBB * bbValue)}`}
                                                    </span>
                                                </div>

                                                <div style={styles.presetRow}>
                                                    {STACK_PRESETS.map(preset => {
                                                        const selected = entry.precision !== 'unknown' && stackBB === preset;
                                                        return (
                                                            <button
                                                                type="button"
                                                                key={preset}
                                                                onClick={() => updateEntry(seat.seat, {
                                                                    bb: String(preset),
                                                                    precision: entry.precision === 'exact' ? 'exact' : 'estimated',
                                                                })}
                                                                style={{
                                                                    ...styles.presetButton,
                                                                    ...(selected ? styles.presetButtonActive : null),
                                                                }}
                                                            >
                                                                {preset}<small style={styles.bbUnit}>BB</small>
                                                            </button>
                                                        );
                                                    })}
                                                    <label style={styles.customInputWrap}>
                                                        <span style={styles.visuallyHidden}>
                                                            {seat.name || `Seat ${Number(seat.seat) + 1}`} 스택 BB
                                                        </span>
                                                        <input
                                                            type="number"
                                                            min="0"
                                                            step="any"
                                                            inputMode="decimal"
                                                            value={entry.bb}
                                                            onChange={(event) => updateEntry(seat.seat, {
                                                                bb: event.target.value,
                                                                precision: entry.precision === 'unknown' ? 'exact' : entry.precision,
                                                            })}
                                                            placeholder="직접"
                                                            style={styles.customInput}
                                                        />
                                                        <span style={styles.inputUnit}>BB</span>
                                                    </label>
                                                </div>

                                                <div style={styles.precisionRow} aria-label={`${seat.name || 'Seat'} 스택 정확도`}>
                                                    {PRECISION_OPTIONS.map(option => (
                                                        <button
                                                            type="button"
                                                            key={option.value}
                                                            onClick={() => updateEntry(seat.seat, { precision: option.value })}
                                                            style={{
                                                                ...styles.precisionButton,
                                                                ...(entry.precision === option.value ? styles.precisionButtonActive : null),
                                                            }}
                                                        >
                                                            <span>{option.mark}</span> {option.label}
                                                        </button>
                                                    ))}
                                                </div>

                                                {hasInvalidAmount && (
                                                    <div role="alert" style={styles.validationMessage}>
                                                        정확 또는 대략을 선택했다면 BB 금액을 입력하세요.
                                                    </div>
                                                )}
                                            </article>
                                        );
                                    })}
                                </div>
                            </section>
                        </>
                    )}
                </div>

                <footer style={styles.footer}>
                    {heroSeat === null || heroSeat === undefined ? (
                        <div style={styles.footerHint}>Hero를 선택하면 상세 기록을 시작할 수 있어요.</div>
                    ) : invalidSeats.length > 0 ? (
                        <div style={styles.footerHint}>{invalidSeats.length}개 좌석의 스택 입력을 확인하세요.</div>
                    ) : (
                        <div style={styles.footerHint}>모름 스택은 임의로 추정하지 않습니다.</div>
                    )}
                    <div style={styles.footerActions}>
                        <button type="button" onClick={onSkip} style={styles.skipButton}>
                            건너뛰기
                        </button>
                        <button
                            type="button"
                            disabled={!canConfirm}
                            onClick={submit}
                            style={{ ...styles.confirmButton, opacity: canConfirm ? 1 : 0.42 }}
                        >
                            상세 기록 시작
                        </button>
                    </div>
                </footer>
            </section>
        </div>
    );
}

const DetailedSetupSheet = ({
    open = false,
    seats = [],
    bigBlind = 1,
    onConfirm = () => {},
    onSkip = () => {},
    onClose = () => {},
}) => {
    if (!open) return null;
    const safeSeats = Array.isArray(seats) ? seats : [];

    return (
        <SetupPanel
            seats={safeSeats}
            bigBlind={bigBlind}
            onConfirm={onConfirm}
            onSkip={onSkip}
            onClose={onClose}
        />
    );
};

const styles = {
    overlay: {
        position: 'fixed',
        inset: 0,
        zIndex: 1250,
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
        paddingTop: 'env(safe-area-inset-top)',
        background: 'rgba(2, 6, 23, 0.76)',
    },
    sheet: {
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        maxWidth: '640px',
        maxHeight: '94dvh',
        boxSizing: 'border-box',
        borderRadius: '22px 22px 0 0',
        background: '#111827',
        color: '#f8fafc',
        boxShadow: '0 -18px 48px rgba(0, 0, 0, 0.48)',
        overflow: 'hidden',
    },
    grabber: { flexShrink: 0, width: '42px', height: '4px', margin: '10px auto 2px', borderRadius: '999px', background: '#475569' },
    header: { display: 'flex', flexShrink: 0, alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', padding: '10px 16px 12px' },
    eyebrow: { color: '#38bdf8', fontSize: '0.66rem', fontWeight: 900, letterSpacing: '0.12em' },
    title: { margin: '3px 0 0', fontSize: '1.18rem' },
    subtitle: { margin: '5px 0 0', color: '#94a3b8', fontSize: '0.77rem', lineHeight: 1.45 },
    closeButton: {
        minWidth: '44px', minHeight: '44px', padding: 0, border: 0, borderRadius: '12px',
        background: '#1e293b', color: '#e2e8f0', fontSize: '1.55rem', cursor: 'pointer',
    },
    scrollArea: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 12px 14px' },
    emptyState: { margin: '20px 0', padding: '24px', border: '1px solid #334155', borderRadius: '14px', color: '#94a3b8', textAlign: 'center' },
    section: { marginTop: '8px' },
    sectionTitle: { color: '#e2e8f0', fontSize: '0.85rem', fontWeight: 900 },
    sectionHint: { marginTop: '3px', color: '#94a3b8', fontSize: '0.72rem' },
    sectionHeadingRow: { display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'flex-start' },
    heroGrid: { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '7px', marginTop: '9px' },
    heroButton: {
        display: 'flex', flexDirection: 'column', justifyContent: 'center', minWidth: 0, minHeight: '50px',
        padding: '6px 7px', border: '1px solid #334155', borderRadius: '10px', background: '#1e293b',
        color: '#cbd5e1', textAlign: 'left', cursor: 'pointer',
    },
    heroButtonActive: { border: '1px solid #38bdf8', background: '#075985', color: '#fff', boxShadow: '0 0 0 1px rgba(56, 189, 248, 0.25)' },
    heroPosition: { color: 'inherit', opacity: 0.78, fontSize: '0.63rem', fontWeight: 900 },
    heroName: { width: '100%', marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '0.76rem', fontWeight: 900 },
    bulkActions: { display: 'grid', gridTemplateColumns: '1fr 1.2fr', gap: '8px', marginTop: '9px' },
    bulkSecondary: {
        minHeight: '44px', padding: '7px', border: '1px solid #475569', borderRadius: '10px',
        background: '#1e293b', color: '#e2e8f0', fontWeight: 800, cursor: 'pointer',
    },
    bulkPrimary: {
        minHeight: '44px', padding: '7px', border: '1px solid #0ea5e9', borderRadius: '10px',
        background: '#0c4a6e', color: '#f0f9ff', fontWeight: 900, cursor: 'pointer',
    },
    seatList: { display: 'grid', gap: '8px', marginTop: '9px' },
    seatCard: { padding: '10px', border: '1px solid #273449', borderRadius: '12px', background: '#0f172a' },
    seatHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' },
    seatIdentity: { display: 'flex', minWidth: 0, alignItems: 'center', gap: '6px' },
    positionBadge: { flexShrink: 0, padding: '3px 5px', borderRadius: '6px', background: '#334155', color: '#cbd5e1', fontSize: '0.62rem', fontWeight: 900 },
    seatName: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '0.8rem' },
    heroBadge: { flexShrink: 0, padding: '2px 5px', borderRadius: '999px', background: '#075985', color: '#bae6fd', fontSize: '0.58rem', fontWeight: 900 },
    stackPreview: { flexShrink: 0, color: '#94a3b8', fontSize: '0.69rem', fontWeight: 800 },
    presetRow: { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr)) minmax(68px, 1.35fr)', gap: '5px', marginTop: '9px' },
    presetButton: {
        minHeight: '42px', padding: '4px 2px', border: '1px solid #334155', borderRadius: '8px',
        background: '#1e293b', color: '#e2e8f0', fontSize: '0.75rem', fontWeight: 900, cursor: 'pointer',
    },
    presetButtonActive: { border: '1px solid #38bdf8', background: '#0c4a6e', color: '#fff' },
    bbUnit: { marginLeft: '1px', fontSize: '0.52rem', opacity: 0.72 },
    customInputWrap: {
        display: 'flex', alignItems: 'center', minWidth: 0, minHeight: '42px', boxSizing: 'border-box',
        border: '1px solid #334155', borderRadius: '8px', background: '#020617', overflow: 'hidden',
    },
    customInput: {
        width: '100%', minWidth: 0, height: '40px', boxSizing: 'border-box', padding: '6px', border: 0,
        outline: 'none', background: 'transparent', color: '#f8fafc', fontSize: '0.76rem', fontWeight: 900,
    },
    inputUnit: { paddingRight: '5px', color: '#64748b', fontSize: '0.55rem', fontWeight: 900 },
    precisionRow: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '5px', marginTop: '7px' },
    precisionButton: {
        minHeight: '36px', padding: '4px', border: '1px solid #273449', borderRadius: '8px',
        background: '#172033', color: '#94a3b8', fontSize: '0.68rem', fontWeight: 800, cursor: 'pointer',
    },
    precisionButtonActive: { border: '1px solid #38bdf8', background: '#075985', color: '#fff' },
    validationMessage: { marginTop: '6px', color: '#fbbf24', fontSize: '0.67rem', lineHeight: 1.4 },
    footer: {
        flexShrink: 0, padding: '9px 12px calc(11px + env(safe-area-inset-bottom))',
        borderTop: '1px solid #273449', background: '#111827', boxShadow: '0 -8px 22px rgba(0, 0, 0, 0.25)',
    },
    footerHint: { minHeight: '18px', marginBottom: '6px', color: '#94a3b8', fontSize: '0.68rem', textAlign: 'center' },
    footerActions: { display: 'grid', gridTemplateColumns: '0.8fr 1.6fr', gap: '8px' },
    skipButton: {
        minHeight: '48px', border: '1px solid #475569', borderRadius: '11px', background: '#1e293b',
        color: '#cbd5e1', fontWeight: 800, cursor: 'pointer',
    },
    confirmButton: {
        minHeight: '48px', border: 0, borderRadius: '11px', background: '#0284c7', color: '#fff',
        fontWeight: 900, cursor: 'pointer',
    },
    visuallyHidden: {
        position: 'absolute', width: '1px', height: '1px', padding: 0, margin: '-1px', overflow: 'hidden',
        clip: 'rect(0, 0, 0, 0)', whiteSpace: 'nowrap', border: 0,
    },
};

export default DetailedSetupSheet;
