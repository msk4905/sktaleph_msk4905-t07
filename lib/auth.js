// lib/auth.js
// 비밀번호 해싱, 세션 토큰(JWT) 발급/검증, httpOnly 쿠키 입출력을 한 곳에 모은다.
// 이 파일이 다루는 값(평문 비밀번호, JWT_SECRET, 토큰 원문)은 로그로 남기지 않는다.

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { sql } from '@vercel/postgres';

const COOKIE_NAME = 'session';
const TOKEN_TTL_SECONDS = 60 * 60 * 2; // 2시간 뒤 자동 만료
const BCRYPT_ROUNDS = 12;

function getSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.trim() === '') {
    throw new Error('JWT_SECRET 환경변수가 설정되지 않았습니다.');
  }
  return secret;
}

// ------------------------------------------------------------
// 비밀번호
// ------------------------------------------------------------
export async function hashPassword(plain) {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

// ------------------------------------------------------------
// 세션 토큰(JWT)
// ------------------------------------------------------------
export function signToken(payload) {
  return jwt.sign(payload, getSecret(), { expiresIn: TOKEN_TTL_SECONDS });
}

/** 유효하지 않거나 만료된 토큰이면 던진다. */
export function verifyToken(token) {
  return jwt.verify(token, getSecret());
}

export function tokenTtlSeconds() {
  return TOKEN_TTL_SECONDS;
}

// ------------------------------------------------------------
// 쿠키
// ------------------------------------------------------------
function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

function cookieAttrs(extra) {
  return ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', ...extra].join('; ');
}

export function setSessionCookie(res, token) {
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${token}; ${cookieAttrs([`Max-Age=${TOKEN_TTL_SECONDS}`])}`
  );
}

export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; ${cookieAttrs(['Max-Age=0'])}`);
}

// ------------------------------------------------------------
// 인증 확인
// ------------------------------------------------------------
export class AuthError extends Error {
  constructor(message = '로그인이 필요합니다.') {
    super(message);
    this.name = 'AuthError';
  }
}

/**
 * 요청에 담긴 세션 쿠키를 확인해 사용자 id를 돌려준다.
 * 쿠키가 없거나, 서명이 틀리거나, 만료됐거나, 로그아웃 이후 발급된 새 버전과
 * 맞지 않으면(= 로그아웃 전에 빼돌린 값이면) AuthError를 던진다.
 */
export async function requireAuth(req) {
  const cookies = parseCookies(req);
  const token = cookies[COOKIE_NAME];
  if (!token) throw new AuthError();

  let payload;
  try {
    payload = verifyToken(token);
  } catch {
    throw new AuthError('세션이 만료되었거나 올바르지 않습니다.');
  }
  if (!payload || typeof payload.userId !== 'string' || typeof payload.tokenVersion !== 'number') {
    throw new AuthError('세션 값이 올바르지 않습니다.');
  }

  const { rows } = await sql`SELECT token_version FROM users WHERE id = ${payload.userId}`;
  if (rows.length === 0) {
    throw new AuthError('사용자를 찾을 수 없습니다.');
  }
  if (rows[0].token_version !== payload.tokenVersion) {
    throw new AuthError('로그아웃된 세션입니다. 다시 로그인해 주세요.');
  }

  return payload.userId;
}

/** 로그아웃: 이 사용자에게 지금까지 발급된 모든 토큰을 한 번에 무효화한다. */
export async function invalidateSessions(userId) {
  await sql`UPDATE users SET token_version = token_version + 1 WHERE id = ${userId}`;
}
