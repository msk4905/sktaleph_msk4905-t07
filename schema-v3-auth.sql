-- ============================================================
-- 플랜두씨 다이어리 — 인증 스키마 추가 (v3)
-- 실행 순서: 아래 STEP 1 → 2 → 3을 번호 순서대로 Vercel Postgres Query 탭에서 실행한다.
-- STEP 3은 기존 자료를 계정에 이관한 뒤에만 실행한다 (MIGRATION.md 참고).
-- ============================================================

-- ------------------------------------------------------------
-- STEP 1. 사용자 테이블
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT        NOT NULL UNIQUE,
  password_hash TEXT        NOT NULL,
  -- 로그아웃 시 1씩 올린다. 토큰에 담긴 값과 이 값이 다르면 그 토큰은 더 이상 통하지 않는다.
  token_version INTEGER     NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- STEP 2. plans에 소유자 컬럼 추가
--   기존 행에는 값이 없으므로 우선 NULL 허용으로 추가한다.
--   tasks/task_logs/retrospectives는 plans를 거쳐 소유권을 판별하므로
--   별도 컬럼을 두지 않는다.
-- ------------------------------------------------------------
ALTER TABLE plans ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES users(id);

CREATE INDEX IF NOT EXISTS idx_plans_user_id
  ON plans (user_id) WHERE deleted_at IS NULL;

-- ------------------------------------------------------------
-- STEP 3. NOT NULL 확정 (기존 자료 이관 완료 후에만 실행)
--   이관 전에 실행하면 실패한다. MIGRATION.md의 백필 단계를 먼저 마친다.
-- ------------------------------------------------------------
-- ALTER TABLE plans ALTER COLUMN user_id SET NOT NULL;
