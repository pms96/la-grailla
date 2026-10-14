'use server';

import { requireOperator } from '@/lib/guard';
import { describeChannels, notify, sendHeartbeat } from '@/lib/services/alerts';
import type { ActionState } from '../_components/action-form';
import { toState } from './util';

/** Manda una alerta de prueba por los canales configurados: es la forma de comprobar que los avisos llegan ANTES de que haga falta. */
export async function testAlertAction(_prev: ActionState): Promise<ActionState> {
  try {
    const { actor } = await requireOperator('tenants:write');
    const channels = describeChannels();
    if (!channels.webhook && !channels.email && !channels.heartbeat && !channels.emailNeedsSmtp) {
      return { error: 'No hay ningún canal de alertas configurado. Añade ALERT_WEBHOOK_URL (móvil o chat) o ALERT_EMAIL_TO en el panel y redespliega (ver la guía, apartado «Alertas»).' };
    }
    const details: string[] = [];
    let failed = false;
    if (channels.webhook || channels.email) {
      const res = await notify({ severity: 'test', title: 'Alerta de prueba del panel', detail: `La envió ${actor.email}. Si la ves, los avisos llegan.` });
      const label = (c: string) => (c === 'webhook' ? 'webhook (móvil o chat)' : 'correo');
      for (const c of res.sent) details.push(`✓ Enviada por ${label(c)}`);
      for (const c of res.failed) {
        details.push(`✗ Falló ${label(c)}: revisa la configuración y el registro del servidor`);
        failed = true;
      }
    }
    if (channels.emailNeedsSmtp) {
      details.push('✗ ALERT_EMAIL_TO está puesto pero falta el SMTP del panel (PANEL_SMTP_*): el correo no sale');
      failed = true;
    }
    if (channels.heartbeat) {
      const ok = await sendHeartbeat(true);
      details.push(ok ? '✓ Latido enviado' : '✗ El latido no se pudo enviar: revisa HEARTBEAT_URL');
      if (!ok) failed = true;
    }
    return failed ? { error: 'Alguno de los canales no funciona.', details } : { ok: 'Prueba enviada. Comprueba que te ha llegado.', details };
  } catch (err) {
    return toState(err);
  }
}
