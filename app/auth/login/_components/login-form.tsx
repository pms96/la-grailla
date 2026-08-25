'use client';

import { useState } from 'react';
import { signIn } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2, LogIn } from 'lucide-react';
import { toast } from 'sonner';

export default function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e?.preventDefault?.();
    if (!email?.trim() || !password?.trim()) {
      toast.error('Introduce email y contraseña');
      return;
    }
    setLoading(true);
    try {
      const result = await signIn?.('credentials', {
        email: email?.trim(),
        password: password?.trim(),
        redirect: false,
      });
      if (result?.ok) {
        // Fetch session to determine role-based redirect
        const sessionRes = await fetch('/api/auth/session');
        const session = await sessionRes.json();
        const role = session?.user?.role ?? '';
        if (role === 'ADMIN') {
          router.replace('/admin');
        } else if (role === 'TAQUILLA') {
          router.replace('/acceso');
        } else {
          router.replace('/');
        }
      } else if (result?.error === 'too_many_attempts') {
        toast.error('Demasiados intentos. Espera unos minutos antes de volver a intentarlo.');
      } else {
        toast.error('Credenciales incorrectas');
      }
    } catch {
      toast.error('Error de conexión');
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          value={email}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEmail(e?.target?.value ?? '')}
          placeholder="admin@lagrailla.com"
          className="mt-1"
          autoComplete="email"
        />
      </div>
      <div>
        <Label htmlFor="password">Contraseña</Label>
        <Input
          id="password"
          type="password"
          value={password}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPassword(e?.target?.value ?? '')}
          placeholder="••••••••"
          className="mt-1"
          autoComplete="current-password"
        />
      </div>
      <Button type="submit" className="w-full gap-2" disabled={loading}>
        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
        {loading ? 'Entrando…' : 'Entrar'}
      </Button>
    </form>
  );
}
