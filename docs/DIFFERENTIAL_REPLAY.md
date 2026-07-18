# PokerKit 차등 리플레이 (Phase 3)

연구 기준서 §22(golden fixture 차등 검증)의 구현. 같은 핸드 원장을 우리
`detailedHandEngine`과 독립 구현체 [PokerKit](https://github.com/uoftcprg/pokerkit)
(NLHE, `pokerkit==0.7.4`)으로 각각 재생해, **결정 시점마다** 팟·스택·직면 콜 금액·
합법 액션(폴드/체크콜/웨이저 + min/max)·그리고 핸드 종료 시 사이드팟 구조와 최종
스택이 일치하는지 CI에서 강제한다. 우리 엔진의 베팅 규칙 구현이 조용히 어긋나는
것을 막는 회귀 울타리이자, 규칙 경계(리오픈·스트래들 등)의 해석 차이를 명시적
선언 없이는 통과하지 못하게 만드는 장치다.

## 구성 요소

```
tests/differential/
  fixtures/F01..F14*.json        # golden fixture 14종 — 양쪽이 소비하는 단일 스펙
  golden/pokerkit/*.trace.json   # PokerKit 재생 결과 (커밋 대상 — 재생성은 아래 명령)
  lib/driveFixture.js            # fixture → 우리 엔진 "생산 경로" 재생 → 트레이스
  lib/compareTraces.js           # 필드 단위 비교 + expectedDivergences 정책
  pokerkitParity.test.js         # vitest 게이트 (Python 불필요 — 커밋된 골든과 대조)
scripts/differential/pokerkit_replay.py   # PokerKit 재생기 (골든 생성기)
```

- `npm test` — JS 엔진을 커밋된 골든과 항상 대조한다 (Python 없이 동작).
- `npm run diff:pokerkit` — 골든 재생성 + 대조 (요구: `pip install pokerkit==0.7.4`).
- CI(`.github/workflows/ci.yml`) — node 잡이 3종 게이트를, `pokerkit-parity` 잡이
  골든 재생성 후 `git diff --exit-code`로 **골든 신선도**를 검증한다. fixture나
  재생기를 바꾸고 골든 재생성을 빠뜨리면 여기서 실패한다.

## fixture 스키마

```jsonc
{
  "id": "F05_triple_allin_two_side_pots",   // 파일명(stem)과 동일
  "title": "무엇을 고정하는 fixture인지 한 줄",
  "game": { "sb": 1, "bb": 2, "chipUnit": 1, "straddleCount": 0 },
  "dealerSeat": 3,
  "heroSeat": 2,                            // JS쪽 heroCards 배정용 (재생엔 무관)
  "seats": [{ "seat": 0, "stack": 100 }],   // 전원 sittingOut 아님, 정수 칩
  "holeCards": { "0": ["7h","2c"] },        // 모든 좌석 필수 (PokerKit 쇼다운 평가용)
  "board": { "flop": [..3], "turn": [..1], "river": [..1] },  // 도달 스트리트까지만
  "actions": [{ "street": "preflop", "seat": 2, "type": "all-in" }],
  "result": { "winners": [{ "seat": 2, "potIndex": 0 }] },
  "expectedDivergences": []
}
```

제약 (driveFixture가 강제):

- **모든 수치는 정수 칩, 전 좌석 exact 스택** — 정밀도 저하 경로는 이 하네스의
  대상이 아니다 (그건 엔진 단위 테스트 영역).
- `actions[].type ∈ fold/check/call/bet/raise/all-in`. `bet`/`raise`만 `amountTo`
  필수, `all-in`은 엔진이 스택으로 금액을 계산한다 (call/bet/raise로 자동 분류).
- 모든 액션은 우리 엔진의 `applyDetailedAction` **합법성 게이트를 실제로 통과**해야
  한다 (no-op 거부 = fixture 실패). PokerKit 쪽에서도 동일하게 예외 = 실패.
  즉 fixture 원장의 합법성 자체가 양쪽에서 교차 검증된다.
- `result.winners[].potIndex`는 **우리 엔진 `deriveSidePots`의 병합 전 인덱스**
  (폴드 좌석 커밋 경계마다 레이어가 쪼개진 상태). 생략(`{}`)하면 단독 생존자 자동.
- 스플릿 팟(동률) 금지 — 홀짝 칩 분배 규약이 구현마다 달라 v1 범위에서 제외.
- fixture 승자 선언이 실제 핸드 강도와 다르면 PokerKit의 자체 쇼다운 평가가
  `finalStacks` 불일치로 잡아낸다 (fixture 저작 실수 방어).

## 트레이스 스키마와 비교 정책

각 결정(액션 직전) 시점: `street / actorSeat / pot(현재 스트리트 베팅 포함) /
currentBet / toCall(스택 캡 적용) / canFold / canCheckOrCall / canWager /
wagerMinTo·wagerMaxTo(올인 캡 적용) / stacks / streetCommitted`.
종료 시점: `street / wentToShowdown / pots / netCommitted / finalStacks`.

- `canWager` = 상대가 응수해야 하는 베팅(벳/레이즈, 올인 포함)이 가능한가.
  PokerKit `can_complete_bet_or_raise_to()`와 동일 의미.
- `pots`는 **인접 동일 eligible 레이어 병합** 후 비교한다 (우리는 폴드 좌석 경계마다
  쪼개고 PokerKit은 합치므로 — 금액·자격 집합은 동일해야 함).
- **폴드로 끝난 핸드는 `pots`/`netCommitted`를 양쪽 다 `null`로 둔다**: PokerKit은
  생존자의 마지막 스트리트 베팅을 팟에 넣지 않고 통째로 환급하는 표현을 써서
  구조 비교가 성립하지 않는다. 칩 흐름 자체는 `finalStacks`(+JS쪽 칩 보존 검사)가
  완전히 고정한다.
- `expectedDivergences`: `{decision(seq|"final"), field, js, pokerkit, rule, notes}`.
  선언되지 않은 불일치도, **더 이상 재현되지 않는 선언(스테일)도, 소비되지 않은
  선언도 전부 실패**다 — 규칙 경계가 어느 방향으로든 소리 없이 움직일 수 없다.

## 확인된 규칙 표면 (2026-07-18, pokerkit 0.7.4)

**합의 (교차 확증):**

- HU 블라인드 배치(딜러=SB)와 프리/포스트플랍 액션 순서, 6맥스/스트래들 순서 (F01·F02·F09)
- 림프/컴플리트·최소 레이즈 산수·min bet, 레이즈 체인의 lastFullRaiseSize (F03·F04)
- 사이드팟 레이어·자격 집합·데드머니 배분·언콜드 반환·부분 콜(콜 올인) (F05·F10·F12·F13)
- **숏올인 리오픈 의미론이 TDA 누적 해석으로 완전 일치**: 단일 숏올인(누적<풀레이즈)은
  리오픈 없음(F06·F14), 누적≥풀레이즈면 리오픈(F07), 응수 상대 부재 시 웨이저 불가.
  우리 엔진의 TDA 누적 구현이 PokerKit으로 교차 확증됐다.

**문서화된 불일치 (fixture에 선언됨):**

| fixture | 표면 | 우리 엔진 | PokerKit |
|---|---|---|---|
| F08 | 체크 후 최소벳 미만 올인 벳을 마주한 좌석 | 리오픈 불허 (TDA 47-B "이미 액션함" 엄격 해석) | 리오픈 허용 (min = 올인+풀민벳) |
| F09 | 스트래들 위 최소 리레이즈 | 8 (스트래들=새 블라인드 레벨 학파) | 6 (BB 대비 증분 학파) |

두 표면 모두 실무 룰북/룸 관행이 갈리는 지점이라 "버그"가 아니라 해석 선택이다.
우리 해석을 바꾸기로 결정하면: 엔진 수정 → 해당 fixture의 선언 제거 → 골든 재생성.

**하네스가 발견해 수정한 엔진 이슈:** `legalDetailedActions`가 스택이 현재 벳을
넘어설 수 없는(콜 올인만 가능한) 좌석에도 `raise` 어휘를 광고 — `applyDetailedAction`
은 전부 거부하는 죽은 어휘였다 (F12에서 발견, 회귀 테스트 추가).

## fixture 추가 절차

1. `tests/differential/fixtures/F<nn>_<slug>.json` 작성 (위 스키마·제약 준수).
2. `npm run diff:pokerkit` — PokerKit 골든 생성 + 대조. 불일치가 뜨면:
   진짜 버그인지(→ 엔진 수정) 해석 차이인지(→ `expectedDivergences` 선언 + 근거)
   판정한다. **선언은 항상 근거(rule/notes)와 함께.**
3. `npm test` 3종 게이트 통과 확인, 골든 파일 커밋.

## 한계 / 후속

- CI 게이트 전용이다. 런타임 핸드별 차등 검증(분석 직전 sidecar 재생,
  `REPLAY_DISAGREEMENT`/`SIDECAR_UNAVAILABLE` 오류 계약 연결)은 후속 Phase —
  오류 코드는 analysis 계약에 이미 예약돼 있다.
- 스플릿 팟·앤티·정밀도 저하(estimated/unknown) 원장은 범위 밖 (fixture 제약 참고).
- PokerKit 버전은 0.7.4로 핀 — 업그레이드 시 골든 재생성으로 규칙 변화가 드러난다.
