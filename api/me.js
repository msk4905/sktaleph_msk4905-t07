// api/me.js — 현재 로그인된 사용자 확인
//   GET /api/me
//
// 로그인 안 된 상태여도 200 + { user: null }로 응답한다.
// (401로 응답하면 브라우저가 "실패한 요청"으로 콘솔에 자동으로 에러를 찍는데,
//  이 엔드포인트는 페이지 진입 시 "로그인 여부 확인" 용도로 항상 불리므로
//  실패가 아니라 정상적인 조회로 다루는 게 맞다. 자료 API들은 계속 401을 쓴다.)

import { sql, preflight, ok, methodNotAllowed, handle } from '../lib/db.js';
import { requireAuth, AuthError } from '../lib/auth.js';

export default async function handler(req, res) {
  if (preflight(req, res)) return;
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  return await handle(res, async () => {
    let userId;
    try {
      userId = await requireAuth(req);
    } catch (err) {
      if (err instanceof AuthError) return ok(res, { user: null });
      throw err;
    }

    const { rows } = await sql`SELECT id, username, created_at FROM users WHERE id = ${userId}`;
    if (rows.length === 0) return ok(res, { user: null });

    return ok(res, {
      user: { id: rows[0].id, username: rows[0].username, createdAt: rows[0].created_at },
    });
  });
}
