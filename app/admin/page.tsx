import AdminDashboard from './_components/admin-dashboard';
import ShopDashboard from './_components/shop-dashboard';
import CoreDashboard from './_components/core-dashboard';
import OnboardingNotice from './_components/onboarding-notice';
import { getActiveModules } from '@/lib/modules/runtime';

export const dynamic = 'force-dynamic';

// El panel de inicio sigue a los módulos del cliente: Entradas (su dashboard de siempre, con la tienda debajo si la tiene),
// solo Tienda (su dashboard) o solo núcleo (marca y mensajes).
export default function AdminPage() {
  return (
    <>
      <OnboardingNotice />
      <Dashboard />
    </>
  );
}

function Dashboard() {
  const modules = getActiveModules();
  if (modules.includes('entradas')) {
    return modules.includes('tienda') ? (
      <div className="space-y-10">
        <AdminDashboard />
        <ShopDashboard embedded />
      </div>
    ) : (
      <AdminDashboard />
    );
  }
  if (modules.includes('tienda')) return <ShopDashboard />;
  return <CoreDashboard />;
}
