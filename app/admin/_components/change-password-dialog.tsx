'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

const EMPTY = { currentPassword: '', newPassword: '', confirmPassword: '' };

export function ChangePasswordDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);

  const updateField = (key: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((prev) => ({ ...prev, [key]: e.target.value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (form.newPassword.length < 8) {
      toast.error('La nueva contraseña debe tener al menos 8 caracteres');
      return;
    }
    if (form.newPassword !== form.confirmPassword) {
      toast.error('Las contraseñas nuevas no coinciden');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/admin/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: form.currentPassword, newPassword: form.newPassword }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data?.error ?? 'No se ha podido cambiar la contraseña');
        return;
      }
      toast.success('Contraseña actualizada');
      setForm(EMPTY);
      onOpenChange(false);
    } catch {
      toast.error('Error de conexión');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { onOpenChange(next); if (!next) setForm(EMPTY); }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader><DialogTitle>Cambiar contraseña</DialogTitle></DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label>Contraseña actual</Label>
            <Input type="password" required value={form.currentPassword} onChange={updateField('currentPassword')} className="mt-1" />
          </div>
          <div>
            <Label>Nueva contraseña</Label>
            <Input type="password" required minLength={8} value={form.newPassword} onChange={updateField('newPassword')} className="mt-1" />
          </div>
          <div>
            <Label>Confirmar nueva contraseña</Label>
            <Input type="password" required minLength={8} value={form.confirmPassword} onChange={updateField('confirmPassword')} className="mt-1" />
          </div>
          <Button type="submit" disabled={saving} className="w-full gap-2">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Guardar contraseña
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
