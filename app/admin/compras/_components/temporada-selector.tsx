'use client';

import { useEffect, useState } from 'react';
import type { Temporada } from '@prisma/client';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { Plus, Loader2, Archive, ArchiveRestore } from 'lucide-react';
import { toast } from 'sonner';

type Props = {
  temporadas: Temporada[];
  temporadaId: string | null;
  onChange: (id: string | null) => void;
  onTemporadaCreada: (temporada: Temporada) => void;
  // Añade una opción "Sin temporada" al principio — para vínculos opcionales
  // como el de Evento↔Temporada, donde no seleccionar nada es válido.
  allowNone?: boolean;
  // Fase 4 (archivado): activa el interruptor "Ver archivadas" y la acción de
  // archivar/restaurar la temporada seleccionada. Desactivado por defecto —
  // se activa solo en las cabeceras de Compras/Gastos, no en selectores
  // incrustados en otros formularios (p. ej. el diálogo de Evento).
  showArchiveControls?: boolean;
  incluirArchivadas?: boolean;
  onIncluirArchivadasChange?: (v: boolean) => void;
  // Avisa al padre de que la lista de temporadas cambió (tras archivar o
  // restaurar) para que vuelva a pedirla y corrija la selección si hacía
  // falta.
  onTemporadasChanged?: () => void;
};

const EMPTY = { nombre: '', anio: new Date().getFullYear(), fechaInicio: '', fechaFin: '' };
const NONE_VALUE = '__ninguna__';

export function TemporadaSelector({
  temporadas,
  temporadaId,
  onChange,
  onTemporadaCreada,
  allowNone = false,
  showArchiveControls = false,
  incluirArchivadas = false,
  onIncluirArchivadasChange,
  onTemporadasChanged,
}: Props) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [archivando, setArchivando] = useState(false);

  const seleccionada = temporadas.find((t) => t.id === temporadaId) ?? null;

  const archivar = async (temporada: Temporada, archivado: boolean) => {
    const res = await fetch(`/api/admin/compras/temporadas/${temporada.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archivado }),
    });
    if (!res.ok) { toast.error('No se pudo actualizar la temporada'); return false; }
    onTemporadasChanged?.();
    return true;
  };

  const handleToggleArchivado = async () => {
    if (!seleccionada) return;
    setArchivando(true);
    try {
      const next = !seleccionada.archivado;
      const ok = await archivar(seleccionada, next);
      if (!ok) return;
      if (next) {
        toast.success(`Temporada "${seleccionada.nombre}" archivada`, {
          duration: 5000,
          action: { label: 'Deshacer', onClick: () => archivar(seleccionada, false) },
        });
      } else {
        toast.success(`Temporada "${seleccionada.nombre}" restaurada`);
      }
    } finally {
      setArchivando(false);
    }
  };

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
    <div className={showArchiveControls ? 'flex flex-col items-end gap-1.5' : 'contents'}>
      <div className="flex items-center gap-2">
        <Select
          value={temporadaId ?? (allowNone ? NONE_VALUE : '')}
          onValueChange={(v) => onChange(v === NONE_VALUE ? null : v)}
        >
          <SelectTrigger className="w-56">
            <SelectValue placeholder="Selecciona una temporada" />
          </SelectTrigger>
          <SelectContent>
            {allowNone && <SelectItem value={NONE_VALUE}>Sin temporada</SelectItem>}
            {temporadas.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {t.nombre} {t.status === 'CERRADA' ? '(cerrada)' : ''} {t.archivado ? '· archivada' : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="outline" size="icon-sm" onClick={() => setDialogOpen(true)} title="Nueva temporada">
          <Plus className="h-4 w-4" />
        </Button>
        {showArchiveControls && seleccionada && (
          <Button
            variant="outline"
            size="icon-sm"
            disabled={archivando}
            onClick={handleToggleArchivado}
            title={seleccionada.archivado ? 'Restaurar temporada' : 'Archivar temporada'}
          >
            {seleccionada.archivado ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
          </Button>
        )}
      </div>

      {showArchiveControls && (
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Switch
            checked={incluirArchivadas}
            onCheckedChange={(v) => onIncluirArchivadasChange?.(v)}
            className="scale-75 -mr-1"
          />
          Ver archivadas
        </label>
      )}

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
