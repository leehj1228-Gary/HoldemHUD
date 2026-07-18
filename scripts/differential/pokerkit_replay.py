"""PokerKit 차등 리플레이 — 레퍼런스 트레이스 생성기 (docs/DIFFERENTIAL_REPLAY.md).

tests/differential/fixtures/*.json 을 PokerKit(NLHE)으로 재생해 우리 엔진과 동일한
스키마의 트레이스를 tests/differential/golden/pokerkit/<id>.trace.json 으로 쓴다.
생성물은 커밋 대상이며, vitest(tests/differential/pokerkitParity.test.js)가 Python 없이도
JS 엔진과 이 골든을 대조한다. fixture 를 바꾸면 이 스크립트로 골든을 재생성할 것.

사용법:  python scripts/differential/pokerkit_replay.py [fixtureId ...]
요구:    pip install pokerkit==0.7.4
"""

from __future__ import annotations

import json
import sys
import warnings
from pathlib import Path

from pokerkit import Automation, NoLimitTexasHoldem

# fixture가 보드 카드를 명시적으로 지정하므로 "덱 상단이 아닌 카드를 딜한다"는
# PokerKit의 권고 경고는 의도된 상황이다 — CI 로그를 어지럽히지 않게 억제한다.
warnings.filterwarnings("ignore", message=r"A card being dealt .*", category=UserWarning)

REPO = Path(__file__).resolve().parents[2]
FIXTURE_DIR = REPO / "tests" / "differential" / "fixtures"
GOLDEN_DIR = REPO / "tests" / "differential" / "golden" / "pokerkit"
TRACE_VERSION = "pokerkit-diff.v1"
STREETS = ("preflop", "flop", "turn", "river")

# 쇼다운 정산(show/muck·kill·push·pull)은 수동으로 밟는다 — 핸드 킬 이후에는
# 팟의 eligible 집합이 승자만 남게 병합되므로, 그 직전에 팟 구조를 캡처해야 한다.
AUTOMATIONS = (
    Automation.ANTE_POSTING,
    Automation.BET_COLLECTION,
    Automation.BLIND_OR_STRADDLE_POSTING,
    Automation.CARD_BURNING,
    Automation.RUNOUT_COUNT_SELECTION,
)


class FixtureError(Exception):
    def __init__(self, fixture_id: str, step: str, message: str):
        super().__init__(f"[{fixture_id}] {step}: {message}")


def player_order(fixture: dict) -> list[int]:
    """우리 좌석 → PokerKit 인덱스 매핑.

    PokerKit은 인덱스 0=SB(헤즈업은 0=BB), 마지막=버튼 규약이므로 딜러 다음
    좌석부터 시계방향으로 나열하고 딜러를 마지막에 둔다. 헤즈업에서는 이 결과가
    [상대(BB), 딜러(SB/BTN)]가 되어 PokerKit의 HU 블라인드 스왑과 정확히 일치한다.
    """
    seats = sorted(s["seat"] for s in fixture["seats"])
    dealer = fixture["dealerSeat"]
    if dealer not in seats:
        raise FixtureError(fixture["id"], "setup", f"dealerSeat {dealer} not in seats")
    at = seats.index(dealer)
    return seats[at + 1:] + seats[: at + 1]


def blind_list(fixture: dict, player_count: int) -> list[int]:
    game = fixture["game"]
    blinds = [game["sb"], game["bb"]]
    straddle = game["bb"]
    for _ in range(game.get("straddleCount", 0) or 0):
        straddle *= 2
        blinds.append(straddle)
    if len(blinds) > player_count:
        raise FixtureError(fixture["id"], "setup", "more forced posts than players")
    return blinds


def seat_map(values, order):
    return {str(seat): values[index] for index, seat in enumerate(order)}


def snap_pots(state, order):
    pots = []
    for pot in state.pots:
        eligible = sorted(order[i] for i in pot.player_indices)
        if pots and pots[-1]["eligibleSeats"] == eligible:
            pots[-1]["amount"] += pot.amount
        else:
            pots.append({"amount": pot.amount, "eligibleSeats": eligible})
    return pots


def capture_decision(state, order, seq, street):
    actor = state.actor_index
    bets = list(state.bets)
    stacks = list(state.stacks)
    can_wager = state.can_complete_bet_or_raise_to()
    return {
        "seq": seq,
        "street": street,
        "actorSeat": order[actor],
        "pot": state.total_pot_amount,
        "currentBet": max(bets),
        "toCall": state.checking_or_calling_amount if state.can_check_or_call() else None,
        "canFold": state.can_fold(),
        "canCheckOrCall": state.can_check_or_call(),
        "canWager": can_wager,
        "wagerMinTo": state.min_completion_betting_or_raising_to_amount if can_wager else None,
        "wagerMaxTo": state.max_completion_betting_or_raising_to_amount if can_wager else None,
        "stacks": seat_map(stacks, order),
        "streetCommitted": seat_map(bets, order),
    }


def apply_action(state, action, fixture_id: str, index: int):
    kind = action["type"]
    if kind == "fold":
        state.fold()
    elif kind in ("check", "call"):
        state.check_or_call()
    elif kind in ("bet", "raise"):
        state.complete_bet_or_raise_to(action["amountTo"])
    elif kind == "all-in":
        actor = state.actor_index
        all_in_to = state.bets[actor] + state.stacks[actor]
        if max(state.bets) == 0 or all_in_to > max(state.bets):
            state.complete_bet_or_raise_to(all_in_to)
        else:
            state.check_or_call()
    else:
        raise FixtureError(fixture_id, f"action {index}", f"unknown action type {kind!r}")


def board_for(fixture: dict, street: str) -> str:
    cards = (fixture.get("board") or {}).get(street) or []
    expected = 3 if street == "flop" else 1
    if len(cards) != expected:
        raise FixtureError(fixture["id"], "board", f"fixture board missing {street} cards")
    return "".join(cards)


def replay(fixture: dict) -> dict:
    fixture_id = fixture["id"]
    order = player_order(fixture)
    stack_by_seat = {s["seat"]: s["stack"] for s in fixture["seats"]}
    starting = [stack_by_seat[seat] for seat in order]
    state = NoLimitTexasHoldem.create_state(
        AUTOMATIONS,
        True,  # ante_trimming_status (앤티 없음이라 무의미하지만 시그니처상 필요)
        0,
        tuple(blind_list(fixture, len(order))),
        fixture["game"]["bb"],
        tuple(starting),
        len(order),
    )

    hole_cards = fixture.get("holeCards") or {}
    actions = fixture.get("actions") or []
    cursor = 0
    streets_dealt = 0
    decisions = []
    captured_pots = None
    net_committed_stacks = None
    went_to_showdown = False

    while state.status:
        if state.can_deal_hole():
            seat = order[state.hole_dealee_index]
            cards = hole_cards.get(str(seat))
            if not cards:
                raise FixtureError(fixture_id, "deal", f"fixture missing holeCards for seat {seat}")
            state.deal_hole("".join(cards))
        elif state.actor_index is not None:
            street = STREETS[0] if streets_dealt == 0 else STREETS[streets_dealt]
            if cursor >= len(actions):
                raise FixtureError(
                    fixture_id, "actions",
                    f"pokerkit expects seat {order[state.actor_index]} to act on {street} "
                    "but the fixture has no actions left")
            action = actions[cursor]
            if action["seat"] != order[state.actor_index] or action["street"] != street:
                raise FixtureError(
                    fixture_id, f"action {cursor}",
                    f"pokerkit expects seat {order[state.actor_index]} on {street}, fixture says "
                    f"seat {action['seat']} on {action['street']}")
            decisions.append(capture_decision(state, order, cursor, street))
            apply_action(state, action, fixture_id, cursor)
            cursor += 1
        elif state.can_deal_board():
            streets_dealt += 1
            state.deal_board(board_for(fixture, STREETS[streets_dealt]))
        elif state.can_show_or_muck_hole_cards():
            went_to_showdown = True
            if captured_pots is None:
                captured_pots = snap_pots(state, order)
                net_committed_stacks = list(state.stacks)
            state.show_or_muck_hole_cards()
        elif state.can_kill_hand():
            state.kill_hand()
        elif state.can_push_chips():
            if captured_pots is None:
                captured_pots = snap_pots(state, order)
                net_committed_stacks = list(state.stacks)
            state.push_chips()
        elif state.can_pull_chips():
            state.pull_chips()
        else:
            raise FixtureError(fixture_id, "loop", "no legal phase transition (harness bug)")

    if cursor != len(actions):
        raise FixtureError(
            fixture_id, "actions",
            f"hand ended with {len(actions) - cursor} fixture action(s) unconsumed")
    if captured_pots is None or net_committed_stacks is None:
        raise FixtureError(fixture_id, "final", "pot structure was never capturable")

    final_stacks = list(state.stacks)
    net_committed = {
        str(seat): stack_by_seat[seat] - net_committed_stacks[index]
        for index, seat in enumerate(order)
    }
    return {
        "traceVersion": TRACE_VERSION,
        "fixtureId": fixture_id,
        "decisions": decisions,
        "final": {
            "street": STREETS[0] if streets_dealt == 0 else STREETS[streets_dealt],
            "wentToShowdown": went_to_showdown,
            # 폴드 종료 핸드에서 PokerKit은 생존자의 마지막 스트리트 베팅을 수거하지 않고
            # 통째로 환급하므로 팟/커밋 표현이 우리 엔진(레이어 팟 + 초과분만 반환)과
            # 구조적으로 다르다. 칩 흐름은 finalStacks가 완전히 고정하므로 팟 구조와
            # netCommitted 비교는 쇼다운 핸드로 한정한다 (JS 쪽 트레이스와 동일 규약).
            "pots": captured_pots if went_to_showdown else None,
            "netCommitted": net_committed if went_to_showdown else None,
            "finalStacks": seat_map(final_stacks, order),
        },
    }


def main(argv: list[str]) -> int:
    wanted = set(argv)
    fixture_paths = sorted(FIXTURE_DIR.glob("*.json"))
    if not fixture_paths:
        print(f"no fixtures found under {FIXTURE_DIR}", file=sys.stderr)
        return 1
    GOLDEN_DIR.mkdir(parents=True, exist_ok=True)
    failures = 0
    written = 0
    for path in fixture_paths:
        fixture = json.loads(path.read_text(encoding="utf-8"))
        if wanted and fixture["id"] not in wanted and path.stem not in wanted:
            continue
        try:
            trace = replay(fixture)
        except (FixtureError, ValueError) as error:
            failures += 1
            print(f"FAIL {path.stem}: {error}", file=sys.stderr)
            continue
        target = GOLDEN_DIR / f"{fixture['id']}.trace.json"
        target.write_text(
            json.dumps(trace, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
            encoding="utf-8", newline="\n")
        written += 1
        print(f"ok   {fixture['id']} ({len(trace['decisions'])} decisions)")
    print(f"{written} trace(s) written, {failures} failure(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
