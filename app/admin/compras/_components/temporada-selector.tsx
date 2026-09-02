'use client';

import { useEffect, useState } from 'react';
import type { Temporada } from '@prisma/client';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Plus, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

type Props = {
  temporadas: Temporada[];
  temporadaId: string | null;
  onChange: (id: string) => void;
  onTemporadaCreada: (temporada: Temporada) => void;
};

const EMPTY = { nombre: '', anio: new Date().getFullYear(), fechaInicio: '', fechaFin: '' };

export function TemporadaSelector({ temporadas, temporadaId, onChange, onTemporadaCreada }: Props) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (dialogOpen) setForm({ ...EMPTY, nombre: `Feria de Septiembre ${new Date().getFullYear()}` });
  }, [dialogOpen]);

  const handleSave = async () => {
    if (!form.nombre.trim()) {
      toast.error('La temporada necesita un nombre');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/admin/compras/temporadas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nombre: form.nombre.trim(),
          anio: Number(form.anio) || new Date().getFullYear(),
          fechaInicio: form.fechaInicio || null,
          fechaFin: form.fechaFin || null,
        }),
      });
      if (!res.ok) {
        toast.error('No se pudo crear la temporada');
        return;
      }
      const temporada = await res.json();
      toast.success('Temporada creada');
      setDialogOpen(false);
      onTemporadaCreada(temporada);
    } catch {
      toast.error('Error de conexión');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <Select value={temporadaId ?? ''} onValueChange={onChange}>
        <SelectTrigger className="w-56">
          <SelectValue placeholder="Selecciona una temporada" />
        </SelectTrigger>
        <SelectContent>
          {temporadas.map((t) => (
            <SelectItem key={t.id} value={t.id}>
              {t.nombre} {t.status === 'CERRADA' ? '(cerrada)' : ''}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button variant="outline" size="icon-sm" onClick={() => setDialogOpen(true)} title="Nueva temporada">
        <Plus className="h-4 w-4" />
      </Button>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Nueva temporada</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Nombre *</Label>
              <Input
                value={form.nombre}
                onChange={(e) => setForm((f) => ({ ...f, nombre: e.target.value }))}
                className="mt-1"
              />
            </div>
            <div>
              <Label>Año *</Label>
              <Input
                type="number"
                value={form.anio}
                onChange={(e) => setForm((f) => ({ ...f, anio: Number(e.target.value) || f.anio }))}
                className="mt-1"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Fecha inicio</Label>
                <Input
                  type="date"
                  value={form.fechaInicio}
                  onChange={(e) => setForm((f) => ({ ...f, fechaInicio: e.target.value }))}
                  className="mt-1"
                />
              </div>
              <div>
                <Label>Fecha fin</Label>
                <Input
                  type="date"
                  value={form.fechaFin}
                  onChange={(e) => setForm((f) => ({ ...f, fechaFin: e.target.value }))}
                  className="mt-1"
                />
              </div>
            </div>
            <Button onClick={handleSave} disabled={saving} className="w-full gap-2">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Crear temporada
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
