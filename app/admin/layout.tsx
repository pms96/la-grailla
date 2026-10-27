import AdminShell from './_components/admin-shell';
import { getActiveModules, getLicenseNotice } from '@/lib/modules/runtime';
import { providerContact } from '@/lib/license-support';

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  // Los módulos y el aviso de licencia los decide el servidor (el cliente de la petición); el shell solo los pinta.
  const license = getLicenseNotice();
  const graceEndsAt = license?.phase === 'GRACE' ? license.nextPhaseChangeAt : undefined;
  return (
    <AdminShell modules={getActiveModules()} licenseGrace={license?.phase === 'GRACE' ? { panelBlockedAt: graceEndsAt ?? null, contact: providerContact() } : null}>
      {children}
    </AdminShell>
  );
}
