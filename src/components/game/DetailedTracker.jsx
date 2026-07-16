import { useState } from 'react';
import BetSizeSheet from './BetSizeSheet';
import CardPicker from './CardPicker';
import {
    DETAILED_STREETS as STREETS,
    DETAILED_ACTION_TYPES,
    CARD_RANKS,
    CARD_SUITS,
} from '../../engine/schema.js';

const STREET_META = {
    preflop: { label: 'Preflop', cardCount: 0 },
    flop: { label: 'Flop', cardCount: 3 },
    turn: { label: 'Turn', cardCount: 1 },
    river: { label: 'River', cardCount: 1 },
};
const BOARD_STREETS = ['flop', 'turn', 'river'];
const ACTION_ORDER = [...DETAILED_ACTION_TYPES, 'all-in'];
const ACTION_LABELS = {
    fold: 'Fold',
    check: 'Check',
    call: 'Call',
    bet: 'Bet',
    raise: 'Raise',
    'all-in': 'All-in',
};
const ACTION_COLORS = {
    fold: '#475569',
    check: '#334155',
    call: '#0369a1',
    bet: '#7c3aed',
    raise: '#c2410c',
    'all-in': '#be123c',
};
const SUIT_INFO = {
    s: { symbol: '♠', color: '#e5e7eb' },
    h: { symbol: '♥', color: '#fb7185' },
    d: { symbol: '♦', color: '#60a5fa' },
    c: { symbol: '♣', color: '#4ade80' },
};

function normalizeStreet(street) {
    const value = String(street || 'preflop').toLowerCase();
    return STREETS.includes(value) ? value : 'preflop';
}

function normalizeActionType(action) {
    const raw = typeof action === 'object' ? action.type : action;
    const value = String(raw || '').toLowerCase().replace(/[\s_]/g, '-');
    if (value === 'allin') return 'all-in';
    return value;
}

function numberOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function formatAmount(value) {
    const number = numberOrNull(value);
    if (number === null) return '—';
    return new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 }).format(number);
}

// 관대한 입력 파싱(수트 단어·기호, '10' 표기)은 유지하되,
// 최종 어휘는 schema.js의 CARD_RANKS/CARD_SUITS로만 판정한다.
function normalizeSuit(suit) {
    const value = String(suit || '').toLowerCase();
    if (value === '♠' || value.startsWith('spade')) return 's';
    if (value === '♥' || value.startsWith('heart')) return 'h';
    if (value === '♦' || value.startsWith('diamond')) return 'd';
    if (value === '♣' || value.startsWith('club')) return 'c';
    return value.charAt(0);
}

function normalizeCard(card) {
    if (!card) return '';
    let rank = '';
    let suit = '';
    if (typeof card === 'object') {
        rank = String(card.rank || '').toUpperCase().replace('10', 'T');
        suit = normalizeSuit(card.suit);
    } else {
        const raw = String(card).trim().replace('10', 'T');
        if (raw.length < 2) return '';
        rank = raw.slice(0, -1).toUpperCase();
        suit = normalizeSuit(raw.slice(-1));
    }
    return CARD_RANKS.has(rank) && CARD_SUITS.has(suit) ? `${rank}${suit}` : '';
}

function normalizeCards(cards) {
    return (Array.isArray(cards) ? cards : []).map(normalizeCard).filter(Boolean);
}

function cardDisplay(card) {
    const normalized = normalizeCard(card);
    const rank = normalized.slice(0, -1);
    const suit = SUIT_INFO[normalized.slice(-1)];
    return {
        text: `${rank}${suit ? suit.symbol : ''}`,
        color: suit ? suit.color : '#e5e7eb',
    };
}

function streetRecord(hand, street) {
    const streets = hand?.streets;
    if (Array.isArray(streets)) {
        return streets.find(item => normalizeStreet(item?.street || item?.name || item?.type) === street) || null;
    }
    return streets && typeof streets === 'object' ? streets[street] || null : null;
}

function flatBoard(hand) {
    const detailedBoard = hand?.detailed?.board;
    if (detailedBoard && typeof detailedBoard === 'object') {
        return normalizeCards([
            ...(detailedBoard.flop || []),
            ...(detailedBoard.turn || []),
            ...(detailedBoard.river || []),
        ]);
    }
    return normalizeCards(hand?.board || hand?.cards?.board || []);
}

function cardsForStreet(hand, street) {
    if (street === 'preflop') return [];
    const detailedCards = hand?.detailed?.board?.[street];
    if (Array.isArray(detailedCards)) return normalizeCards(detailedCards);
    const direct = streetRecord(hand, street)?.cards;
    if (Array.isArray(direct)) return normalizeCards(direct);

    const board = flatBoard(hand);
    if (street === 'flop') return board.slice(0, 3);
    if (street === 'turn') return board.slice(3, 4);
    return board.slice(4, 5);
}

function allBoardCards(hand) {
    const direct = flatBoard(hand);
    if (direct.length > 0) return direct;
    return BOARD_STREETS.flatMap(street => cardsForStreet(hand, street));
}

function cardsForPlayer(hand, player) {
    const seat = player?.seat;
    const detailedReveal = Array.isArray(hand?.detailed?.reveals)
        ? hand.detailed.reveals.find(reveal => String(reveal?.seat) === String(seat))
        : null;
    const showdown = hand?.showdownCards;
    const nestedShowdown = hand?.cards?.showdown;
    const cards = detailedReveal?.cards
        || player?.cards
        || (showdown && (showdown[seat] || showdown[String(seat)]))
        || (nestedShowdown && (nestedShowdown[seat] || nestedShowdown[String(seat)]))
        || [];
    return normalizeCards(cards);
}

function heroCardsFromHand(hand, heroPlayer) {
    return normalizeCards(
        hand?.detailed?.heroCards
        || hand?.heroCards
        || hand?.cards?.hero
        || heroPlayer?.heroCards
        || heroPlayer?.cards
        || []);
}

function allActions(hand) {
    if (Array.isArray(hand?.actions)) return hand.actions;
    return STREETS.flatMap(street => {
        const actions = streetRecord(hand, street)?.actions;
        return Array.isArray(actions) ? actions.map(action => ({ ...action, street })) : [];
    });
}

function qualityText(quality) {
    if (quality === 'exact') return '정확';
    if (quality === 'approximate' || quality === 'estimated') return '대략';
    return '모름';
}

function playerStackInfo(player) {
    const quality = player?.stackQuality || player?.stackPrecision || player?.startingStackPrecision;
    const chips = numberOrNull(player?.stackAmount ?? player?.chips);
    if (chips !== null) return { amount: chips, unit: 'chips', quality: quality || 'exact' };
    const bb = numberOrNull(player?.stackBB);
    if (bb !== null) return { amount: bb, unit: 'bb', quality: quality || 'approximate' };
    const generic = numberOrNull(player?.stack);
    if (generic !== null) return {
        amount: generic,
        unit: player?.stackUnit || 'chips',
        quality: quality || (player?.stackUnit === 'bb' ? 'approximate' : 'exact'),
    };
    return { amount: null, unit: 'chips', quality: 'unknown' };
}

function CardSlots({ cards, count }) {
    return (
        <div style={styles.cardSlots}>
            {Array.from({ length: count }, (_, index) => {
                const card = cards[index];
                const display = cardDisplay(card);
                return (
                    <span
                        key={index}
                        aria-label={card ? display.text : '카드 미입력'}
                        style={{
                            ...styles.miniCard,
                            color: display.color,
                            ...(card ? styles.miniCardFilled : null),
                        }}
                    >
                        {card ? display.text : '—'}
                    </span>
                );
            })}
        </div>
    );
}

// 엔진이 액션을 거부(no-op)했을 때 조용히 사라지지 않도록 알린다 (onAction이 false 반환 시)
const notifyRejectedAction = () => {
    window.alert('액션이 기록되지 않았습니다 — 금액이 규칙에 맞는지 확인하세요');
};

const DetailedTracker = ({
    hand,
    derived = {},
    canDisableDetail = true,
    onAction = () => {},
    onAdvanceStreet = () => {},
    onSetCards = () => {},
    onComplete = () => {},
    onDisableDetail = () => {},
}) => {
    const [cardPicker, setCardPicker] = useState(null);
    const [sizeSheet, setSizeSheet] = useState(null);
    const [winnerSelection, setWinnerSelection] = useState({
        revision: null,
        winnerSeats: [],
        potWinnerSeats: {},
    });
    const eligibilityRevision = JSON.stringify((derived?.players || []).map(player => [
        player?.seat, player?.active, player?.sittingOut, player?.folded,
    ]));
    const potRevision = JSON.stringify((derived?.sidePotState?.pots || []).map(pot => [
        pot?.index, pot?.amount, pot?.eligibleSeats,
    ]));
    const cardRevision = JSON.stringify({
        heroSeat: hand?.detailed?.heroSeat ?? null,
        heroCards: hand?.detailed?.heroCards || [],
        board: hand?.detailed?.board || {},
        reveals: hand?.detailed?.reveals || [],
    });
    const selectionRevision = JSON.stringify([
        hand?.id,
        hand?.actions?.length,
        hand?.detailed?.street,
        hand?.detailed?.completed,
        eligibilityRevision,
        potRevision,
        cardRevision,
    ]);
    const winnerSeats = winnerSelection.revision === selectionRevision
        ? winnerSelection.winnerSeats
        : [];
    const potWinnerSeats = winnerSelection.revision === selectionRevision
        ? winnerSelection.potWinnerSeats
        : {};

    if (!hand) {
        return (
            <section style={styles.emptyState}>
                <strong>상세 기록할 핸드가 없습니다.</strong>
                <button type="button" onClick={onDisableDetail} style={styles.secondaryButton}>
                    간편 기록으로
                </button>
            </section>
        );
    }

    const street = normalizeStreet(derived.street || hand.street || hand.currentStreet);
    const streetIndex = STREETS.indexOf(street);
    const players = Array.isArray(derived.players)
        ? derived.players
        : Array.isArray(hand.players)
            ? hand.players
            : Array.isArray(hand.seats)
                ? hand.seats
                : [];
    const toActSeat = derived.toActSeat;
    const actor = players.find(player => String(player.seat) === String(toActSeat)) || null;
    const explicitHeroSeat = hand.detailed?.heroSeat ?? hand.heroSeat ?? hand.hero?.seat ?? hand.cards?.heroSeat;
    const inferredHero = players.find(player => player.isHero);
    const heroSeat = explicitHeroSeat ?? inferredHero?.seat ?? null;
    const heroPlayer = players.find(player => String(player.seat) === String(heroSeat)) || null;
    const heroCards = heroCardsFromHand(hand, heroPlayer);
    const boardCards = allBoardCards(hand);
    const actions = allActions(hand);
    const grossPot = derived.pot;
    const sidePotState = derived.sidePotState || {};
    const uncalledReturns = Array.isArray(sidePotState.uncalledReturns) ? sidePotState.uncalledReturns : [];
    const streetComplete = !!derived.streetComplete;
    const handComplete = !!derived.handComplete;
    const recordLocked = !!hand.detailed?.completed;
    const contestablePot = numberOrNull(sidePotState.total);
    const useContestablePot = (streetComplete || handComplete) && contestablePot !== null;
    const pot = useContestablePot ? contestablePot : grossPot;
    const potQuality = (useContestablePot ? sidePotState.quality : derived.potQuality) || 'unknown';
    const completionReady = handComplete || (street === 'river' && streetComplete);
    const nextStreet = streetIndex < STREETS.length - 1 ? STREETS[streetIndex + 1] : null;
    // 리듀서 가드(canDisableDetailedTracking)와 동일 판정을 컨텍스트에서 받아 무시되는 클릭을 없앤다
    const disableDetailTitle = canDisableDetail
        ? undefined
        : '완료됐거나 플랍 기록이 시작된 상세 핸드는 간편 기록으로 되돌릴 수 없습니다';

    const legalActions = Array.isArray(derived.legalActions)
        ? [...new Set(derived.legalActions.map(normalizeActionType).filter(type => ACTION_ORDER.includes(type)))]
        : (numberOrNull(derived.toCall) > 0
            ? ['fold', 'call', 'raise', 'all-in']
            : street === 'preflop'
                ? ['fold', 'call', 'raise', 'all-in']
                : ['check', 'bet', 'all-in']);
    const orderedLegalActions = ACTION_ORDER.filter(type => legalActions.includes(type));
    const eligibleWinners = players.filter(player => player.active !== false && !player.sittingOut && !player.folded);
    const eligibleWinnerSeats = new Set(eligibleWinners.map(player => player.seat));
    const winnerSelectionRequired = completionReady && !recordLocked && eligibleWinners.length > 1;
    const sidePots = Array.isArray(sidePotState.pots) ? sidePotState.pots : [];
    const hasPotSpecificWinners = winnerSelectionRequired && sidePots.length > 0;
    const validWinnerSeats = winnerSeats.filter(seat => eligibleWinnerSeats.has(seat));
    const validPotWinnerSeats = Object.fromEntries(sidePots.map(pot => [
        pot.index,
        (potWinnerSeats[pot.index] || []).filter(seat => pot.eligibleSeats.includes(seat)),
    ]));
    const winnerSelectionComplete = !winnerSelectionRequired || (hasPotSpecificWinners
        ? sidePots.every(pot => validPotWinnerSeats[pot.index]?.length > 0)
        : validWinnerSeats.length > 0);
    const completionWinners = hasPotSpecificWinners
        ? sidePots.flatMap(pot => (validPotWinnerSeats[pot.index] || [])
            .map(seat => ({ seat, potIndex: pot.index })))
        : validWinnerSeats.map(seat => ({ seat, potIndex: null }));

    const knownCardsExcept = ({ target, targetStreet, targetSeat }) => {
        const cards = [];
        BOARD_STREETS.forEach(boardStreet => {
            if (!(target === 'board' && boardStreet === targetStreet)) {
                cards.push(...cardsForStreet(hand, boardStreet));
            }
        });
        if (target !== 'heroCards') cards.push(...heroCards);
        players.forEach(player => {
            if (!(target === 'showdownCards' && String(player.seat) === String(targetSeat))) {
                if (String(player.seat) !== String(heroSeat)) cards.push(...cardsForPlayer(hand, player));
            }
        });
        return cards;
    };

    const openBoardPicker = (targetStreet) => {
        setCardPicker({
            target: 'board',
            street: targetStreet,
            title: `${STREET_META[targetStreet].label} 보드`,
            count: STREET_META[targetStreet].cardCount,
            value: cardsForStreet(hand, targetStreet),
            usedCards: knownCardsExcept({ target: 'board', targetStreet }),
            qualityOptions: ['exact', 'unknown'],
        });
    };

    const openHeroPicker = () => {
        if (heroSeat === null || heroSeat === undefined) return;
        setCardPicker({
            target: 'heroCards',
            seat: heroSeat,
            title: `${heroPlayer?.name || 'Hero'} 카드`,
            count: 2,
            value: heroCards,
            usedCards: knownCardsExcept({ target: 'heroCards' }),
            qualityOptions: ['exact', 'unknown'],
        });
    };

    const openShowdownPicker = (player) => {
        setCardPicker({
            target: 'showdownCards',
            seat: player.seat,
            title: `${player.name || `Seat ${Number(player.seat) + 1}`} 공개 카드`,
            count: 2,
            value: cardsForPlayer(hand, player),
            usedCards: knownCardsExcept({ target: 'showdownCards', targetSeat: player.seat }),
            qualityOptions: ['exact', 'unknown'],
        });
    };

    const openAdvancePicker = () => {
        if (!nextStreet) return;
        setCardPicker({
            target: 'advanceStreet',
            street: nextStreet,
            title: `${STREET_META[nextStreet].label} 카드`,
            count: STREET_META[nextStreet].cardCount,
            value: [],
            usedCards: [...boardCards, ...heroCards, ...players.flatMap(player => cardsForPlayer(hand, player))],
            qualityOptions: ['exact', 'unknown'],
        });
    };

    const handleCardConfirm = (result) => {
        if (!cardPicker) return;
        const cards = result.quality === 'unknown' ? [] : result.cards;
        if (cardPicker.target === 'advanceStreet') {
            onAdvanceStreet(cards);
        } else {
            onSetCards({
                target: cardPicker.target,
                street: cardPicker.street,
                seat: cardPicker.seat,
                cards,
                quality: result.quality,
            });
        }
        setCardPicker(null);
    };

    const handleAction = (type) => {
        if (toActSeat === null || toActSeat === undefined) return;
        if (type === 'bet' || type === 'raise') {
            setSizeSheet({ seat: toActSeat, type });
            return;
        }

        if (type === 'call') {
            const amount = numberOrNull(derived.toCall);
            const amountQuality = amount === null
                ? 'unknown'
                : (derived.toCallQuality || 'exact');
            if (onAction(toActSeat, type, {
                street,
                amount,
                amountUnit: 'chips',
                amountQuality,
            }) === false) notifyRejectedAction();
            return;
        }

        if (type === 'all-in') {
            const stack = playerStackInfo(actor);
            if (stack.amount === null) {
                setSizeSheet({ seat: toActSeat, type: 'all-in' });
                return;
            }
            if (onAction(toActSeat, type, {
                street,
                amount: stack.amount,
                amountUnit: stack.unit,
                amountQuality: stack.quality,
                isAllIn: true,
            }) === false) notifyRejectedAction();
            return;
        }

        if (onAction(toActSeat, type, { street }) === false) notifyRejectedAction();
    };

    const actorStack = playerStackInfo(actor);
    const actorAllInTo = actorStack.unit === 'chips' && actorStack.amount !== null
        ? actorStack.amount + (numberOrNull(actor?.streetCommitted) || 0)
        : null;
    const actionLabel = (type) => {
        if (type === 'call') {
            const callAmount = numberOrNull(derived.toCall);
            return callAmount === null ? 'Call' : `Call ${formatAmount(callAmount)}`;
        }
        return ACTION_LABELS[type] || type;
    };

    return (
        <section style={styles.container} aria-label="상세 핸드 기록">
            <header style={styles.topBar}>
                <div>
                    <div style={styles.eyebrow}>DETAIL TRACKER</div>
                    <h2 style={styles.heading}>Hand #{hand.handNo ?? '—'}</h2>
                </div>
                <button
                    type="button"
                    onClick={onDisableDetail}
                    disabled={!canDisableDetail}
                    title={disableDetailTitle}
                    style={{ ...styles.compactButton, opacity: canDisableDetail ? 1 : 0.45 }}
                >
                    간편 기록
                </button>
            </header>

            <div style={styles.summaryRow}>
                <span>Pot <strong>{formatAmount(pot)}</strong></span>
                <span style={styles.qualityBadge}>{qualityText(potQuality)}</span>
                {numberOrNull(derived.toCall) !== null && Number(derived.toCall) > 0 && (
                    <span>Call <strong>{formatAmount(derived.toCall)}</strong></span>
                )}
            </div>

            <nav style={styles.timeline} aria-label="Street timeline">
                {STREETS.map((item, index) => {
                    const actionCount = actions.filter(action => normalizeStreet(action.street) === item).length;
                    const isCurrent = item === street;
                    const isPast = index < streetIndex;
                    const isDone = isPast || (isCurrent && streetComplete);
                    const isSkipped = handComplete && index > streetIndex;
                    return (
                        <div
                            key={item}
                            aria-current={isCurrent ? 'step' : undefined}
                            style={{
                                ...styles.timelineItem,
                                ...(isCurrent ? styles.timelineItemCurrent : null),
                                opacity: index > streetIndex ? 0.45 : 1,
                            }}
                        >
                            <span style={styles.timelineStatus}>{isSkipped ? '—' : isDone ? '✓' : isCurrent ? '•' : '○'}</span>
                            <span>{STREET_META[item].label}</span>
                            {actionCount > 0 && <small style={styles.actionCount}>{actionCount}</small>}
                        </div>
                    );
                })}
            </nav>

            <div style={styles.contentGrid}>
                <section style={styles.panel}>
                    <div style={styles.panelHeader}>
                        <div>
                            <h3 style={styles.panelTitle}>Hero & Cards</h3>
                            <p style={styles.panelHint}>좌석을 고르고 알려진 카드만 입력하세요.</p>
                        </div>
                    </div>

                    <label style={styles.fieldLabel}>
                        Hero 좌석
                        <select
                            value={heroSeat ?? ''}
                            disabled={recordLocked}
                            onChange={(event) => {
                                const player = players.find(item => String(item.seat) === event.target.value);
                                onSetCards({ target: 'heroSeat', seat: player ? player.seat : null });
                            }}
                            style={styles.select}
                        >
                            <option value="">선택 안 함</option>
                            {players.filter(player => player.active !== false && !player.sittingOut).map(player => (
                                <option key={player.seat} value={player.seat}>
                                    {player.position ? `${player.position} · ` : ''}{player.name || `Seat ${Number(player.seat) + 1}`}
                                </option>
                            ))}
                        </select>
                    </label>

                    <div style={styles.cardInputRow}>
                        <div>
                            <div style={styles.fieldLabelText}>Hero Cards</div>
                            <CardSlots cards={heroCards} count={2} />
                        </div>
                        <button
                            type="button"
                            onClick={openHeroPicker}
                            disabled={recordLocked || heroSeat === null || heroSeat === undefined}
                            style={{
                                ...styles.inputButton,
                                opacity: recordLocked || heroSeat === null || heroSeat === undefined ? 0.45 : 1,
                            }}
                        >
                            {heroCards.length ? '수정' : '입력'}
                        </button>
                    </div>
                </section>

                <section style={styles.panel}>
                    <div style={styles.panelHeader}>
                        <div>
                            <h3 style={styles.panelTitle}>Board</h3>
                            <p style={styles.panelHint}>놓친 카드는 모름으로 남겨도 됩니다.</p>
                        </div>
                    </div>

                    <div style={styles.boardList}>
                        {BOARD_STREETS.map(boardStreet => {
                            const cards = cardsForStreet(hand, boardStreet);
                            const boardIndex = STREETS.indexOf(boardStreet);
                            const canEdit = !recordLocked && (boardIndex <= streetIndex || cards.length > 0 || handComplete);
                            return (
                                <div key={boardStreet} style={styles.boardRow}>
                                    <span style={styles.boardLabel}>{STREET_META[boardStreet].label}</span>
                                    <CardSlots cards={cards} count={STREET_META[boardStreet].cardCount} />
                                    <button
                                        type="button"
                                        disabled={!canEdit}
                                        onClick={() => openBoardPicker(boardStreet)}
                                        style={{ ...styles.smallButton, opacity: canEdit ? 1 : 0.35 }}
                                    >
                                        {cards.length ? '수정' : '입력'}
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                </section>
            </div>

            {streetComplete && nextStreet && !handComplete && (
                <section style={styles.advancePanel}>
                    <div>
                        <strong>{STREET_META[street].label} 액션 완료</strong>
                        <div style={styles.panelHint}>{STREET_META[nextStreet].label} 카드를 받고 다음 street로 진행합니다.</div>
                    </div>
                    <div style={styles.advanceActions}>
                        <button type="button" onClick={openAdvancePicker} style={styles.primaryButton}>
                            {STREET_META[nextStreet].label} 카드 입력
                        </button>
                        <button type="button" onClick={() => onAdvanceStreet([])} style={styles.secondaryButton}>
                            카드 모름으로 진행
                        </button>
                    </div>
                </section>
            )}

            {completionReady && (
                <section style={styles.completePanel}>
                    <div>
                        <div style={styles.completeEyebrow}>HAND COMPLETE</div>
                        <h3 style={styles.completeTitle}>
                            {recordLocked ? '상세 기록이 완료되었습니다.' : '쇼다운 카드를 추가하거나 기록을 완료하세요.'}
                        </h3>
                        <div style={styles.completionSummary}>
                            <span>Board {boardCards.length}/5</span>
                            <span>Hero {heroCards.length}/2</span>
                            <span>실제 팟 {formatAmount(pot)} · {qualityText(potQuality)}</span>
                        </div>
                        {uncalledReturns.map(item => {
                            const player = players.find(candidate => candidate.seat === item.seat);
                            return (
                                <div key={`return-${item.seat}`} style={styles.returnNotice}>
                                    반환 · {player?.name || `Seat ${Number(item.seat) + 1}`} +{formatAmount(item.amount)}
                                </div>
                            );
                        })}
                    </div>

                    <div style={styles.showdownList}>
                        {players.filter(player => player.active !== false && !player.sittingOut && !player.folded
                            && String(player.seat) !== String(heroSeat)).map(player => {
                            const cards = cardsForPlayer(hand, player);
                            return (
                                <div key={player.seat} style={styles.showdownRow}>
                                    <span style={styles.showdownName}>{player.name || `Seat ${Number(player.seat) + 1}`}</span>
                                    <CardSlots cards={cards} count={2} />
                                    <button
                                        type="button"
                                        disabled={recordLocked}
                                        onClick={() => openShowdownPicker(player)}
                                        style={{ ...styles.smallButton, opacity: recordLocked ? 0.45 : 1 }}
                                    >
                                        {cards.length ? '수정' : '공개 카드'}
                                    </button>
                                </div>
                            );
                        })}
                    </div>

                    {winnerSelectionRequired && (
                        <div style={styles.winnerPanel}>
                            <div style={styles.fieldLabelText}>Winner (동률이면 여러 명 선택)</div>
                            {hasPotSpecificWinners ? sidePots.map(pot => (
                                <div key={pot.index} style={styles.potWinnerGroup}>
                                    <div style={styles.potWinnerTitle}>
                                        {pot.type === 'main' ? 'Main pot' : `Side pot ${pot.index}`} · {formatAmount(pot.amount)}
                                    </div>
                                    <div style={styles.winnerGrid}>
                                        {eligibleWinners.filter(player => pot.eligibleSeats.includes(player.seat)).map(player => {
                                            const selected = (validPotWinnerSeats[pot.index] || []).includes(player.seat);
                                            return (
                                                <button
                                                    type="button"
                                                    key={`${pot.index}-${player.seat}`}
                                                    aria-pressed={selected}
                                                    onClick={() => setWinnerSelection(current => {
                                                        const base = current.revision === selectionRevision
                                                            ? current
                                                            : { revision: selectionRevision, winnerSeats: [], potWinnerSeats: {} };
                                                        const selectedSeats = base.potWinnerSeats[pot.index] || [];
                                                        return {
                                                            ...base,
                                                            potWinnerSeats: {
                                                                ...base.potWinnerSeats,
                                                                [pot.index]: selectedSeats.includes(player.seat)
                                                                    ? selectedSeats.filter(seat => seat !== player.seat)
                                                                    : [...selectedSeats, player.seat],
                                                            },
                                                        };
                                                    })}
                                                    style={{
                                                        ...styles.winnerButton,
                                                        ...(selected ? styles.winnerButtonSelected : null),
                                                    }}
                                                >
                                                    {player.position ? `${player.position} · ` : ''}{player.name || `Seat ${Number(player.seat) + 1}`}
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                            )) : (
                                <div style={styles.winnerGrid}>
                                    {eligibleWinners.map(player => {
                                        const selected = validWinnerSeats.includes(player.seat);
                                        return (
                                            <button
                                                type="button"
                                                key={player.seat}
                                                aria-pressed={selected}
                                                onClick={() => setWinnerSelection(current => {
                                                    const base = current.revision === selectionRevision
                                                        ? current
                                                        : { revision: selectionRevision, winnerSeats: [], potWinnerSeats: {} };
                                                    return {
                                                        ...base,
                                                        winnerSeats: base.winnerSeats.includes(player.seat)
                                                            ? base.winnerSeats.filter(seat => seat !== player.seat)
                                                            : [...base.winnerSeats, player.seat],
                                                    };
                                                })}
                                                style={{
                                                    ...styles.winnerButton,
                                                    ...(selected ? styles.winnerButtonSelected : null),
                                                }}
                                            >
                                                {player.position ? `${player.position} · ` : ''}{player.name || `Seat ${Number(player.seat) + 1}`}
                                            </button>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    )}

                    {recordLocked ? (
                        <div style={styles.lockedNotice}>수정하려면 아래 ↩️ 버튼으로 완료를 되돌리세요.</div>
                    ) : <div style={styles.completeActions}>
                        <button
                            type="button"
                            disabled={!winnerSelectionComplete}
                            onClick={() => onComplete({ winners: completionWinners })}
                            style={{
                                ...styles.completeButton,
                                opacity: winnerSelectionComplete ? 1 : 0.45,
                            }}
                        >
                            상세 기록 완료
                        </button>
                        <button
                            type="button"
                            onClick={onDisableDetail}
                            disabled={!canDisableDetail}
                            title={disableDetailTitle}
                            style={{ ...styles.secondaryButton, opacity: canDisableDetail ? 1 : 0.45 }}
                        >
                            간편 기록으로
                        </button>
                    </div>}
                </section>
            )}

            {!completionReady && !streetComplete && toActSeat !== null && toActSeat !== undefined && (
                <div style={styles.stickyActionBar}>
                    <div style={styles.actorRow}>
                        <div>
                            <div style={styles.actorLabel}>현재 행동</div>
                            <strong style={styles.actorName}>
                                {actor?.position ? `${actor.position} · ` : ''}{actor?.name || `Seat ${Number(toActSeat) + 1}`}
                            </strong>
                        </div>
                        <div style={styles.actorMeta}>
                            Pot {formatAmount(pot)}
                            {numberOrNull(derived.currentBet) !== null ? ` · Bet ${formatAmount(derived.currentBet)}` : ''}
                        </div>
                    </div>

                    {orderedLegalActions.length > 0 ? (
                        <div style={{
                            ...styles.actionGrid,
                            gridTemplateColumns: `repeat(${Math.min(orderedLegalActions.length, 3)}, minmax(0, 1fr))`,
                        }}>
                            {orderedLegalActions.map(type => (
                                <button
                                    type="button"
                                    key={type}
                                    onClick={() => handleAction(type)}
                                    style={{
                                        ...styles.actionButton,
                                        background: ACTION_COLORS[type] || '#334155',
                                    }}
                                >
                                    {actionLabel(type)}
                                </button>
                            ))}
                        </div>
                    ) : (
                        <div style={styles.noActions}>진행 가능한 액션이 없습니다.</div>
                    )}
                </div>
            )}

            {cardPicker && (
                <CardPicker
                    open
                    title={cardPicker.title}
                    count={cardPicker.count}
                    value={cardPicker.value}
                    usedCards={cardPicker.usedCards}
                    qualityOptions={cardPicker.qualityOptions}
                    onConfirm={handleCardConfirm}
                    onClose={() => setCardPicker(null)}
                />
            )}

            {sizeSheet && (
                <BetSizeSheet
                    open
                    title={`${ACTION_LABELS[sizeSheet.type]} 금액`}
                    actionType={sizeSheet.type}
                    street={street}
                    pot={pot}
                    potQuality={potQuality}
                    currentBet={derived.currentBet}
                    toCall={derived.toCall}
                    minRaiseTo={derived.minRaiseTo}
                    bigBlind={hand.blinds?.bb}
                    playerStack={actorAllInTo}
                    chipUnit={hand.detailed?.chipUnit}
                    currency={hand.currency || ''}
                    requiresAllInKind={sizeSheet.type === 'all-in' && derived.currentBet !== 0}
                    onClose={() => setSizeSheet(null)}
                    onConfirm={(result) => {
                        const actionType = result.source === 'stack' ? 'all-in' : sizeSheet.type;
                        const recorded = onAction(sizeSheet.seat, actionType, {
                            street,
                            amount: result.amount,
                            amountUnit: result.unit,
                            amountQuality: result.quality,
                            sizeSource: result.source,
                            isAllIn: actionType === 'all-in' || result.source === 'stack',
                            allInKind: result.allInKind,
                        });
                        if (recorded === false) {
                            // 엔진 거부 — 성공한 것처럼 시트를 닫지 않는다
                            notifyRejectedAction();
                            return;
                        }
                        setSizeSheet(null);
                    }}
                />
            )}
        </section>
    );
};

const styles = {
    container: {
        width: '100%',
        maxWidth: '640px',
        flex: '1 1 auto',
        minHeight: 0,
        overflowY: 'auto',
        WebkitOverflowScrolling: 'touch',
        margin: '0 auto',
        boxSizing: 'border-box',
        padding: '14px 12px calc(14px + env(safe-area-inset-bottom))',
        background: '#0b1120',
        color: '#f8fafc',
    },
    emptyState: {
        display: 'grid', gap: '16px', placeItems: 'center', maxWidth: '480px', margin: '48px auto',
        padding: '24px', border: '1px solid #334155', borderRadius: '16px', background: '#111827', color: '#e2e8f0',
    },
    topBar: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' },
    eyebrow: { color: '#38bdf8', fontSize: '0.68rem', fontWeight: 900, letterSpacing: '0.12em' },
    heading: { margin: '2px 0 0', fontSize: '1.28rem' },
    compactButton: {
        minHeight: '42px', padding: '8px 12px', border: '1px solid #475569', borderRadius: '11px',
        background: '#1e293b', color: '#e2e8f0', fontWeight: 800, cursor: 'pointer',
    },
    summaryRow: {
        display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px 12px', marginTop: '12px',
        padding: '10px 12px', border: '1px solid #1e293b', borderRadius: '12px', background: '#0f172a',
        color: '#cbd5e1', fontSize: '0.82rem',
    },
    qualityBadge: { padding: '3px 7px', borderRadius: '999px', background: '#1e293b', color: '#94a3b8', fontSize: '0.7rem', fontWeight: 800 },
    timeline: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '6px', marginTop: '12px' },
    timelineItem: {
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px', minWidth: 0,
        minHeight: '44px', padding: '6px 3px', border: '1px solid #1e293b', borderRadius: '10px',
        background: '#111827', color: '#94a3b8', fontSize: '0.7rem', fontWeight: 800,
    },
    timelineItemCurrent: { border: '1px solid #0ea5e9', background: '#0c4a6e', color: '#f0f9ff' },
    timelineStatus: { fontSize: '0.82rem' },
    actionCount: { minWidth: '16px', padding: '1px 4px', borderRadius: '999px', background: 'rgba(15, 23, 42, 0.7)', textAlign: 'center' },
    contentGrid: { display: 'grid', gap: '10px', marginTop: '10px' },
    panel: { padding: '13px', border: '1px solid #1e293b', borderRadius: '14px', background: '#111827' },
    panelHeader: { display: 'flex', justifyContent: 'space-between', gap: '10px' },
    panelTitle: { margin: 0, color: '#f8fafc', fontSize: '0.98rem' },
    panelHint: { margin: '3px 0 0', color: '#94a3b8', fontSize: '0.74rem', lineHeight: 1.4 },
    fieldLabel: { display: 'block', marginTop: '12px', color: '#cbd5e1', fontSize: '0.76rem', fontWeight: 800 },
    fieldLabelText: { marginBottom: '6px', color: '#cbd5e1', fontSize: '0.76rem', fontWeight: 800 },
    select: {
        width: '100%', minHeight: '46px', marginTop: '6px', padding: '8px 10px', border: '1px solid #475569',
        borderRadius: '10px', background: '#0f172a', color: '#f8fafc', fontSize: '0.9rem',
    },
    cardInputRow: { display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '12px', marginTop: '12px' },
    cardSlots: { display: 'flex', gap: '5px' },
    miniCard: {
        display: 'inline-grid', placeItems: 'center', width: '34px', height: '42px', boxSizing: 'border-box',
        border: '1px dashed #475569', borderRadius: '7px', background: '#0f172a', fontWeight: 900,
    },
    miniCardFilled: { borderStyle: 'solid', background: '#1e293b' },
    inputButton: {
        minWidth: '72px', minHeight: '44px', padding: '8px 12px', border: '1px solid #0284c7', borderRadius: '10px',
        background: '#075985', color: '#f0f9ff', fontWeight: 800, cursor: 'pointer',
    },
    boardList: { display: 'grid', gap: '9px', marginTop: '12px' },
    boardRow: { display: 'grid', gridTemplateColumns: '52px 1fr auto', alignItems: 'center', gap: '8px' },
    boardLabel: { color: '#cbd5e1', fontSize: '0.76rem', fontWeight: 800 },
    smallButton: {
        minHeight: '40px', padding: '7px 9px', border: '1px solid #475569', borderRadius: '9px',
        background: '#1e293b', color: '#e2e8f0', fontSize: '0.72rem', fontWeight: 800, cursor: 'pointer',
    },
    advancePanel: {
        display: 'grid', gap: '12px', marginTop: '10px', padding: '14px', border: '1px solid #0ea5e9',
        borderRadius: '14px', background: '#082f49',
    },
    advanceActions: { display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: '8px' },
    primaryButton: {
        minHeight: '48px', padding: '9px 12px', border: 0, borderRadius: '11px',
        background: '#0284c7', color: '#fff', fontWeight: 900, cursor: 'pointer',
    },
    secondaryButton: {
        minHeight: '48px', padding: '9px 12px', border: '1px solid #475569', borderRadius: '11px',
        background: '#1e293b', color: '#e2e8f0', fontWeight: 800, cursor: 'pointer',
    },
    completePanel: {
        display: 'grid', gap: '14px', marginTop: '10px', padding: '15px', border: '1px solid #7c3aed',
        borderRadius: '15px', background: 'linear-gradient(145deg, #1e1b4b, #111827)',
    },
    completeEyebrow: { color: '#c4b5fd', fontSize: '0.67rem', fontWeight: 900, letterSpacing: '0.12em' },
    completeTitle: { margin: '4px 0 0', fontSize: '0.98rem', lineHeight: 1.4 },
    completionSummary: { display: 'flex', flexWrap: 'wrap', gap: '7px', marginTop: '9px', color: '#cbd5e1', fontSize: '0.74rem' },
    returnNotice: {
        display: 'inline-block', marginTop: '8px', padding: '5px 8px', borderRadius: '8px',
        background: 'rgba(245, 158, 11, 0.14)', color: '#fcd34d', fontSize: '0.72rem', fontWeight: 800,
    },
    showdownList: { display: 'grid', gap: '7px' },
    showdownRow: {
        display: 'grid', gridTemplateColumns: 'minmax(70px, 1fr) auto auto', gap: '8px', alignItems: 'center',
        padding: '8px', borderRadius: '10px', background: 'rgba(15, 23, 42, 0.7)',
    },
    showdownName: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#e2e8f0', fontSize: '0.78rem', fontWeight: 800 },
    winnerPanel: { display: 'grid', gap: '8px', padding: '10px', borderRadius: '12px', background: '#0f172a' },
    potWinnerGroup: { display: 'grid', gap: '6px', padding: '8px', border: '1px solid #334155', borderRadius: '10px' },
    potWinnerTitle: { color: '#fbbf24', fontSize: '0.7rem', fontWeight: 900 },
    winnerGrid: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '7px' },
    winnerButton: {
        minHeight: '42px', padding: '7px', border: '1px solid #475569', borderRadius: '10px',
        background: '#1e293b', color: '#cbd5e1', fontWeight: 800, cursor: 'pointer',
    },
    winnerButtonSelected: { border: '1px solid #22c55e', background: '#14532d', color: '#f0fdf4' },
    completeActions: { display: 'grid', gridTemplateColumns: '1.35fr 1fr', gap: '8px' },
    lockedNotice: {
        padding: '11px', border: '1px solid #475569', borderRadius: '10px',
        background: '#1e293b', color: '#cbd5e1', textAlign: 'center', fontSize: '0.76rem', fontWeight: 800,
    },
    completeButton: {
        minHeight: '50px', padding: '9px 12px', border: 0, borderRadius: '11px',
        background: '#7c3aed', color: '#fff', fontWeight: 900, cursor: 'pointer',
    },
    stickyActionBar: {
        position: 'sticky', bottom: 0, zIndex: 30, margin: '12px -12px -14px',
        padding: '11px 12px calc(11px + env(safe-area-inset-bottom))', borderTop: '1px solid #334155',
        background: 'rgba(15, 23, 42, 0.97)', boxShadow: '0 -12px 30px rgba(0, 0, 0, 0.35)',
        backdropFilter: 'blur(12px)',
    },
    actorRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', marginBottom: '9px' },
    actorLabel: { color: '#38bdf8', fontSize: '0.65rem', fontWeight: 900, letterSpacing: '0.08em' },
    actorName: { display: 'block', marginTop: '1px', fontSize: '0.94rem' },
    actorMeta: { color: '#94a3b8', fontSize: '0.7rem', textAlign: 'right' },
    actionGrid: { display: 'grid', gap: '7px' },
    actionButton: {
        minHeight: '50px', padding: '8px 6px', border: '1px solid rgba(255, 255, 255, 0.12)',
        borderRadius: '11px', color: '#fff', fontSize: '0.86rem', fontWeight: 900, cursor: 'pointer',
    },
    noActions: { padding: '12px', borderRadius: '10px', background: '#1e293b', color: '#94a3b8', textAlign: 'center', fontSize: '0.8rem' },
};

export default DetailedTracker;
