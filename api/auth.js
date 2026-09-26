// api/auth.js — 가입 · 로그인 · 로그아웃
//   POST /api/auth?action=signup   { username, password }
//   POST /api/auth?action=login    { username, password }
//   POST /api/auth?action=logout

import {
  sql, preflight, ok, fail, methodNotAllowed, handle,
  newId, requireText, readBody, ValidationError,
} from '../lib/db.js';
import { hashPassword, verifyPassword, signToken, setSessionCookie, clearSessionCookie, requireAuth, invalidateSessions } from '../lib/auth.js';

// 아이디가 없을 때와 비밀번호만 틀렸을 때의 안내 문구를 하나로 통일한다.
const LOGIN_FAIL_MESSAGE = '아이디 또는 비밀번호가 올바르지 않습니다.';

export default async function handler(req, res) {
  if (preflight(req, res)) return;
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  const action = req.query.action;
  return await handle(res, async () => {
    if (action === 'signup') return await signup(req, res);
    if (action === 'login') return await login(req, res);
    if (action === 'logout') return await logout(req, res);
    throw new ValidationError('action 값은 signup, login, logout 중 하나여야 합니다.');
  });
}

// ------------------------------------------------------------
// 가입
// ------------------------------------------------------------
async function signup(req, res) {
  const body = readBody(req);
  const { username, password } = normalizeCredentials(body);

  if (password.length < 8) {
    throw new ValidationError('비밀번호는 8자 이상이어야 합니다.');
  }

  const { rows: existing } = await sql`SELECT id FROM users WHERE username = ${username}`;
  if (existing.length > 0) {
    throw new ValidationError('이미 사용 중인 아이디입니다.');
  }

  const id = newId('user');
  const passwordHash = await hashPassword(password);
  await sql`
    INSERT INTO users (id, username, password_hash)
    VALUES (${id}, ${username}, ${passwordHash})
  `;

  const token = signToken({ userId: id, tokenVersion: 0 });
  setSessionCookie(res, token);
  return ok(res, { user: { id, username } }, 201);
}

// ------------------------------------------------------------
// 로그인
// ------------------------------------------------------------
async function login(req, res) {
  const body = readBody(req);
  const { username, password } = normalizeCredentials(body);

  const { rows } = await sql`SELECT id, password_hash, token_version FROM users WHERE username = ${username}`;
  if (rows.length === 0) {
    return fail(res, 401, 'INVALID_CREDENTIALS', LOGIN_FAIL_MESSAGE);
  }

  const match = await verifyPassword(password, rows[0].password_hash);
  if (!match) {
    return fail(res, 401, 'INVALID_CREDENTIALS', LOGIN_FAIL_MESSAGE);
  }

  const token = signToken({ userId: rows[0].id, tokenVersion: rows[0].token_version });
  setSessionCookie(res, token);
  return ok(res, { user: { id: rows[0].id, username } });
}

// ------------------------------------------------------------
// 로그아웃
// ------------------------------------------------------------
async function logout(req, res) {
  // 이미 만료·손상된 세션으로 로그아웃을 눌러도 쿠키 삭제 자체는 항상 성공해야 한다.
  try {
    const userId = await requireAuth(req);
    await invalidateSessions(userId);
  } catch {
    /* 이미 유효하지 않은 세션이면 무효화할 대상이 없다 — 무시하고 쿠키만 지운다 */
  }
  clearSessionCookie(res);
  return ok(res, { loggedOut: true });
}

// ------------------------------------------------------------
// 공통 검증
// ------------------------------------------------------------
function normalizeCredentials(body) {
  const username = requireText(body.username, '아이디', 60).toLowerCase();
  const password = requireText(body.password, '비밀번호', 200);
  if (!/^[a-z0-9_.-]{3,60}$/.test(username)) {
    throw new ValidationError('아이디는 영문 소문자·숫자·_.- 조합 3자 이상이어야 합니다.');
  }
  return { username, password };
}
