// api/task-logs.js — 실행 기록(Do)
//   GET  /api/task-logs?taskId=      그 할 일의 실행 기록 목록
//   POST /api/task-logs              실행 기록 생성 (idempotencyKey 필수)
//
// 소유권: task_logs 는 직접 user_id 를 갖지 않는다. task_id → plan_id → user_id
// 경로로 소유 여부를 서브쿼리로 확인한다.
//
// 중복 방지: idempotency_key 에 UNIQUE 제약이 걸려 있어 같은 키로 두 번 INSERT 하면
// 두 번째는 DB가 거부한다. 여기서는 그 UNIQUE 위반을 잡아 "중복" 응답으로 바꿔 준다.

import { sql } from '@vercel/postgres';
import {
  preflight, ok, fail, methodNotAllowed, handle,
  newId, isTimestampString, requireNonNegativeNumber, readBody, ValidationError,
} from '../lib/db.js';
import { requireAuth } from '../lib/auth.js';

export default async function handler(req, res) {
  if (preflight(req, res)) return;

  return await handle(res, async () => {
    const userId = await requireAuth(req);
    switch (req.method) {
      case 'GET':    return await getLogs(req, res, userId);
      case 'POST':   return await createLog(req, res, userId);
      case 'PATCH':  return await updateLog(req, res, userId);
      case 'DELETE': return await deleteLog(req, res, userId);
      default:       return methodNotAllowed(res, ['GET', 'POST', 'PATCH', 'DELETE']);
    }
  });
}

// ------------------------------------------------------------
// GET
// ------------------------------------------------------------
async function getLogs(req, res, userId) {
  const taskId = req.query.taskId;
  if (!taskId) throw new ValidationError('taskId 가 필요합니다.');

  const { rows: task } = await sql`
    SELECT id FROM tasks
    WHERE id = ${taskId} AND plan_id IN (SELECT id FROM plans WHERE user_id = ${userId})
  `;
  if (task.length === 0) {
    return fail(res, 404, 'TASK_NOT_FOUND', '그 할 일을 찾을 수 없습니다.');
  }

  const { rows } = await sql`
    SELECT * FROM task_logs
    WHERE task_id = ${taskId}
    ORDER BY started_at DESC, created_at DESC
  `;
  return ok(res, { taskId, logs: rows.map(mapLogRow) });
}

// ------------------------------------------------------------
// POST — 생성
// ------------------------------------------------------------
async function createLog(req, res, userId) {
  const body = readBody(req);
  const f = validateLogFields(body);

  const { rows: task } = await sql`
    SELECT id FROM tasks
    WHERE id = ${f.taskId} AND deleted_at IS NULL
      AND plan_id IN (SELECT id FROM plans WHERE user_id = ${userId})
  `;
  if (task.length === 0) {
    return fail(res, 404, 'TASK_NOT_FOUND', '그 할 일을 찾을 수 없습니다.');
  }

  const { rows: existing } = await sql`
    SELECT * FROM task_logs WHERE idempotency_key = ${f.idempotencyKey}
  `;
  if (existing.length > 0) {
    return ok(res, { log: mapLogRow(existing[0]), duplicate: true });
  }

  const id = newId('log');
  try {
    await sql`
      INSERT INTO task_logs (id, task_id, content, started_at, ended_at, actual_hours, blocker_reason, idempotency_key)
      VALUES (${id}, ${f.taskId}, ${f.content}, ${f.startedAt}, ${f.endedAt}, ${f.actualHours}, ${f.blockerReason}, ${f.idempotencyKey})
    `;
  } catch (err) {
    if (isUniqueViolation(err)) {
      const { rows: again } = await sql`
        SELECT * FROM task_logs WHERE idempotency_key = ${f.idempotencyKey}
      `;
      if (again.length > 0) return ok(res, { log: mapLogRow(again[0]), duplicate: true });
    }
    throw err;
  }

  const { rows } = await sql`SELECT * FROM task_logs WHERE id = ${id}`;
  return ok(res, { log: mapLogRow(rows[0]), duplicate: false }, 201);
}

function isUniqueViolation(err) {
  return err && err.code === '23505';
}

// ------------------------------------------------------------
// PATCH — 수정
// ------------------------------------------------------------
async function updateLog(req, res, userId) {
  const id = req.query.id;
  if (!id) throw new ValidationError('수정할 실행 기록의 id 가 필요합니다.');

  const body = readBody(req);
  const f = validateLogFields(body, { requireTaskId: false });

  const { rows: current } = await sql`
    SELECT * FROM task_logs
    WHERE id = ${id}
      AND task_id IN (
        SELECT id FROM tasks WHERE plan_id IN (SELECT id FROM plans WHERE user_id = ${userId})
      )
  `;
  if (current.length === 0) {
    return fail(res, 404, 'LOG_NOT_FOUND', '그 실행 기록을 찾을 수 없습니다.');
  }

  await sql`
    UPDATE task_logs
    SET content = ${f.content},
        started_at = ${f.startedAt},
        ended_at = ${f.endedAt},
        actual_hours = ${f.actualHours},
        blocker_reason = ${f.blockerReason}
    WHERE id = ${id}
  `;

  const { rows } = await sql`SELECT * FROM task_logs WHERE id = ${id}`;
  return ok(res, { log: mapLogRow(rows[0]) });
}

// ------------------------------------------------------------
// DELETE — 삭제
// ------------------------------------------------------------
async function deleteLog(req, res, userId) {
  const id = req.query.id;
  if (!id) throw new ValidationError('삭제할 실행 기록의 id 가 필요합니다.');

  const { rowCount } = await sql`
    DELETE FROM task_logs
    WHERE id = ${id}
      AND task_id IN (
        SELECT id FROM tasks WHERE plan_id IN (SELECT id FROM plans WHERE user_id = ${userId})
      )
  `;
  if (rowCount === 0) {
    return fail(res, 404, 'LOG_NOT_FOUND', '그 실행 기록을 찾을 수 없거나 이미 지워졌습니다.');
  }
  return ok(res, { deleted: true, id });
}

// ------------------------------------------------------------
// 검증 / 매핑
// ------------------------------------------------------------
function validateLogFields(body, opts = {}) {
  const requireTaskId = opts.requireTaskId !== false;
  if (requireTaskId && (typeof body.taskId !== 'string' || body.taskId.trim() === '')) {
    throw new ValidationError('taskId 가 필요합니다.');
  }

  const contentRaw = body.content;
  const content =
    typeof contentRaw === 'string' && contentRaw.trim() !== ''
      ? contentRaw.trim().slice(0, 2000)
      : null;

  if (!isTimestampString(body.startedAt)) {
    throw new ValidationError('시작 시각(startedAt)이 올바르지 않습니다.');
  }
  if (!isTimestampString(body.endedAt)) {
    throw new ValidationError('끝난 시각(endedAt)이 올바르지 않습니다.');
  }
  if (new Date(body.endedAt) < new Date(body.startedAt)) {
    throw new ValidationError('끝난 시각은 시작 시각보다 앞설 수 없습니다.');
  }

  const CLOCK_SKEW_MS = 5 * 60 * 1000;
  const nowWithSkew = Date.now() + CLOCK_SKEW_MS;
  if (new Date(body.startedAt).getTime() > nowWithSkew) {
    throw new ValidationError('시작 시각은 지금보다 미래일 수 없습니다.');
  }
  if (new Date(body.endedAt).getTime() > nowWithSkew) {
    throw new ValidationError('끝난 시각은 지금보다 미래일 수 없습니다.');
  }
  const actualHours = requireNonNegativeNumber(body.actualHours ?? 0, '실제로 걸린 시간');

  const blockerReasonRaw = body.blockerReason;
  const blockerReason =
    typeof blockerReasonRaw === 'string' && blockerReasonRaw.trim() !== ''
      ? blockerReasonRaw.trim().slice(0, 1000)
      : null;

  let idempotencyKey = body.idempotencyKey;
  if (typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') {
    idempotencyKey = newId('auto-key');
  }

  return {
    taskId: typeof body.taskId === 'string' ? body.taskId.trim() : null,
    content,
    startedAt: new Date(body.startedAt).toISOString(),
    endedAt: new Date(body.endedAt).toISOString(),
    actualHours,
    blockerReason,
    idempotencyKey: idempotencyKey.trim().slice(0, 200),
  };
}

function mapLogRow(r) {
  return {
    id: r.id,
    taskId: r.task_id,
    content: r.content ?? null,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    actualHours: Number(r.actual_hours),
    blockerReason: r.blocker_reason,
    idempotencyKey: r.idempotency_key,
    createdAt: r.created_at,
  };
}
