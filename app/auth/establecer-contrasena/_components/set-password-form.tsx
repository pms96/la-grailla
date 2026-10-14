'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CheckCircle2, Loader2 } from 'lucide-react';
import { MIN_PASSWORD_LENGTH } from '@/lib/platform/password-policy';

export default function SetPasswordForm({ token }: { token: string }) {
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`);
      return;
    }
    if (password !== repeat) {
      setError('Las dos contraseñas no coinciden.');
      return;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/auth/set-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setDone(true);
      else setError(typeof data?.error === 'string' ? data.error : 'No se pudo guardar la contraseña. Inténtalo de nuevo.');
    } catch {
      setError('Error de conexión. Inténtalo de nuevo.');
    } finally {
      setLoading(false);
    }
  };

  if (done) {
    return (
      <div className="space-y-4 text-center" role="status">
        <CheckCircle2 className="mx-auto h-8 w-8 text-primary" aria-hidden />
        <p className="text-sm">Contraseña guardada. Ya puedes entrar a la administración.</p>
        <Button asChild className="w-full">
          <Link href="/auth/login">Ir al acceso</Link>
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <Label htmlFor="password">Contraseña nueva</Label>
        <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} className="mt-1" autoComplete="new-password" aria-describedby="password-help" />
        <p id="password-help" className="mt-1 text-xs text-muted-foreground">
          Mínimo {MIN_PASSWORD_LENGTH} caracteres.
        </p>
      </div>
      <div>
        <Label htmlFor="repeat">Repite la contraseña</Label>
        <Input id="repeat" type="password" value={repeat} onChange={(e) => setRepeat(e.target.value)} className="mt-1" autoComplete="new-password" />
      </div>
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <Button type="submit" className="w-full" disabled={loading}>
        {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : null}
        Guardar contraseña
      </Button>
    </form>
  );
}
