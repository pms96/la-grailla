/* Congelación de despliegues durante una venta (P1-22 · OB-14), como «Ignored Build Step» de Vercel (`ignoreCommand` de vercel.json).
 *
 * Un despliegue en pleno lanzamiento reinicia las funciones y, si trae migración, deja a un cliente en mantenimiento justo cuando más
 * compradores hay. Mientras la congelación está activa, los despliegues de PRODUCCIÓN no se construyen (quedan «cancelados» en Vercel, sin
 * tocar la web que sirve); las vistas previas no se ven afectadas. Convención de Vercel: salir con 0 = NO construir, con 1 = construir.
 *
 * Se activa SIN tocar código, con variables del proyecto en Vercel (la siguiente construcción las lee; no hace falta desplegar):
 *   - SALES_FREEZE=1                         congelado hasta que se quite la variable.
 *   - SALES_FREEZE_UNTIL=2026-11-14T23:00:00Z   congelado hasta esa fecha y hora (ISO); se levanta solo. Una fecha ilegible CONGELA por
 *                                              prudencia (y lo dice): equivocarse al escribirla no debe dejar la venta sin protección.
 * Arreglo urgente durante la congelación: un commit cuyo mensaje contenga «[deploy-anyway]» se construye igualmente.
 * Quitar el ignoreCommand de vercel.json (o ambas variables) lo deja como siempre: todo se construye. */

const BYPASS_MARKER = '[deploy-anyway]';

/** ¿Se salta esta construcción? Pura, para poder probarla. `skip: true` = no construir. */
function freezeDecision(env, now = Date.now()) {
  if (env.VERCEL_ENV !== 'production') return { skip: false, reason: 'no es producción: no hay congelación' };

  const untilRaw = (env.SALES_FREEZE_UNTIL || '').trim();
  let frozen = env.SALES_FREEZE === '1';
  let why = 'SALES_FREEZE=1';
  if (!frozen && untilRaw) {
    const until = Date.parse(untilRaw);
    if (Number.isNaN(until)) {
      frozen = true;
      why = `SALES_FREEZE_UNTIL no es una fecha válida («${untilRaw}»): se congela por prudencia, corrígela o quítala`;
    } else if (until > now) {
      frozen = true;
      why = `SALES_FREEZE_UNTIL=${untilRaw}`;
    }
  }
  if (!frozen) return { skip: false, reason: 'sin congelación activa' };

  if ((env.VERCEL_GIT_COMMIT_MESSAGE || '').includes(BYPASS_MARKER)) {
    return { skip: false, reason: `congelación activa (${why}) pero el commit lleva ${BYPASS_MARKER}: se construye` };
  }
  return { skip: true, reason: `congelación de despliegues activa (${why}): no se construye. Para un arreglo urgente, añade ${BYPASS_MARKER} al mensaje del commit` };
}

module.exports = { freezeDecision, BYPASS_MARKER };

if (require.main === module) {
  const { skip, reason } = freezeDecision(process.env);
  console.log(`[ignore-build] ${reason}`);
  process.exit(skip ? 0 : 1);
}
