import { AuthLayout } from '@/components/layouts/auth-layout';
import LoginForm from './_components/login-form';

export default function LoginPage() {
  return (
    <AuthLayout
      variant="sober"
      title="Acceso staff"
      description="Panel de administración y control de acceso"
    >
      <LoginForm />
    </AuthLayout>
  );
}
