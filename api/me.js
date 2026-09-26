// api/me.js — 현재 로그인된 사용자 확인
//   GET /api/me

import { sql, preflight, ok, methodNotAllowed, handle } from '../lib/db.js';
import { requireAuth, AuthError } from '../lib/auth.js';

export default async function handler(req, res) {
  if (preflight(req, res)) return;
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  return await handle(res, async () => {
    const userId = await requireAuth(req);
    const { rows } = await sql`SELECT id, username, created_at FROM users WHERE id = ${userId}`;
    if (rows.length === 0) {
      throw new AuthError('사용자를 찾을 수 없습니다.');
    }
    return ok(res, {
      user: { id: rows[0].id, username: rows[0].username, createdAt: rows[0].created_at },
    });
  });
}
