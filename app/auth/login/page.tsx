import { AuthLayout } from '@/components/layouts/auth-layout';
import LoginForm from './_components/login-form';

export default function LoginPage() {
  return (
    <AuthLayout title="Iniciar Sesión" description="Panel de administración de La Grailla 💜">
      <LoginForm />
    </AuthLayout>
  );
}
