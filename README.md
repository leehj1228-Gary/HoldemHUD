# Poker Tracker (HoldemHUD)

라이브 캐시 게임용 프리플랍 포커 트래커 / HUD입니다. React 19 + Vite로 만들어졌고, 웹 · Android(Capacitor) · Windows(Electron)를 지원합니다.

> **v2 리빌드**: 2026-07에 코어를 전면 재작성했습니다. 통계는 항상 핸드 기록에서 파생되고(단일 통계 엔진), 상태는 단일 리듀서로 관리되며, 진행 중인 세션이 자동 저장됩니다. 설계 계약은 [docs/REBUILD_DESIGN.md](docs/REBUILD_DESIGN.md) 참고.

## 주요 기능

- **라이브 HUD**: 좌석별 VPIP / PFR / 3Bet% / ATS / Fold to 3Bet / Open Limp / Cold Call 등 실시간 집계 (전부 기회 기반 분모)
- **핸드 기록**: 프리플랍 액션 시퀀스(Fold/Check/Call/Raise, 레이즈 레벨) + 포지션 자동 계산 (스트래들, Sit Out, 헤즈업 규칙 지원)
- **실행 취소**: 핸드 경계를 넘는 undo — 자동 다음핸드로 넘어간 뒤에도 마지막 액션 교정 가능
- **자동 저장**: 진행 중 세션이 localStorage에 자동 저장 — 앱이 꺼져도 이어하기 가능
- **세션 히스토리**: 세션별 핸드 리플레이 + 플레이어별 통계
- **플레이어 프로필**: 세션 통합 통계 + 스타일 분류 (GTO/TAG/LAG/Nit/Station/Maniac)
- **AI 코치 (Gemini / ChatGPT / Claude)**: 테이블 분석(169콤보 추천 레인지 차트), 세션 프리플랍 리크 분석 — 프로바이더 선택 가능

## 시작하기

```bash
npm install
npm run dev        # http://localhost:5173
```

### 테스트 / 빌드

```bash
npm test           # vitest — 엔진/리듀서/스토리지 유닛 테스트
npm run build      # 프로덕션 번들 (dist/)
npm run lint
```

### AI 코치 설정

AI 프로바이더와 API 키는 **앱 안에서** 설정합니다: 홈 화면 → `⚙️ 설정` → 프로바이더 선택(Gemini / ChatGPT / Claude) → API 키 입력.
키는 사용 중인 기기의 localStorage에만 저장되며, 코드나 빌드 산출물에 포함되지 않습니다.

| 프로바이더 | 기본 모델 | 키 발급 |
|---|---|---|
| Gemini | `gemini-3-pro-preview` | [Google AI Studio](https://aistudio.google.com/apikey) |
| ChatGPT (OpenAI) | `gpt-5.1` | [OpenAI Platform](https://platform.openai.com/api-keys) |
| Claude (Anthropic) | `claude-opus-4-8` | [Claude Console](https://platform.claude.com/) |

모델명은 설정에서 자유롭게 변경할 수 있습니다 (비워두면 기본 모델 사용).

### Android (Capacitor)

```bash
npm run build
npx cap sync android
npx cap open android   # Android Studio에서 실행/빌드
```

### Windows (Electron)

```bash
npm run electron:dev     # 개발 모드
npm run electron:build   # NSIS 인스톨러 (dist_electron/)
```

## 아키텍처

```
src/
  engine/      # 순수 로직 (React 의존성 없음)
    schema.js        # 데이터 스키마 v1 (핸드/세션 레코드)
    handEngine.js    # 핸드 상태 머신 — 포지션, 액션 순서, 합법 액션, 종료 판정
    statsEngine.js   # 유일한 통계 구현 — 핸드 기록 리플레이로 모든 스탯 파생
    archetypes.js    # 플레이어 스타일 분류
  storage/     # 버전드 영속화 + 구버전(v33) 데이터 마이그레이션
  state/       # 단일 useReducer 원자 상태 + 얇은 컨텍스트
  services/    # Gemini API 클라이언트
  components/  # 화면 (home/game/history/profile/coach)
tests/         # vitest 유닛 테스트
```

핵심 설계 원칙: **통계는 절대 증분 카운터로 관리하지 않는다.** 모든 스탯은 저장된 핸드 기록을 리플레이해서 계산하므로, 라이브 HUD·세션 상세·프로필이 항상 같은 값을 보여준다. undo도 액션 배열에서 마지막 항목을 제거하는 것만으로 완결된다.

## 데이터

- 저장 위치: 브라우저/WebView localStorage (`hh:v1:state`, `hh:v1:archive`)
- 구버전(`poker_*_v33`) 데이터는 첫 실행 시 자동 마이그레이션 (원본은 보존)
- 전체 초기화: 게임 화면 → 📊 통계 → ⚠️ 데이터 초기화
