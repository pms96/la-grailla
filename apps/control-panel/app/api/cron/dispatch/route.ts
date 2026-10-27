export const dynamic = 'force-dynamic';
export const maxDuration = 120;

import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import type { ActingOperator } from '@/lib/actor';
import { notify, sendHeartbeat } from '@/lib/services/alerts';
import { dispatchHttpStatus, dispatchTenantJobs, TENANT_JOBS } from '@/lib/services/crons';
import { refreshAllSnapshots } from '@/lib/services/license';

/* Único disparador de tareas periódicas. Lo llama Vercel Cron (apps/control-panel/vercel.json) con `Authorization: Bearer $CRON_SECRET`:
 *   GET /api/cron/dispatch?job=tenants            → tareas de cada cliente que toquen ahora (cada 5 min)
 *   GET /api/cron/dispatch?job=tenants&only=health
 *   GET /api/cron/dispatch?job=snapshots-refresh  → vuelve a publicar los registros (a diario; si no, la licencia deja de avanzar)
 * Esta ruta se autentica sola (no hay sesión de operador): sin el secreto, 401.
 *
 * Responde 500 si alguna tarea falló o si había tareas vencidas y no se lanzó ninguna: Vercel marca la ejecución como fallida y se ve en el
 * log y en el panel de crons. Un 200 con clientes en rojo hacía que el cron «pasara» mientras todo fallaba. */

const actor: ActingOperator = { id: 'cron', email: 'cron@panel', role: 'SUPERADMIN', ip: null, userAgent: 'cron' };

/** `CRON_SECRET` es el nombre que Vercel Cron usa para enviar la cabecera; `PANEL_CRON_SECRET` se acepta para llamadas manuales. Mínimo 24 caracteres. */
function validSecrets(): string[] {
  return [process.env.CRON_SECRET, process.env.PANEL_CRON_SECRET].filter((s): s is string => !!s && s.length >= 24);
}

function authorized(request: Request): boolean {
  const digest = (v: string) => crypto.createHash('sha256').update(v).digest();
  const given = digest(request.headers.get('authorization') ?? '');
  // Se comparan todos (sin cortar al primero) para no distinguir por tiempo cuál era.
  return validSecrets().reduce((ok, secret) => crypto.timingSafeEqual(given, digest(`Bearer ${secret}`)) || ok, false);
}

export async function GET(request: Request) {
  // Sin secreto configurado se responde igual que con uno equivocado: un anónimo no averigua el estado de la configuración.
  if (validSecrets().length === 0) console.error('[GET /api/cron/dispatch] Falta CRON_SECRET (o PANEL_CRON_SECRET) o tiene menos de 24 caracteres');
  if (!authorized(request)) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  const url = new URL(request.url);
  const job = url.searchParams.get('job');
  try {
    if (job === 'snapshots-refresh') {
      const { published, failed } = await refreshAllSnapshots(actor);
      if (failed.length) {
        console.error(`[cron-dispatch] snapshots-refresh: ${failed.length} clientes sin republicar`);
        // Sin este refresco diario la licencia deja de avanzar y el registro envejece: avisar el mismo día, no cuando alguien lo note.
        await notify({ severity: 'critical', title: `El refresco diario del registro falló para ${failed.length} ${failed.length === 1 ? 'cliente' : 'clientes'}`, detail: failed.slice(0, 2).map((f) => f.error).join(' | ') });
      }
      return NextResponse.json({ published, failed: failed.length }, { status: failed.length ? 500 : 200 });
    }
    if (job === 'tenants') {
      const only = url.searchParams.get('only');
      if (only && !TENANT_JOBS[only]) return NextResponse.json({ error: 'Tarea desconocida' }, { status: 400 });
      // Con maxDuration = 120 s y llamadas de hasta 55 s (reconcile-payments; el resto 20 s), 90 s de presupuesto dejan margen para anotar el estado:
      // una llamada solo empieza si cabe entera en lo que queda de presupuesto.
      const budget = Number(process.env.CRON_BUDGET_MS ?? 90_000);
      const summary = await dispatchTenantJobs({ jobs: only ? [only] : undefined, budgetMs: Number.isFinite(budget) && budget > 0 ? budget : 90_000 });
      const status = dispatchHttpStatus(summary);
      console.log(`[cron-dispatch] due=${summary.due} ran=${summary.ran} ok=${summary.ok} failed=${summary.failed} deferred=${summary.deferred}`);
      if (summary.due > 0 && summary.ran === 0) console.error('[cron-dispatch] había tareas vencidas y no se lanzó ninguna: ¿CRON_BUDGET_MS menor que el tiempo máximo de una llamada (55 s en reconcile-payments)?');
      // Latido: «el disparador sigue vivo» aunque haya clientes fallando (de eso avisan las alertas). Si deja de llegar, el servicio externo avisa.
      await sendHeartbeat(true);
      return NextResponse.json(summary, { status });
    }
    return NextResponse.json({ error: 'job debe ser tenants o snapshots-refresh' }, { status: 400 });
  } catch (error) {
    console.error('[GET /api/cron/dispatch]', error instanceof Error ? error.message : error);
    // El disparador reventó (BD de control caída, etc.): el latido de fallo avisa de inmediato en vez de esperar al plazo del servicio externo.
    if (job === 'tenants') await sendHeartbeat(false);
    return NextResponse.json({ error: 'Error interno' }, { status: 500 });
  }
}
