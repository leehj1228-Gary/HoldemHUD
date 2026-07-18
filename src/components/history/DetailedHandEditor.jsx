// 아카이브된 상세 핸드의 카드/승자 사후 편집기 (히스토리 화면).
// 원장(액션)은 건드리지 않는다 — 카드(hero/공개/보드)와 승자만 수정하며, 모든 변경은
// 엔진(setDetailedCards/completeDetailedHand) 게이트를 draft 단계와 저장(리듀서) 단계에서
// 두 번 통과한다. 저장 payload는 gameReducer.applyArchivedHandPatch 입력형과 동일.
import { useState } from 'react';
import CardPicker from '../game/CardPicker';
import {
    undoDetailedStep,
    deriveDetailedState,
    deriveSidePots,
    setDetailedCards,
} from '../../engine/detailedHandEngine.js';
import { determineShowdownWinners } from '../../engine/handEvaluator.js';

const STREET_LABEL = { flop: 'Flop', turn: 'Turn', river: 'River' };

function formatCards(cards) {
    if (!Array.isArray(cards) || cards.length === 0) return '—';
    return cards.join(' ');
}

const DetailedHandEditor = ({ hand, onSave, onClose }) => {
    // 완료된 핸드는 draft에서 완료를 풀어 카드 수정이 가능하게 한다 (저장 시 재완료)
    const [draft, setDraft] = useState(() => (hand.detailed.completed ? undoDetailedStep(hand) : hand));
    const [picker, setPicker] = useState(null);
    const [manualMode, setManualMode] = useState(false);
    const [manualPotWinners, setManualPotWinners] = useState({});

    const meta = draft.detailed;
    const state = deriveDetailedState(draft);
    const side = deriveSidePots(draft);
    const auto = determineShowdownWinners(draft);
    const wasCompleted = hand.detailed.completed === true;
    const players = state.players.filter(player => player.active);
    const livePlayers = players.filter(player => !player.folded);

    const seatName = (seat) => hand.seats?.find(s => s.seat === seat)?.name || `Seat ${Number(seat) + 1}`;
    const cardsOf = (seat) => (seat === meta.heroSeat
        ? meta.heroCards
        : (meta.reveals.find(reveal => reveal.seat === seat)?.cards || []));
    const allKnownCards = () => [
        ...meta.board.flop, ...meta.board.turn, ...meta.board.river,
        ...meta.heroCards, ...meta.reveals.flatMap(reveal => reveal.cards),
    ];

    const applyCards = (payload) => {
        const next = setDetailedCards(draft, payload);
        if (next === draft) {
            window.alert('카드가 적용되지 않았습니다 — 중복 카드가 아닌지 확인하세요');
            return;
        }
        setDraft(next);
    };

    const handlePickerConfirm = (result) => {
        if (!picker) return;
        const cards = result.quality === 'unknown' ? [] : result.cards;
        if (picker.kind === 'board') {
            applyCards({ street: picker.street, cards });
        } else if (picker.seat === meta.heroSeat) {
            applyCards({ heroSeat: meta.heroSeat, heroCards: cards });
        } else {
            const reveals = meta.reveals.filter(reveal => reveal.seat !== picker.seat);
            if (cards.length === 2) reveals.push({ seat: picker.seat, cards });
            applyCards({ reveals });
        }
        setPicker(null);
    };

    const openPicker = (config) => {
        const value = config.kind === 'board' ? meta.board[config.street] : cardsOf(config.seat);
        setPicker({
            ...config,
            value,
            usedCards: allKnownCards().filter(card => !value.includes(card)),
        });
    };

    // 승자: 자동 판정 우선, 수동 모드에서는 (병합된) 팟별 좌석 선택
    const manualWinners = side.pots.flatMap(pot => (manualPotWinners[pot.index] || [])
        .filter(seat => pot.eligibleSeats.includes(seat))
        .map(seat => ({ seat, potIndex: pot.index })));
    const manualComplete = side.pots.length > 0
        && side.pots.every(pot => (manualPotWinners[pot.index] || [])
            .some(seat => pot.eligibleSeats.includes(seat)));
    const winners = manualMode
        ? (manualComplete ? manualWinners : null)
        : (auto?.winners ?? null);
    const winnersNeeded = wasCompleted || manualMode;
    const canSave = !winnersNeeded || !!winners;

    const handleSave = () => {
        const payload = {
            cards: {
                heroSeat: meta.heroSeat,
                heroCards: meta.heroCards,
                reveals: meta.reveals,
                board: meta.board,
            },
            ...(winners ? { winners } : null),
        };
        if (onSave(payload) === false) {
            window.alert('저장 실패 — 수정 내용이 엔진 검증을 통과하지 못했습니다');
            return;
        }
        onClose();
    };

    const toggleManualWinner = (potIndex, seat) => setManualPotWinners(current => {
        const selected = current[potIndex] || [];
        return {
            ...current,
            [potIndex]: selected.includes(seat)
                ? selected.filter(x => x !== seat)
                : [...selected, seat],
        };
    });

    return (
        <div style={styles.overlay}>
            <div style={styles.sheet}>
                <header style={styles.header}>
                    <div>
                        <div style={styles.eyebrow}>HAND #{hand.handNo} 수정</div>
                        <h3 style={styles.title}>카드 · 승자 수정</h3>
                        <p style={styles.hint}>액션 원장은 바뀌지 않습니다. 카드와 승자만 다시 확정합니다.</p>
                    </div>
                    <button type="button" onClick={onClose} style={styles.ghostButton}>닫기</button>
                </header>

                <section style={styles.section}>
                    <div style={styles.sectionTitle}>보드</div>
                    {['flop', 'turn', 'river'].map(street => (
                        <div key={street} style={styles.row}>
                            <span style={styles.rowLabel}>{STREET_LABEL[street]}</span>
                            <span style={styles.rowValue}>{formatCards(meta.board[street])}</span>
                            <button
                                type="button"
                                style={styles.smallButton}
                                onClick={() => openPicker({
                                    kind: 'board',
                                    street,
                                    title: `${STREET_LABEL[street]} 보드`,
                                    count: street === 'flop' ? 3 : 1,
                                })}
                            >
                                수정
                            </button>
                        </div>
                    ))}
                </section>

                <section style={styles.section}>
                    <div style={styles.sectionTitle}>좌석 카드</div>
                    {players.map(player => (
                        <div key={player.seat} style={styles.row}>
                            <span style={styles.rowLabel}>
                                {seatName(player.seat)}
                                {player.seat === meta.heroSeat ? ' · HERO' : ''}
                                {player.folded ? ' · 폴드' : ''}
                            </span>
                            <span style={styles.rowValue}>
                                {formatCards(cardsOf(player.seat))}
                                {auto?.evaluations?.[player.seat] ? ` · ${auto.evaluations[player.seat].label}` : ''}
                            </span>
                            <button
                                type="button"
                                style={styles.smallButton}
                                onClick={() => openPicker({
                                    kind: 'seat',
                                    seat: player.seat,
                                    title: `${seatName(player.seat)} 카드`,
                                    count: 2,
                                })}
                            >
                                수정
                            </button>
                        </div>
                    ))}
                </section>

                <section style={styles.section}>
                    <div style={styles.winnerHeader}>
                        <div style={styles.sectionTitle}>승자</div>
                        {livePlayers.length > 1 && (
                            <button
                                type="button"
                                style={styles.ghostButton}
                                onClick={() => setManualMode(current => !current)}
                            >
                                {manualMode ? '자동 판정 사용' : '직접 선택'}
                            </button>
                        )}
                    </div>
                    {!manualMode && auto && auto.pots.map(pot => (
                        <div key={pot.index} style={styles.autoRow}>
                            {pot.type === 'main' ? 'Main pot' : `Side pot ${pot.index}`} · {pot.amount.toLocaleString()}
                            {' → 🏆 '}
                            {pot.winnerSeats.map(seatName).join(', ')}
                            {pot.winnerSeats.length > 1 ? ' · 스플릿' : ''}
                            {auto.evaluations[pot.winnerSeats[0]] ? ` — ${auto.evaluations[pot.winnerSeats[0]].label}` : ''}
                        </div>
                    ))}
                    {!manualMode && !auto && (
                        <p style={styles.hint}>
                            보드 5장과 생존자 카드가 모두 입력되면 승자가 자동 판정됩니다.
                            {wasCompleted ? ' 지금 저장하면 기존 승자가 유지됩니다.' : ''}
                        </p>
                    )}
                    {manualMode && side.pots.map(pot => (
                        <div key={pot.index} style={styles.manualPot}>
                            <div style={styles.rowLabel}>
                                {pot.type === 'main' ? 'Main pot' : `Side pot ${pot.index}`} · {pot.amount.toLocaleString()}
                            </div>
                            <div style={styles.winnerGrid}>
                                {livePlayers.filter(player => pot.eligibleSeats.includes(player.seat)).map(player => {
                                    const selected = (manualPotWinners[pot.index] || []).includes(player.seat);
                                    return (
                                        <button
                                            type="button"
                                            key={player.seat}
                                            aria-pressed={selected}
                                            onClick={() => toggleManualWinner(pot.index, player.seat)}
                                            style={{
                                                ...styles.winnerButton,
                                                ...(selected ? styles.winnerButtonSelected : null),
                                            }}
                                        >
                                            {seatName(player.seat)}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    ))}
                </section>

                <footer style={styles.footer}>
                    <button type="button" onClick={onClose} style={styles.secondaryButton}>취소</button>
                    <button
                        type="button"
                        disabled={!canSave}
                        onClick={handleSave}
                        style={{ ...styles.primaryButton, opacity: canSave ? 1 : 0.45 }}
                    >
                        저장
                    </button>
                </footer>
            </div>

            {picker && (
                <CardPicker
                    open
                    title={picker.title}
                    count={picker.count}
                    value={picker.value}
                    usedCards={picker.usedCards}
                    qualityOptions={['exact', 'unknown']}
                    onConfirm={handlePickerConfirm}
                    onClose={() => setPicker(null)}
                />
            )}
        </div>
    );
};

const styles = {
    overlay: {
        position: 'fixed', inset: 0, zIndex: 60, display: 'grid', placeItems: 'center',
        padding: '16px', background: 'rgba(2, 6, 23, 0.72)',
    },
    sheet: {
        width: '100%', maxWidth: '560px', maxHeight: '86vh', overflowY: 'auto', boxSizing: 'border-box',
        padding: '16px', border: '1px solid #334155', borderRadius: '16px',
        background: '#0f172a', color: '#f8fafc',
    },
    header: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '10px' },
    eyebrow: { color: '#38bdf8', fontSize: '0.66rem', fontWeight: 900, letterSpacing: '0.1em' },
    title: { margin: '3px 0 0', fontSize: '1.05rem' },
    hint: { margin: '5px 0 0', color: '#94a3b8', fontSize: '0.75rem', lineHeight: 1.45 },
    section: {
        marginTop: '12px', padding: '11px', border: '1px solid #1e293b',
        borderRadius: '12px', background: '#111827', display: 'grid', gap: '8px',
    },
    sectionTitle: { color: '#cbd5e1', fontSize: '0.76rem', fontWeight: 900 },
    row: { display: 'grid', gridTemplateColumns: 'minmax(90px, auto) 1fr auto', alignItems: 'center', gap: '8px' },
    rowLabel: { color: '#cbd5e1', fontSize: '0.76rem', fontWeight: 800 },
    rowValue: { color: '#f8fafc', fontSize: '0.82rem', fontWeight: 800 },
    smallButton: {
        minHeight: '38px', padding: '6px 10px', border: '1px solid #475569', borderRadius: '9px',
        background: '#1e293b', color: '#e2e8f0', fontSize: '0.72rem', fontWeight: 800, cursor: 'pointer',
    },
    ghostButton: {
        minHeight: '36px', padding: '6px 10px', border: '1px solid #475569', borderRadius: '9px',
        background: 'transparent', color: '#94a3b8', fontSize: '0.72rem', fontWeight: 800, cursor: 'pointer',
    },
    winnerHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' },
    autoRow: {
        padding: '9px 10px', border: '1px solid #14532d', borderRadius: '10px',
        background: 'rgba(20, 83, 45, 0.25)', color: '#bbf7d0', fontSize: '0.8rem', fontWeight: 800,
    },
    manualPot: { display: 'grid', gap: '6px', padding: '8px', border: '1px solid #334155', borderRadius: '10px' },
    winnerGrid: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '7px' },
    winnerButton: {
        minHeight: '40px', padding: '7px', border: '1px solid #475569', borderRadius: '10px',
        background: '#1e293b', color: '#cbd5e1', fontWeight: 800, cursor: 'pointer',
    },
    winnerButtonSelected: { border: '1px solid #22c55e', background: '#14532d', color: '#f0fdf4' },
    footer: { display: 'grid', gridTemplateColumns: '1fr 1.4fr', gap: '8px', marginTop: '14px' },
    primaryButton: {
        minHeight: '46px', padding: '9px 12px', border: 0, borderRadius: '11px',
        background: '#7c3aed', color: '#fff', fontWeight: 900, cursor: 'pointer',
    },
    secondaryButton: {
        minHeight: '46px', padding: '9px 12px', border: '1px solid #475569', borderRadius: '11px',
        background: '#1e293b', color: '#e2e8f0', fontWeight: 800, cursor: 'pointer',
    },
};

export default DetailedHandEditor;
