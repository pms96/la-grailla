'use client';

import { useState } from 'react';
import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export type CustomRole = { id: string; name: string; modules: string[] };
export type PresetRole = { key: string; label: string; description: string; modules: string[] };

/** Cómo se llama cada módulo para quien elige permisos. */
export const MODULE_LABELS: Record<string, string> = {
  nucleo: 'Apariencia, mensajes y contenido',
  entradas: 'Venta de entradas',
  tienda: 'Tienda online',
  contabilidad: 'Contabilidad',
  wallets: 'Wallets',
  sponsors: 'Sponsors',
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Módulos que tiene el cliente (solo se puede elegir entre ellos). */
  available: readonly string[];
  presets: PresetRole[];
  custom: CustomRole[];
  onChanged: () => void;
};

const EMPTY = { id: null as string | null, name: '', modules: [] as string[] };

/** Roles de acceso: los predefinidos (solo lectura) y los que crea el cliente con un alias eligiendo módulos. */
export function RolesDialog({ open, onOpenChange, available, presets, custom, onChanged }: Props) {
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);

  const toggle = (m: string) => setForm((f) => ({ ...f, modules: f.modules.includes(m) ? f.modules.filter((x) => x !== m) : [...f.modules, m] }));

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch(form.id ? `/api/admin/roles/${form.id}` : '/api/admin/roles', {
        method: form.id ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: form.name, modules: form.modules }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(data?.error ?? 'No se pudo guardar el rol'); return; }
      toast.success(form.id ? 'Rol actualizado: quienes lo tienen deberán entrar de nuevo' : 'Rol creado');
      setForm(EMPTY);
      onChanged();
    } catch { toast.error('Error de conexión'); }
    finally { setSaving(false); }
  };

  const remove = async (role: CustomRole) => {
    if (!confirm(`¿Borrar el rol «${role.name}»?`)) return;
    const res = await fetch(`/api/admin/roles/${role.id}`, { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { toast.error(data?.error ?? 'No se pudo borrar'); return; }
    toast.success('Rol borrado');
    if (form.id === role.id) setForm(EMPTY);
    onChanged();
  };

  const names = (modules: string[]) => modules.map((m) => MODULE_LABELS[m] ?? m).join(' · ');

  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) setForm(EMPTY); }}>
      <DialogContent className="max-w-xl max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Roles de acceso</DialogTitle></DialogHeader>
        <div className="space-y-6 mt-2">
          <p className="text-sm text-muted-foreground">
            Un administrador con rol solo ve y usa los módulos de ese rol. Sin rol, es propietario: lo ve todo y gestiona usuarios y roles.
          </p>

          <section className="space-y-2">
            <h4 className="text-sm font-semibold">Predefinidos</h4>
            {presets.map((p) => (
              <div key={p.key} className="rounded-lg border border-border p-3">
                <p className="text-sm font-medium">{p.label}</p>
                <p className="text-xs text-muted-foreground">{names(p.modules.filter((m) => m !== 'wallets' || available.includes('wallets')))}</p>
              </div>
            ))}
          </section>

          <section className="space-y-2">
            <h4 className="text-sm font-semibold">Los tuyos</h4>
            {custom.length === 0 && <p className="text-xs text-muted-foreground">Todavía no has creado ninguno.</p>}
            {custom.map((r) => (
              <div key={r.id} className="rounded-lg border border-border p-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{r.name}</p>
                  <p className="text-xs text-muted-foreground">{names(r.modules)}</p>
                </div>
                <div className="flex gap-1 shrink-0">
                  <Button variant="ghost" size="icon-sm" title="Editar" onClick={() => setForm({ id: r.id, name: r.name, modules: r.modules })}><Pencil className="h-3.5 w-3.5" /></Button>
                  <Button variant="ghost" size="icon-sm" title="Borrar" onClick={() => remove(r)}><Trash2 className="h-3.5 w-3.5 text-destructive" /></Button>
                </div>
              </div>
            ))}
          </section>

          <section className="rounded-lg border border-border p-4 space-y-4">
            <h4 className="text-sm font-semibold">{form.id ? 'Editar rol' : 'Crear un rol'}</h4>
            <div>
              <Label>Nombre del rol</Label>
              <Input value={form.name} maxLength={40} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} className="mt-1" placeholder="Equipo de tienda y cuentas" />
            </div>
            <div className="space-y-2">
              <Label>Módulos que puede usar</Label>
              {available.map((m) => (
                <label key={m} className="flex items-center gap-2 text-sm">
                  <Checkbox checked={form.modules.includes(m)} onCheckedChange={() => toggle(m)} />
                  {MODULE_LABELS[m] ?? m}
                </label>
              ))}
            </div>
            <div className="flex gap-2">
              <Button onClick={save} disabled={saving} className="gap-2">
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : form.id ? null : <Plus className="h-4 w-4" />}
                {form.id ? 'Guardar cambios' : 'Crear rol'}
              </Button>
              {form.id && <Button variant="outline" onClick={() => setForm(EMPTY)}>Cancelar</Button>}
            </div>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
