# Gather

소규모 모임의 **참석 확인 · 공지 · 비용 정산 · 카풀**을 하나의 이벤트 단위로 묶은 웹 앱.

## 왜 만들었나

동아리 MT나 팀 워크숍을 준비할 때 참석 확인은 단톡방, 정산은 정산 앱, 카풀은 댓글로 흩어진다.
정보가 세 곳에 나뉘면 "누가 오는지"와 "누가 얼마 내는지"가 서로 어긋난다.
Gather는 **참석 확정(RSVP)을 정산과 카풀의 기준 데이터로 삼아** 이 불일치를 없애는 것을 목표로 한다.
비용은 `rsvp = 'attending'` 인 멤버만 대상으로 n등분되고, 카풀 좌석도 같은 멤버 집합 안에서 배정된다.

## 기능

| 영역   | 내용                                                                                 |
| ------ | ------------------------------------------------------------------------------------ |
| 이벤트 | 생성/수정, 상태(active·cancelled·completed), 기능 토글(`has_expense`, `has_carpool`) |
| 멤버   | 역할 3종(host / co_host / member), RSVP 3종(pending / attending / declined)          |
| 초대   | 만료 기한(7일) 있는 토큰 링크 초대                                                   |
| 공지   | host·co_host 작성, 멤버 조회                                                         |
| 정산   | 참석자 n등분 → 순잔액 기반 이체 목록 산출, 개별 정산 완료 처리                       |
| 카풀   | 운전자 좌석 등록(1~8석), 탑승 신청 및 운전자 승인/거절                               |
| 관리자 | 전체 이벤트·사용자 조회, KPI 대시보드                                                |

## 기술 스택

- **Next.js 16.1.6** (App Router, Server Components, Server Actions)
- **React 19.2**, **TypeScript 5.9**
- **Supabase** (PostgreSQL + Auth, `@supabase/ssr` 0.8) — 이메일/비밀번호 + Google OAuth
- **Tailwind CSS 3.4** + shadcn/ui
- **Zod 4.3** + react-hook-form (입력 검증)
- ESLint / Prettier / Husky + lint-staged

## 설계 판단

### 1. 권한 검사를 RLS와 앱 레이어에 이중으로 둔 이유

`supabase/migrations/*.sql`의 RLS 정책이 최종 방어선이다. 앱을 우회한 직접 쿼리도 여기서 막힌다.
그 위에 `lib/utils/auth-check.ts`의 `requireEventRole(eventId, roles)`를 둬서, 권한이 없을 때 **빈 화면 대신 적절한 경로로 리다이렉트**되게 했다.
RLS만 있으면 권한 없는 사용자에게 "데이터가 0건인 정상 페이지"가 보여 원인 파악이 어렵고, 앱 레이어만 있으면 우회가 가능하다. 역할은 `event_members.role`을 단일 출처로 쓰고 클라이언트 값은 신뢰하지 않는다.

### 2. 정산: 저장은 분담액, 표시는 이체 목록

`expense_splits`에는 각자 **내야 할 금액**만 저장한다. "누가 누구에게 얼마"는 저장하지 않고 조회 시점에 계산한다.
비용 항목이 추가·삭제될 때마다 이체 관계를 다시 써야 하는 갱신 비용을 피하기 위해서다.

계산은 `lib/utils/expense.ts`의 `calculateSettlements()` — 사용자별 순잔액(`낸 돈 − 낼 돈`)을 구해 채권자·채무자를 각각 금액 내림차순으로 정렬한 뒤 큰 쪽부터 상계하는 그리디다.
매 단계에서 최소 한 명의 잔액이 0이 되므로 이체 건수는 최대 `n-1`건이지만, **전역 최소 이체 횟수를 보장하지는 않는다** (부분집합 상계를 탐색하지 않음). 참석자 규모(10~30명)에서는 이 차이가 실사용에 영향을 주지 않는다고 판단해 그리디를 택했다.
이 함수는 DB 호출이 없는 순수 함수로 분리했다.

### 3. 원 단위 나머지 처리

`amount`를 참석자 수로 나눌 때 나머지가 발생한다. `Math.floor`로 균등 분배 후 남은 원을 첫 번째 참석자에게 몰아, `분담액 합계 = 원래 금액`이 항상 성립하도록 했다 (`lib/actions/expense-actions.ts`).
1원씩 분산시키는 방식도 가능하지만, 합계 보존이 더 중요하고 규칙이 단순한 쪽을 택했다.

### 4. 모든 쓰기는 Server Action

`lib/actions/` 아래 6개 파일에 mutation을 모았다. API Route를 따로 두지 않아 클라이언트에 노출되는 엔드포인트를 줄이고, 인증 확인(`auth.getClaims()`) → Zod 검증 → 쿼리 → `revalidatePath()` 순서를 모든 액션에서 동일하게 유지했다.

## 구조

```text
app/
  auth/            로그인·회원가입·비밀번호 재설정·OAuth 콜백
  events/          이벤트 목록, 생성, 상세(멤버·공지·정산·카풀)
  invite/[token]/  초대 링크 수락
  admin/           관리자 대시보드
  profile/
components/        기능별 UI (events, members, expense, carpool, announcements, admin)
lib/
  actions/         Server Actions (mutation 전담)
  supabase/        서버/클라이언트/프록시 Supabase 인스턴스, 생성된 DB 타입
  utils/           정산 계산, 권한 검사(auth-check, admin-check)
  types/
supabase/migrations/  테이블 · 인덱스 · RLS 정책
docs/              PRD, 로드맵, 개발 가이드
```

## 로컬 실행

```bash
git clone https://github.com/dlaekduddlaekdud/Gather.git
cd Gather
npm install
```

`.env.local` 생성:

```env
NEXT_PUBLIC_SUPABASE_URL=<Supabase 프로젝트 URL>
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<publishable(anon) 키>
```

Supabase 프로젝트에 `supabase/migrations/` 의 SQL을 순서대로 적용한 뒤:

```bash
npm run dev      # http://localhost:3000
npm run check    # 타입체크 + 린트 + 포맷 검사
```

## 알려진 한계 / 다음 작업

포트폴리오 목적상 현재 상태를 그대로 적는다.

1. **자동화 테스트 없음.** `calculateSettlements()`는 DB 의존이 없어 단위 테스트 대상으로 적합하다. 나머지 0원/1원, 채권자 없음, 전원 동일 부담 케이스부터 작성 예정.
2. **카풀 좌석 경쟁 조건.** `joinCarpool()`이 잔여 좌석을 조회한 뒤 신청을 삽입하는 read-then-write 구조라, 동시 요청 시 정원 초과가 가능하다. `carpool_passengers` 삽입 시점에 좌석 수를 확인하는 DB 제약 또는 `SELECT ... FOR UPDATE` 기반 함수로 옮기는 것이 해법.
3. **비용 등록의 원자성.** `expenses` 삽입과 `expense_splits` 삽입이 두 번의 요청으로 나뉘어 있어, 중간 실패 시 분담 없는 비용 항목이 남는다. Postgres 함수(RPC) 하나로 묶어야 한다.
4. **스타터킷 잔여 코드.** `components/tutorial/` 등 미사용 컴포넌트가 남아 있다.
