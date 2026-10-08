export const dynamic = 'force-dynamic';
export const maxDuration = 60;

import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import type { ActingOperator } from '@/lib/actor';
import { dispatchTenantJobs, TENANT_JOBS } from '@/lib/services/crons';
import { refreshAllSnapshots } from '@/lib/services/license';

/* Único disparador de tareas periódicas (lo llama un cron de GitHub o de Vercel con PANEL_CRON_SECRET):
 *   GET /api/cron/dispatch?job=tenants            → tareas de cada cliente que toquen ahora (cada 5 min)
 *   GET /api/cron/dispatch?job=tenants&only=health
 *   GET /api/cron/dispatch?job=snapshots-refresh  → vuelve a publicar los registros (a diario; si no, la licencia deja de avanzar)
 * Esta ruta se autentica sola (no hay sesión de operador): sin el secreto, 401. */

const actor: ActingOperator = { id: 'cron', email: 'cron@panel', role: 'SUPERADMIN', ip: null, userAgent: 'cron' };

function authorized(request: Request): boolean {
  const secret = process.env.PANEL_CRON_SECRET;
  if (!secret || secret.length < 24) return false;
  const given = request.headers.get('authorization') ?? '';
  const digest = (v: string) => crypto.createHash('sha256').update(v).digest();
  return crypto.timingSafeEqual(digest(given), digest(`Bearer ${secret}`));
}

export async function GET(request: Request) {
  // Sin secreto configurado se responde igual que con uno equivocado: un anónimo no averigua el estado de la configuración.
  if (!process.env.PANEL_CRON_SECRET) console.error('[GET /api/cron/dispatch] Falta PANEL_CRON_SECRET (o tiene menos de 24 caracteres)');
  if (!authorized(request)) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  const url = new URL(request.url);
  const job = url.searchParams.get('job');
  try {
    if (job === 'snapshots-refresh') {
      const { published, failed } = await refreshAllSnapshots(actor);
      return NextResponse.json({ published, failed: failed.length }, { status: failed.length ? 500 : 200 });
    }
    if (job === 'tenants') {
      const only = url.searchParams.get('only');
      if (only && !TENANT_JOBS[only]) return NextResponse.json({ error: 'Tarea desconocida' }, { status: 400 });
      const budget = Number(process.env.CRON_BUDGET_MS ?? 40_000);
      const summary = await dispatchTenantJobs({ jobs: only ? [only] : undefined, budgetMs: Number.isFinite(budget) && budget > 0 ? budget : 40_000 });
      return NextResponse.json(summary);
    }
    return NextResponse.json({ error: 'job debe ser tenants o snapshots-refresh' }, { status: 400 });
  } catch (error) {
    console.error('[GET /api/cron/dispatch]', error instanceof Error ? error.message : error);
    return NextResponse.json({ error: 'Error interno' }, { status: 500 });
  }
}
