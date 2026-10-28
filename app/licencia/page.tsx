export const dynamic = 'force-dynamic';

import { redirect } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getBrand } from '@/lib/brand/brand';
import { providerContact } from '@/lib/license-support';
import { adminLacksModule } from '@/lib/modules/access';
import { isLinkVisible } from '@/lib/modules/registry';
import { getActiveModules, getLicenseNotice } from '@/lib/modules/runtime';
import { isLegacyTenant } from '@/lib/tenant/context';
import { LicenseNotice } from './_components/license-notice';

// Aviso de licencia. El middleware reescribe aquí las rutas bloqueadas (402 el panel, 503 el sitio entero). Con la licencia al día,
// o fuera del modo plataforma, no hay nada que avisar y se vuelve a la web.
export const metadata = { title: 'Servicio no disponible', robots: { index: false, follow: false } };

/** Rol de staff de quien mira, si hay sesión, y si puede usar la puerta (un ADMIN con rol restringido sin Entradas no). Cualquier fallo al leerla (BD, cookie) equivale a «sin sesión»: el aviso nunca debe romperse. */
async function staffRole(): Promise<{ role: 'ADMIN' | 'TAQUILLA' | null; door: boolean }> {
  try {
    const user = (await getServerSession(authOptions))?.user;
    const role = user?.role === 'ADMIN' || user?.role === 'TAQUILLA' ? user.role : null;
    return { role, door: role !== null && !adminLacksModule(user, 'entradas') };
  } catch {
    return { role: null, door: false };
  }
}

export default async function LicensePage() {
  const notice = getLicenseNotice();
  if (!notice || (notice.phase !== 'PANEL_BLOCKED' && notice.phase !== 'BLOCKED')) redirect('/');
  const [brand, staff] = await Promise.all([getBrand(), staffRole()]);

  return (
    <LicenseNotice
      phase={notice.phase}
      legacy={isLegacyTenant()}
      brandName={brand.name}
      role={staff.role}
      scanner={isLinkVisible('/acceso', getActiveModules()) && staff.door}
      contact={providerContact()}
    />
  );
}
