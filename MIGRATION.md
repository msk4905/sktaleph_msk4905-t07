# 배포 순서

## 1. 환경변수
Vercel 프로젝트 → Settings → Environment Variables 에 추가한다.

```
JWT_SECRET = (터미널에서 openssl rand -hex 32 로 생성한 값)
```
Production / Preview / Development 전부 체크한다.

## 2. 스키마 마이그레이션
Vercel Postgres(Neon) → Query 탭에서 `schema-v3-auth.sql`의 STEP 1, STEP 2만 먼저 실행한다.
(STEP 3은 아래 5번 이후에 실행한다.)

## 3. 테스트 데이터 정리
기존 DB에 남아 있는 `<script>alert(1)</script>` 태스크 3건과 `test` 태스크 1건(전부 soft delete 상태)을 지운다.

```sql
DELETE FROM tasks WHERE content = 'test' OR content LIKE '%<script>%';
```

## 4. 코드 배포
이 폴더 전체를 기존 저장소에 덮어써서 커밋·푸시한다. 겹치는 파일: `api/plans.js`, `api/tasks.js`,
`api/task-logs.js`, `api/retrospectives.js`, `api/summary.js`, `api/export.js`, `lib/db.js`,
`index.html`, `package.json`. 새로 추가되는 파일: `api/auth.js`, `api/me.js`, `api/account.js`,
`lib/auth.js`, `schema-v3-auth.sql`.

Vercel이 배포되면 `npm install`로 `bcryptjs`, `jsonwebtoken`이 자동 설치된다.

## 5. 계정 생성과 기존 자료 이관
1. 배포된 주소에서 회원가입으로 계정 하나를 만든다.
2. Neon Query 탭에서 방금 만든 계정의 id를 확인한다.
   ```sql
   SELECT id, username FROM users ORDER BY created_at DESC LIMIT 1;
   ```
3. 그 id로 기존 계획을 전부 이관한다. (아래 `<내-user-id>`를 3번에서 확인한 값으로 바꾼다)
   ```sql
   UPDATE plans SET user_id = '<내-user-id>' WHERE user_id IS NULL;
   ```
   tasks·task_logs·retrospectives는 plan_id를 통해 소유권이 정해지므로 별도 이관이 필요 없다.
4. 이관 결과를 확인한다.
   ```sql
   SELECT id, title, user_id FROM plans;
   ```

## 6. NOT NULL 확정
5번이 끝난 뒤 `schema-v3-auth.sql`의 STEP 3 주석을 풀어 실행한다.
```sql
ALTER TABLE plans ALTER COLUMN user_id SET NOT NULL;
```

## 7. 확인
- 새 시크릿 창에서 배포 주소를 열면 로그인 화면이 먼저 뜨는지
- 로그인 없이 `/api/plans`를 직접 호출하면 401이 오는지 (브라우저 주소창에 쳐서 확인 가능)
- 계정 두 개를 만들어 서로의 계획 id로 GET/PATCH/DELETE를 걸어 보고 전부 404가 오는지
- 로그아웃 후 같은 쿠키 값으로 다시 요청하면 거절되는지 (쿠키가 이미 지워지므로 직접 요청 보내려면 개발자 도구의 Network 탭에서 이전 쿠키 값을 수동으로 복사해 확인)
