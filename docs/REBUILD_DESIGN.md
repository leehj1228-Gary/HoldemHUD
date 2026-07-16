# HoldemHUD 리빌딩 설계 계약 (v1)

이 문서는 리빌딩에 참여하는 모든 에이전트가 따라야 하는 **단일 계약**이다.
여기 정의된 스키마·API·규칙과 다르게 구현하지 말 것. 모호하면 이 문서 기준으로 통일한다.

## 0. 배경과 목표

기존 앱은 감사에서 92건의 버그(치명 6)가 확인됐다. 근본 원인 3가지를 구조로 해결한다:

1. **이중 통계 시스템** (라이브 카운터 vs 히스토리 재계산이 서로 다른 결과) → 통계는 **항상 핸드 레코드에서 파생**. 증분 카운터 전면 폐지.
2. **다중 setState 트랜잭션** (레이스/stale closure의 온상) → **단일 useReducer 원자 상태**.
3. **읽기만 있고 쓰기 없는 저장 계층** → 상태 원자 전체를 하나의 이펙트로 자동 저장 + 스키마 버전 + v33 마이그레이션.

범위: 기존과 동일하게 **프리플랍 전용** 라이브 HUD. 언어: JavaScript (TS 아님). React 19 + Vite.
UI 문자열: 기존 화면의 한국어/영어 혼용 그대로 유지. 기존 `index.css`의 클래스/id를 그대로 사용해 스타일 재사용.

## 1. 파일 구조

```
src/
  engine/
    schema.js        # [작성 완료 — 수정 금지] 상수·레코드 생성자·검증
    handEngine.js    # 순수 핸드 상태 머신 (E1)
    statsEngine.js   # 순수 통계 엔진 — 유일한 통계 구현 (E2)
    archetypes.js    # 플레이어 유형 분류 + 프리셋 (E2)
  storage/
    storage.js       # 버전드 영속화 + v33 마이그레이션 (E3)
  state/
    gameReducer.js   # 단일 리듀서 + 셀렉터 (S1)
    GameContext.jsx  # 얇은 프로바이더: useReducer + 저장 이펙트 + 자동다음핸드 타이머 (S1)
  services/
    aiService.js     # Gemini 클라이언트 — 키는 설정에서 (S5)
  components/
    ErrorBoundary.jsx (E4)
    screens/  game/  common/  coach/   # 이식된 화면 (S2~S5)
tests/
  engine/*.test.js  storage/*.test.js  state/*.test.js   # vitest
```

**의존 방향 규칙**: `engine/`과 `storage/`는 React·DOM·다른 계층을 import 금지(순수 모듈).
`state/`는 engine+storage만 import. 화면은 `useGame()`만 사용, 통계·포지션을 인라인 계산 금지.

## 2. 데이터 스키마 (schema.js에 구현됨 — 계약)

- `seat`: **0-based 고정 좌석 번호**. 모든 곳에서 0-based (구코드의 1-based `seat` 필드 혼용 금지).
- 플레이어 식별: **trim된 이름 문자열** (세션 간 동일 이름 = 동일 인물).

```js
Seat        = { seat, name, sittingOut }
HandSeat    = { seat, name, sittingOut, position }   // position: 'BTN'|'SB'|'BB'|'UTG'|...|null(sitout)
Action      = { seq, seat, name, position, type, raiseLevel, street:'preflop' }
              // type: 'fold'|'check'|'call'|'raise'
              // raiseLevel: raise일 때 1=오픈(2벳),2=3벳,3=4벳…, 그 외 0
HandRecord  = { id, handNo, startedAt, endedAt, dealerSeat, straddleCount, blinds, seats:[HandSeat], actions:[Action] }
SessionRecord = { id, schemaVersion, startedAt, endedAt, blinds:{sb,bb}, currency, totalHands, hands:[HandRecord], legacy? }
```

## 3. 핸드 엔진 API (E1: `engine/handEngine.js`) — 전부 순수 함수

```js
positionsForHand(seats, dealerSeat)   // → Map<seat, position|null>. 액티브(!sittingOut)만 포지션 부여.
                                      // HU: 딜러='BTN'(SB 겸), 상대='BB'. 3인+: BTN,SB,BB,UTG,…,CO (구 getPosNameFromDist 표 준용: 4인 dist3=CO, 5인 UTG/CO, 6인 UTG/HJ/CO, 7인 +LJ, 8인 +UTG+1, 9인 +UTG+2)
lastOptionSeat(seats, dealerSeat, straddleCount)  // 언레이즈 팟에서 체크 권리를 가진 좌석: 스트래들 없으면 BB, 있으면 마지막 스트래들 좌석(BB 다음 straddleCount번째 액티브 좌석)
firstToActSeat(seats, dealerSeat, straddleCount)  // lastOption 다음 액티브 좌석. HU(액티브 2인): 딜러가 먼저.
deriveHandState(hand)  // → { toActSeat|null, raiseCount, lastAggressorSeat|null, limperCount,
                       //     foldedSeats:Set, actedSinceLastRaise:Set, isOver, endedByFold }
legalActionsFor(hand, seat)  // → ['fold','check','call','raise'] 부분집합. 규칙:
                             // - sittingOut·폴드·핸드종료·차례아님 → []
                             // - raiseCount===0: lastOption 좌석은 ['check','raise'], 그 외 ['fold','call','raise']
                             // - raiseCount>=1: ['fold','call','raise'] (단, 자신이 현재 어그레서면 차례가 오지 않음)
applyAction(hand, seat, type)  // → 새 HandRecord (불변). 불법 액션이면 원본 그대로 반환. raiseLevel 자동 계산(= 액션 전 raiseCount+1).
nextDealerSeat(seats, dealerSeat)  // 다음 액티브 좌석
```

**isOver 판정(리플레이로 계산)**: `actedSinceLastRaise`가 폴드 안 한 액티브 전원을 포함하면 종료.
raise가 나오면 set을 {레이저}로 리셋. 폴드로 1명만 남아도 종료(endedByFold).
스트래들은 **레이즈가 아니다** (raiseCount에 불포함, 스트래들 위 오픈도 raiseLevel 1).

## 4. 통계 엔진 API (E2: `engine/statsEngine.js`) — 유일한 통계 구현

```js
computeAllStats(hands)              // → Map<trimmedName, PlayerStats> (한 번의 리플레이 패스)
computeStats(hands, playerName)     // 단일 플레이어 편의 함수
formatPct(ratio)                    // den===0 → null (UI가 '-' 표시)
```

`PlayerStats`: `{ dealt, vpip, pfr, threeBet, ft3b, fourBet, ats, fts, openLimp, coldCall, straddle, pos: {EP,MP,CO,BTN,SB,BB: {dealt,vpip,pfr}} }`
— 각 스탯은 `{ num, den, pct }` (pct는 반올림 정수, den 0이면 null).

**정의 (감사 확정 버그를 수정한 표준 HUD 정의 — 그대로 구현할 것):**

핸드 리플레이 중 각 액션 시점의 `raiseCount`/`limperCount`/어그레서를 추적한다. 대상 플레이어가 `sittingOut`이거나 좌석에 없으면 그 핸드는 완전히 건너뛴다.

| 스탯 | den (기회) | num |
|---|---|---|
| dealt | 좌석에 있고 sittingOut 아님 (액션 여부 무관!) | — |
| VPIP | dealt | call 또는 raise 1회 이상. **check는 절대 불포함** |
| PFR | dealt | raise 1회 이상 |
| 3Bet | raiseCount===1 && 오픈이 본인 것 아님 상태로 액션한 핸드 (핸드당 1회) | 그 시점 raise |
| Ft3B | 본인이 오픈(raiseLevel 1) 후 **raiseCount===2** 상태로 액션 (핸드당 1회; 4벳 이상 국면 제외) | 그 시점 fold |
| 4Bet | Ft3B와 동일 den | 그 시점 raise |
| ATS | raiseCount===0 && limperCount===0 && 본인 포지션 ∈ {CO,BTN,SB} 로 액션 | raise |
| FtS | 본인 포지션 ∈ {SB,BB} && raiseCount===1 && 오프너 포지션 ∈ {CO,BTN,SB} && 사이 콜러 없음 | fold |
| OpenLimp | raiseCount===0 && limperCount===0 && 본인이 lastOption 좌석 아님 | call |
| ColdCall | raiseCount>=1 && 본인의 이전 자발적 액션 없음 상태로 액션 (핸드당 1회) | call |
| Straddle | 본인이 액티브 순서상 BB 다음 좌석인 핸드 | 그 핸드 straddleCount>0 |
| pos.* | 해당 포지션으로 dealt | vpip/pfr 동일 규칙 |

포지션은 **HandRecord에 저장된 값을 신뢰**한다(레코드의 seats[].position, actions[].position). 재계산 금지.
포지션 카테고리 매핑: UTG/UTG+1/UTG+2→EP, LJ/HJ/MP→MP, 나머지는 그대로.

`archetypes.js`: 구 `StatsCalculator.js`의 `PLAYER_ARCHETYPES`/`LIVE_PLAYER_PRESETS`(gameLogic.js) 이식.
`analyzePlayerStyle(vpip, pfr, hands)` 분류 순서를 기준과 일치하게 수정:
`hands<20→UNKNOWN` → `MANIAC(vpip>=45&&pfr>=30)` → `STATION(vpip>=30&&gap>=15)` → `NIT(vpip<17)` → `LAG(vpip>=27)` → `GTO(vpip 20~27 && gap<=5)` → `TAG`.
구 `getPlayerType`은 폐지하고 `analyzePlayerStyle` + `styleFor(stats)` 헬퍼로 통일 (0핸드 → UNKNOWN 라벨).

## 5. 스토리지 (E3: `storage/storage.js`)

키: `hh:v1:state` (원자: `{schemaVersion, session, roster, settings}`), `hh:v1:archive` (SessionRecord[]), 별도 저장.
API:

```js
loadPersisted()        // → { state|null, archive:[] }  — 없으면 migrateFromLegacy() 시도
savePersistedState(partialAtom)   // JSON 직렬화, try/catch로 quota 에러 흡수 (콘솔 + boolean 반환)
saveArchive(archive)
resetAllData()         // v1 키 + 레거시 v33 키 전부 삭제
migrateFromLegacy()    // 구 poker_*_v33 키 → v1 변환. 구 키는 지우지 않음(롤백 안전).
```

**v33 → v1 마이그레이션 매핑**: 구 `poker_history_v33`의 각 세션 →
`SessionRecord{ legacy:true, blinds:null, currency: 구 CURRENCY 키 값 || '$' }`.
각 구 핸드 → `HandRecord`: `dealerSeat=dealerIndex`, seats는 `playersSnapshot`에서
(`seat` 0-based 그대로, `sittingOut = position==='SitOut'||position===''`, position은 저장값 유지하되 SitOut→null).
actions: `seat=playerIndex`(구 1-based `seat` 필드 무시), type 유지(레거시 call은 check와 구분 불가 — 그대로 call),
raiseLevel은 detail('2-Bet'→1,'3-Bet'→2 …) 우선, 없으면 리플레이로 raise 순번 계산. 파싱 실패 핸드는 건너뛰고 카운트 로깅.
구 로스터 키도 이식. 숫자 파싱은 전부 `Number.parseInt` + `Number.isNaN` 가드.

## 6. 상태 계층 (S1: `state/gameReducer.js` + `GameContext.jsx`)

상태 원자:

```js
{
  schemaVersion: 1,
  nav: ['home'],                       // 'home'|'game'|'history'|'profile'|'coach' 스택
  roster: [string],
  settings: { geminiApiKey:'', aiModel:'gemini-3-pro-preview' },
  session: null | {
    id, startedAt, blinds:{sb,bb}, currency,
    seats:[Seat], dealerSeat, straddleCount, handNo,   // handNo: 현재 핸드 번호(1-based)
    hands:[HandRecord],                 // 완료된 핸드
    currentHand: HandRecord             // 진행 중 (actions 누적)
  },
  archive: [SessionRecord],
  autoNext: { pending:false }
}
```

리듀서 액션: `LOAD_PERSISTED, START_SESSION(cfg), END_SESSION, RECORD_ACTION(seat,type), UNDO,
NEXT_HAND, AUTO_NEXT_FIRED, CANCEL_AUTO_NEXT, TOGGLE_SITOUT(seat), SET_DEALER(seat), CYCLE_STRADDLE,
ADD_SEAT, REMOVE_SEAT, RENAME_SEAT(seat,name), SWAP_SEATS(a,b), ADD_ROSTER(name), REMOVE_ROSTER(name),
DELETE_ARCHIVED(id), UPDATE_SETTINGS(patch), NAV_PUSH(screen), NAV_POP, NAV_HOME, RESET_ALL`

핵심 의미론 (감사 버그의 구조적 해결):

- **RECORD_ACTION**: `applyAction` 위임. 불법이면 no-op (폴드한 플레이어 오기록 원천 차단). 적용 후 `isOver`면 `autoNext.pending=true`.
- **UNDO (리플레이 기반, 핸드 경계 넘기 지원)**: currentHand.actions 있으면 마지막 액션 제거.
  없고 hands 있으면 마지막 완료 핸드를 pop → 그 핸드의 dealerSeat/straddleCount 복원, 마지막 액션 제거한 상태로 currentHand 복귀, handNo-1. 항상 autoNext 취소. (스냅샷 스택 폐지 — 1.5초 뒤 미스탭 교정 불가 문제 해결)
- **NEXT_HAND**: currentHand.actions 비었으면 레코드 저장 없이 딜러만 회전(쓰레기 레코드 방지). 있으면 endedAt 찍고 hands에 push. 딜러는 액티브 좌석으로 회전, 새 currentHand 생성(포지션 계산 포함), handNo+1, autoNext.pending=false.
- **AUTO_NEXT_FIRED**: `pending===true`일 때만 NEXT_HAND 수행 후 pending=false. (이중 발화 구조적 차단 — 타이머가 몇 번 울리든 1회만 적용)
- **TOGGLE_SITOUT**: 앉아있는 핸드 진행 중이고 미폴드면 fold 액션을 applyAction으로 기록 후 sittingOut 토글.
- **END_SESSION**: currentHand에 액션 있으면 완료 처리 → SessionRecord 생성해 archive에 push → `session=null` (중복 저장/이중 집계 구조적 차단). blinds/currency 포함 저장.
- **START_SESSION**: cfg `{playerCount, blinds, currency, startedAt, seatNames?}`. NaN 블라인드 거부(기본값 대체).

`GameContext.jsx` (얇게 유지, 200줄 이하 목표):

- `useReducer` + 마운트 시 `loadPersisted()` → LOAD_PERSISTED.
- **저장 이펙트 1개**: `state.session/roster/settings` 변경 시 300ms 디바운스로 `savePersistedState`. archive 변경 시 `saveArchive`.
- **자동 다음핸드 타이머 1개**: `autoNext.pending`이 true가 되면 1500ms 후 `dispatch({type:'AUTO_NEXT_FIRED'})`. cleanup에서 clearTimeout. 의존성은 `[autoNext.pending]` 뿐 — 리듀서가 멱등이므로 stale closure 문제 자체가 없음.
- 파생값은 `useMemo`: `derived = deriveHandState(currentHand)`, `playerStats = computeAllStats([...hands, currentHand])`, `positions`.
- `@capacitor/app` backButton 리스너: nav 길이>1 → NAV_POP, 아니면 `App.exitApp()`. try/catch로 웹에서 무해하게.

**`useGame()`이 노출하는 계약** (화면 에이전트는 이것만 사용):

```js
{ screen, session, seats, dealerSeat, straddleCount, blinds, currency, handNo,
  currentHand, derived /* {toActSeat,raiseCount,isOver,foldedSeats,...} */,
  positions /* Map<seat,pos> */, legalActionsFor(seat) /* 배열 */,
  sessionHands, archive, roster, settings, playerStats /* Map<name,PlayerStats> */,
  autoNextPending,
  navigateTo(screen), goBack(),
  startSession(cfg), endSession(), resumeSession() /* session 있으면 game으로 */,
  recordAction(seat,type), undo(), nextHand(), cancelAutoNext(),
  toggleSitOut(seat), setDealer(seat), cycleStraddle(), addSeat(), removeSeat(),
  renameSeat(seat,name), swapSeats(a,b), addToRoster(name), removeFromRoster(name),
  deleteArchivedSession(id), updateSettings(patch), resetAllData() }
```

`App.jsx`: ErrorBoundary로 감싼 5-way 화면 스위치(`screen` 기준). `main.jsx`: Provider 래핑.

## 7. 화면 이식 규칙 (S2~S5)

- 기존 JSX/클래스명/한국어 문구/스타일 최대한 유지. 데이터 접근만 새 계약으로 교체.
- **PlayerList**: 액션 버튼을 `legalActionsFor(seat)`로 렌더 — Check가 합법이면 Check 버튼(초록), Call과 구분. 버튼 비활성 조건은 `derived.toActSeat !== seat`. VPIP/PFR은 `playerStats.get(name)`에서.
- **HomeScreen**: "Resume Active"는 `session` 없으면 숨김/비활성. 새 세션 경고는 `session && session.hands.length>0` 기준. 커스텀 블라인드 NaN 가드. ⚙️ 설정 버튼 추가 → SettingsModal(Gemini API 키·모델 입력, `updateSettings`로 저장; 키는 password input, 로컬에만 저장된다는 안내 문구).
- **HistoryScreen/ProfileScreen**: 통계는 전부 `statsEngine.computeAllStats`(archive의 hands + 현 세션)로. `potSize` 등 쓰는 곳 없는 필드 제거. 세션 카드에 blinds/currency 표시(legacy는 '-').
- **StatsModal**: 현 세션 `playerStats` 표시. 3Bet%는 기회 기반(den=threeBet.den). `resetAllData` 이제 실제로 동작(계약에 포함됨). 초기화 후 홈으로.
- **SeatModal**: 로스터에서 앉히기 — **이미 앉은 이름은 quick-add·프리셋 경로 포함 전부 차단**(중복 착석 방지). 프리셋 선택 시 이모지 라벨이 아닌 이름 저장.
- **AI 코치 (S5)**: `AICoachScreen.jsx`를 컨테이너로 축소하고 `coach/CoachSetup.jsx`, `coach/RangeChart.jsx`, `coach/StrategyResults.jsx`, `coach/SessionLeaks.jsx`로 분해.
  - **RangeChart: AI가 준 `recommendedRange`(169콤보)를 실제로 렌더** — 13×13 그리드, Raise/Call/Fold 색상. `Math.random()` 자리표시자 완전 제거.
  - 게임에서 진입 시 세션의 실제 blinds/seats/포지션/스택을 초기값으로.
  - 세션 리크 분석: 히어로는 실제 좌석 이름 목록에서 선택(가공의 'Hero' 기본값 금지), 분석 대상 0핸드면 실행 차단+안내. `evidenceHands` 배열(핸드 번호)로 리플레이 연결 — 정규식 파싱 폐지. AI에 보내는 상대 스탯은 statsEngine의 **퍼센트 값**으로.
- **aiService (S5)**: 키는 `settings.geminiApiKey` 인자로 주입(모듈이 storage 직접 접근 금지 — state에서 전달). 키 없으면 명확한 에러 메시지("설정에서 API 키를 입력하세요"). `generationConfig:{responseMimeType:'application/json'}`, 응답 `data.candidates?.[0]?.content?.parts?.[0]?.text` 가드, AbortController 60초, 프롬프트의 핸드 데이터는 새 스키마 기준으로 재작성(0-based seat 일관).

## 8. 플랫폼 (E4)

- `electron/main.js`: `contextIsolation:true, nodeIntegration:false`, `ELECTRON_START_URL` 지원(electron:dev가 dev 서버 로드), 아이콘 참조는 존재 확인 후.
- `vitest.config.js` 별도 파일(vite.config.js는 건드리지 않음), environment 'node', include `tests/**/*.test.js`.
- `src/components/ErrorBoundary.jsx`: 에러 화면 + "다시 시작" 버튼(location.reload) + 콘솔 로깅.

## 9. 테스트 규칙

- 프레임워크: vitest (`npm test`). DOM 불필요(엔진·리듀서·스토리지는 순수).
- 필수 골든 케이스: BB 체크 ≠ VPIP / 3벳 기회 카운팅 / Ft3B 핸드당 1회·4벳 국면 제외 / ATS 포지션 게이트(4·5인 포함) / sit-out 좌석 dealt 제외·포지션 재배치 / HU 규칙(딜러 선액션) / 스트래들 시 lastOption·firstToAct / 어그레서 셀프 레이즈 불가 / isOver 판정(폴드 종료·체크 종료·콜 마감) / UNDO 핸드 경계 복원 / AUTO_NEXT_FIRED 멱등 / END_SESSION 후 session null / v33 마이그레이션 왕복 / NaN 가드.
