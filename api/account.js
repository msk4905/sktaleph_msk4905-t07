// api/account.js — 계정 삭제
//   DELETE /api/account
//
// users 행을 지우면 plans.user_id 의 외래키(ON DELETE CASCADE 미설정)가 막을 수 있으므로
// 자료를 먼저 지우고 사용자 행을 지운다. 순서: task_logs → tasks → plan_history → retrospectives
// → plans → users. 트랜잭션으로 묶어 중간에 실패하면 전부 되돌린다.

import { sql, preflight, ok, methodNotAllowed, handle } from '../lib/db.js';
import { requireAuth, clearSessionCookie } from '../lib/auth.js';

export default async function handler(req, res) {
  if (preflight(req, res)) return;
  if (req.method !== 'DELETE') return methodNotAllowed(res, ['DELETE']);

  return await handle(res, async () => {
    const userId = await requireAuth(req);
    await deleteAccount(userId);
    clearSessionCookie(res);
    return ok(res, { deleted: true });
  });
}

async function deleteAccount(userId) {
  // @vercel/postgres 공식 문서의 트랜잭션 방식: sql.connect()로 얻은 client에서
  // BEGIN/COMMIT/ROLLBACK은 client.query, 실제 문장은 client.sql 태그드 템플릿을 쓴다.
  const client = await sql.connect();
  try {
    await client.query('BEGIN');

    await client.sql`
      DELETE FROM task_logs
      WHERE task_id IN (
        SELECT id FROM tasks WHERE plan_id IN (SELECT id FROM plans WHERE user_id = ${userId})
      )
    `;
    await client.sql`
      DELETE FROM tasks WHERE plan_id IN (SELECT id FROM plans WHERE user_id = ${userId})
    `;
    await client.sql`
      DELETE FROM plan_history WHERE plan_id IN (SELECT id FROM plans WHERE user_id = ${userId})
    `;
    await client.sql`
      DELETE FROM retrospectives WHERE plan_id IN (SELECT id FROM plans WHERE user_id = ${userId})
    `;
    await client.sql`DELETE FROM plans WHERE user_id = ${userId}`;
    await client.sql`DELETE FROM users WHERE id = ${userId}`;

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
