'use client';

import { useState } from 'react';
import type { Event } from '@prisma/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { BellRing, Loader2, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';

type Props = { event: Pick<Event, 'id' | 'name' | 'alertThresholds' | 'alertsSent'>; onSaved?: () => void };

export default function CapacityAlertsEditor({ event, onSaved }: Props) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState<string>(event?.alertThresholds ?? '80,95,100');
  const [saving, setSaving] = useState(false);

  const sent = String(event?.alertsSent ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);

  const save = async (resetOnly?: boolean) => {
    setSaving(true);
    try {
      const body: { resetAlerts: true } | { alertThresholds: string } = resetOnly ? { resetAlerts: true } : { alertThresholds: value };
      const res = await fetch('/api/admin/events/' + event?.id, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) { toast.error('No se pudieron guardar las alertas'); return; }
      toast.success(resetOnly ? 'Avisos reiniciados' : 'Alertas guardadas');
      setOpen(false);
      onSaved?.();
    } catch {
      toast.error('Error de conexión');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2"><BellRing className="h-3.5 w-3.5" /> Alertas</Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Alertas de aforo · {event?.name ?? ''}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Se enviará un aviso por email al administrador cada vez que el aforo alcance uno de estos porcentajes. Escríbelos separados por comas.
          </p>
          <div>
            <Label>Umbrales (%)</Label>
            <Input value={value} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setValue(e?.target?.value ?? '')} className="mt-1" placeholder="80,95,100" />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">Avisos ya enviados</Label>
            <div className="flex flex-wrap gap-1.5 mt-1">
              {sent.length === 0 ? <span className="text-sm text-muted-foreground">Ninguno todavía</span> : sent.map((s) => <Badge key={s} variant="secondary">{s}%</Badge>)}
            </div>
          </div>
          <div className="flex gap-2">
            <Button onClick={() => save(false)} disabled={saving} className="flex-1 gap-2">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Guardar
            </Button>
            <Button variant="outline" onClick={() => save(true)} disabled={saving} className="gap-2">
              <RotateCcw className="h-4 w-4" /> Reiniciar avisos
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
