// api/export.js — 내 자료 전체를 파일 하나로 내보내기
//   GET /api/export
//
// 화면의 "데이터 백업" 버튼이 이 응답을 그대로 .json 파일로 저장한다.
// soft delete 된 행도 포함해 전체 상태를 그대로 내보내지만, 항상 로그인한
// 사용자 본인의 자료로만 한정한다.

import { sql } from '@vercel/postgres';
import { preflight, ok, methodNotAllowed, handle } from '../lib/db.js';
import { requireAuth } from '../lib/auth.js';

export default async function handler(req, res) {
  if (preflight(req, res)) return;

  return await handle(res, async () => {
    if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
    const userId = await requireAuth(req);
    return await exportAll(res, userId);
  });
}

async function exportAll(res, userId) {
  const [plans, planHistory, tasks, taskLogs, retrospectives] = await Promise.all([
    sql`SELECT * FROM plans WHERE user_id = ${userId} ORDER BY created_at ASC`,
    sql`
      SELECT * FROM plan_history
      WHERE plan_id IN (SELECT id FROM plans WHERE user_id = ${userId})
      ORDER BY plan_id ASC, recorded_at ASC
    `,
    sql`
      SELECT * FROM tasks
      WHERE plan_id IN (SELECT id FROM plans WHERE user_id = ${userId})
      ORDER BY created_at ASC
    `,
    sql`
      SELECT * FROM task_logs
      WHERE task_id IN (
        SELECT id FROM tasks WHERE plan_id IN (SELECT id FROM plans WHERE user_id = ${userId})
      )
      ORDER BY created_at ASC
    `,
    sql`
      SELECT * FROM retrospectives
      WHERE plan_id IN (SELECT id FROM plans WHERE user_id = ${userId})
      ORDER BY created_at ASC
    `,
  ]);

  return ok(res, {
    exportedAt: new Date().toISOString(),
    schemaVersion: '3.0.0',
    plans: plans.rows.map(mapPlan),
    planHistory: planHistory.rows.map(mapPlanHistory),
    tasks: tasks.rows.map(mapTask),
    taskLogs: taskLogs.rows.map(mapTaskLog),
    retrospectives: retrospectives.rows.map(mapRetro),
  });
}

function toDateString(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  return new Date(v).toISOString().slice(0, 10);
}

function mapPlan(r) {
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
    deletedAt: r.deleted_at,
  };
}

function mapPlanHistory(r) {
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

function mapTask(r) {
  return {
    id: r.id,
    planId: r.plan_id,
    content: r.content,
    dueDate: toDateString(r.due_date),
    priority: r.priority,
    tags: r.tags ?? [],
    estimatedHours: Number(r.estimated_hours),
    isCompleted: r.is_completed,
    completedAt: r.completed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at,
  };
}

function mapTaskLog(r) {
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

function mapRetro(r) {
  return {
    id: r.id,
    planId: r.plan_id,
    periodStart: toDateString(r.period_start),
    periodEnd: toDateString(r.period_end),
    status: r.status,
    reflection: r.reflection,
    nextActionItem: r.next_action_item,
    carriedToPlanId: r.carried_to_plan_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
