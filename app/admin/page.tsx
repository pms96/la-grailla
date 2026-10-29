import { getServerSession } from 'next-auth';
import AdminDashboard from './_components/admin-dashboard';
import ShopDashboard from './_components/shop-dashboard';
import CoreDashboard from './_components/core-dashboard';
import OnboardingNotice from './_components/onboarding-notice';
import { authOptions } from '@/lib/auth';
import { getActiveModules } from '@/lib/modules/runtime';

export const dynamic = 'force-dynamic';

// El panel de inicio sigue a los módulos del cliente Y a los del usuario (un rol restringido no ve datos ni enlaces de lo que no puede abrir):
// Entradas (su dashboard de siempre, con la tienda debajo si la tiene), solo Tienda (su dashboard) o, sin ninguno de los dos, el inicio del
// núcleo con accesos a SUS módulos.
export default async function AdminPage() {
  const session = await getServerSession(authOptions);
  const userModules = session?.user?.modules ?? null;
  return (
    <>
      <OnboardingNotice />
      <Dashboard userModules={userModules} />
    </>
  );
}

function Dashboard({ userModules }: { userModules: readonly string[] | null }) {
  const active = getActiveModules();
  // Lo que el cliente tiene Y el usuario puede usar (null = propietario: todo).
  const mine = userModules === null ? active : active.filter((m) => userModules.includes(m));
  const accounting = mine.includes('contabilidad');
  if (mine.includes('entradas')) {
    return mine.includes('tienda') ? (
      <div className="space-y-10">
        <AdminDashboard accounting={accounting} />
        <ShopDashboard embedded />
      </div>
    ) : (
      <AdminDashboard accounting={accounting} />
    );
  }
  if (mine.includes('tienda')) return <ShopDashboard />;
  return <CoreDashboard modules={active} userModules={userModules} />;
}
