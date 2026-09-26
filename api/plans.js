// api/plans.js — 계획(Plan)
//   GET    /api/plans                 내 계획 목록
//   GET    /api/plans?id=&history=1   그 계획의 수정 이력
//   POST   /api/plans                 계획 생성 (fromRetrospectiveId 로 고칠 점 이어받기)
//   PATCH  /api/plans?id=             계획 수정 — 수정 전 값을 plan_history 에 남긴다
//   DELETE /api/plans?id=             계획 삭제 (soft delete)
//
// 모든 조회·수정·삭제는 로그인한 사용자 소유의 행으로 한정한다.
// 다른 사용자의 id를 넣어도 WHERE 절의 user_id 조건에서 걸러져 404로 응답한다.

import {
  sql, preflight, ok, fail, methodNotAllowed, handle,
  newId, isDateString, isPriority, requireText, requireNonNegativeNumber,
  readBody, ValidationError,
} from '../lib/db.js';
import { requireAuth } from '../lib/auth.js';

export default async function handler(req, res) {
  if (preflight(req, res)) return;

  return await handle(res, async () => {
    const userId = await requireAuth(req);
    switch (req.method) {
      case 'GET':    return await getPlans(req, res, userId);
      case 'POST':   return await createPlan(req, res, userId);
      case 'PATCH':  return await updatePlan(req, res, userId);
      case 'DELETE': return await deletePlan(req, res, userId);
      default:       return methodNotAllowed(res, ['GET', 'POST', 'PATCH', 'DELETE']);
    }
  });
}

// ------------------------------------------------------------
// GET
// ------------------------------------------------------------
async function getPlans(req, res, userId) {
  const { id, history } = req.query;

  // 수정 이력 조회 — 이력도 그 계획이 내 것일 때만 보인다.
  if (id && history) {
    const { rows: owned } = await sql`
      SELECT id FROM plans WHERE id = ${id} AND user_id = ${userId}
    `;
    if (owned.length === 0) {
      return fail(res, 404, 'PLAN_NOT_FOUND', '그 계획을 찾을 수 없습니다.');
    }
    const { rows } = await sql`
      SELECT history_id, plan_id, title, start_date, end_date, priority,
             success_criteria, estimated_hours, valid_from, recorded_at
      FROM plan_history
      WHERE plan_id = ${id}
      ORDER BY recorded_at DESC, history_id DESC
    `;
    return ok(res, { planId: id, history: rows.map(mapHistoryRow) });
  }

  // 단건 조회
  if (id) {
    const { rows } = await sql`
      SELECT * FROM plans WHERE id = ${id} AND user_id = ${userId} AND deleted_at IS NULL
    `;
    if (rows.length === 0) {
      return fail(res, 404, 'PLAN_NOT_FOUND', '그 계획을 찾을 수 없습니다.');
    }
    return ok(res, { plan: mapPlanRow(rows[0]) });
  }

  // 목록 조회 — 계획마다 딸린 할 일 수를 함께 준다.
  const { rows } = await sql`
    SELECT p.*,
           COALESCE(t.task_count, 0)      AS task_count,
           COALESCE(t.completed_count, 0) AS completed_count,
           r.next_action_item             AS carried_from_action_item
    FROM plans p
    LEFT JOIN (
      SELECT plan_id,
             COUNT(*)                                        AS task_count,
             COUNT(*) FILTER (WHERE is_completed)            AS completed_count
      FROM tasks
      WHERE deleted_at IS NULL
      GROUP BY plan_id
    ) t ON t.plan_id = p.id
    LEFT JOIN retrospectives r ON r.carried_to_plan_id = p.id
    WHERE p.user_id = ${userId} AND p.deleted_at IS NULL
    ORDER BY p.created_at DESC
  `;

  return ok(res, {
    plans: rows.map((r) => ({
      ...mapPlanRow(r),
      taskCount: Number(r.task_count),
      completedCount: Number(r.completed_count),
      carriedFromActionItem: r.carried_from_action_item ?? null,
    })),
  });
}

// ------------------------------------------------------------
// POST — 생성
// ------------------------------------------------------------
async function createPlan(req, res, userId) {
  const body = readBody(req);
  const fields = validatePlanFields(body);
  const id = newId('plan');

  await sql`
    INSERT INTO plans (id, user_id, title, content, start_date, end_date, priority, success_criteria, estimated_hours)
    VALUES (${id}, ${userId}, ${fields.title}, ${fields.content}, ${fields.startDate}, ${fields.endDate},
            ${fields.priority}, ${fields.successCriteria}, ${fields.estimatedHours})
  `;

  // 돌아보기의 고칠 점을 이어받아 만든 계획이면, 그 회고에 연결을 남긴다.
  // 이어받는 회고도 내 소유일 때만 인정한다.
  const fromRetroId = body.fromRetrospectiveId;
  if (typeof fromRetroId === 'string' && fromRetroId.trim() !== '') {
    const { rowCount } = await sql`
      UPDATE retrospectives
      SET carried_to_plan_id = ${id}, updated_at = now()
      WHERE id = ${fromRetroId}
        AND carried_to_plan_id IS NULL
        AND plan_id IN (SELECT id FROM plans WHERE user_id = ${userId})
    `;
    if (rowCount === 0) {
      const { rows } = await sql`SELECT * FROM plans WHERE id = ${id}`;
      return ok(res, {
        plan: mapPlanRow(rows[0]),
        warning: '고칠 점을 이어받지 못했습니다. 이미 다음 계획으로 넘어갔거나 없는 돌아보기입니다.',
      }, 201);
    }
  }

  const { rows } = await sql`SELECT * FROM plans WHERE id = ${id}`;
  return ok(res, { plan: mapPlanRow(rows[0]) }, 201);
}

// ------------------------------------------------------------
// PATCH — 수정 (수정 전 값을 이력으로 보존)
// ------------------------------------------------------------
async function updatePlan(req, res, userId) {
  const id = req.query.id;
  if (!id) throw new ValidationError('수정할 계획의 id 가 필요합니다.');

  const body = readBody(req);
  const fields = validatePlanFields(body);

  const { rows: current } = await sql`
    SELECT * FROM plans WHERE id = ${id} AND user_id = ${userId} AND deleted_at IS NULL
  `;
  if (current.length === 0) {
    return fail(res, 404, 'PLAN_NOT_FOUND', '그 계획을 찾을 수 없습니다.');
  }
  const before = current[0];

  await sql`
    INSERT INTO plan_history
      (plan_id, title, content, start_date, end_date, priority, success_criteria, estimated_hours, valid_from)
    VALUES
      (${before.id}, ${before.title}, ${before.content}, ${before.start_date}, ${before.end_date},
       ${before.priority}, ${before.success_criteria}, ${before.estimated_hours}, ${before.updated_at})
  `;

  await sql`
    UPDATE plans
    SET title = ${fields.title},
        content = ${fields.content},
        start_date = ${fields.startDate},
        end_date = ${fields.endDate},
        priority = ${fields.priority},
        success_criteria = ${fields.successCriteria},
        estimated_hours = ${fields.estimatedHours},
        updated_at = now()
    WHERE id = ${id} AND user_id = ${userId}
  `;

  const { rows } = await sql`SELECT * FROM plans WHERE id = ${id}`;
  const { rows: histCount } = await sql`
    SELECT COUNT(*)::int AS n FROM plan_history WHERE plan_id = ${id}
  `;

  return ok(res, {
    plan: mapPlanRow(rows[0]),
    historyCount: histCount[0].n,
  });
}

// ------------------------------------------------------------
// DELETE — soft delete
// ------------------------------------------------------------
async function deletePlan(req, res, userId) {
  const id = req.query.id;
  if (!id) throw new ValidationError('삭제할 계획의 id 가 필요합니다.');

  const { rowCount } = await sql`
    UPDATE plans SET deleted_at = now(), updated_at = now()
    WHERE id = ${id} AND user_id = ${userId} AND deleted_at IS NULL
  `;
  if (rowCount === 0) {
    return fail(res, 404, 'PLAN_NOT_FOUND', '그 계획을 찾을 수 없거나 이미 지워졌습니다.');
  }

  await sql`
    UPDATE tasks SET deleted_at = now(), updated_at = now()
    WHERE plan_id = ${id} AND deleted_at IS NULL
  `;

  return ok(res, { deleted: true, id });
}

// ------------------------------------------------------------
// 검증 / 매핑
// ------------------------------------------------------------
function validatePlanFields(body) {
  const title = requireText(body.title, '계획 제목', 200);

  const contentRaw = body.content;
  const content =
    typeof contentRaw === 'string' && contentRaw.trim() !== ''
      ? contentRaw.trim().slice(0, 4000)
      : null;

  const successCriteria = requireText(body.successCriteria, '성공 기준', 1000);

  const startDate = body.startDate;
  const endDate = body.endDate;
  if (!isDateString(startDate)) throw new ValidationError('시작일을 YYYY-MM-DD 형식으로 입력해 주세요.');
  if (!isDateString(endDate))   throw new ValidationError('종료일을 YYYY-MM-DD 형식으로 입력해 주세요.');
  if (endDate < startDate)      throw new ValidationError('종료일은 시작일과 같거나 그 뒤여야 합니다.');

  const priority = body.priority ?? 'MEDIUM';
  if (!isPriority(priority)) throw new ValidationError('우선순위는 HIGH, MEDIUM, LOW 중 하나여야 합니다.');

  const estimatedHours = requireNonNegativeNumber(body.estimatedHours ?? 0, '예상 시간');

  return { title, content, startDate, endDate, priority, successCriteria, estimatedHours };
}

function mapPlanRow(r) {
  return {
    id: r.id,
    title: r.title,
    content: r.content ?? null,
    startDate: toDateString(r.start_date),
    endDate: toDateString(r.end_date),
    priority: r.priority,
    successCriteria: r.success_criteria,
    estimatedHours: Number(r.estimated_hours),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapHistoryRow(r) {
  return {
    historyId: Number(r.history_id),
    planId: r.plan_id,
    title: r.title,
    content: r.content ?? null,
    startDate: toDateString(r.start_date),
    endDate: toDateString(r.end_date),
    priority: r.priority,
    successCriteria: r.success_criteria,
    estimatedHours: Number(r.estimated_hours),
    validFrom: r.valid_from,
    recordedAt: r.recorded_at,
  };
}

function toDateString(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  return new Date(v).toISOString().slice(0, 10);
}
