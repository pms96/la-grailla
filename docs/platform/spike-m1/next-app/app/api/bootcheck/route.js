import { prisma } from '@/lib/tenant';
export const dynamic = 'force-dynamic';
// Un temporizador creado FUERA de cualquier petición (como un job de arranque) no debe poder tocar ninguna BD.
globalThis.__bootTimer ??= setTimeout(async () => {
  try { await prisma.appConfig.findFirst(); globalThis.__boot = 'LEAK: consultó sin contexto'; }
  catch (e) { globalThis.__boot = 'fail-closed OK: ' + e.message; }
}, 50);
export async function GET() { return Response.json({ ok: true }); }
