'use client';

import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Plus, Trash2 } from 'lucide-react';
import { parseSponsorTiers, type SponsorTier } from '@/lib/sponsor-tiers';

type Props = {
  value: string;
  onChange: (value: string) => void;
};

// Editor de la lista de tipos de patrocinio (formulario público + alta
// manual de admin) — se guarda como JSON bajo la clave 'sponsor_tiers' de
// AppConfig, junto con el resto de Configuración, sin necesidad de un modelo
// ni una migración aparte.
export function SponsorTiersConfig({ value, onChange }: Props) {
  const [tiers, setTiers] = useState<SponsorTier[]>(() => parseSponsorTiers(value));

  const emit = (next: SponsorTier[]) => {
    setTiers(next);
    onChange(JSON.stringify(next));
  };

  const updateTier = (index: number, field: keyof SponsorTier, fieldValue: string) => {
    emit(
      tiers.map((tier, i) =>
        i === index ? { ...tier, [field]: field === 'priceAmount' ? Number(fieldValue) || 0 : fieldValue } : tier
      )
    );
  };

  const addTier = () => emit([...tiers, { value: '', label: '', priceLabel: '', priceAmount: 0 }]);
  const removeTier = (index: number) => emit(tiers.filter((_, i) => i !== index));

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Los tipos que ve quien rellena el formulario público de sponsors y quien da de alta un sponsor
        manualmente desde admin. El &quot;valor interno&quot; identifica el tipo en la base de datos —
        cámbialo con cuidado si ya hay solicitudes guardadas con ese valor. El &quot;Importe&quot; es el
        número real que se registra como ingreso al marcar un sponsor como pagado — el &quot;Precio
        (texto)&quot; es solo lo que se muestra, puede incluir matices (&quot;30€ + IVA&quot;) pero no se usa
        para calcular nada.
      </p>
      <div className="space-y-3">
        {tiers.map((tier, i) => (
          <div key={i} className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_100px_100px_auto] gap-2 sm:items-end rounded-lg border border-border p-3 sm:border-none sm:p-0">
            <div>
              <Label className="text-xs">Valor interno</Label>
              <Input value={tier.value} onChange={(e) => updateTier(i, 'value', e.target.value)} className="mt-1" placeholder="evento" />
            </div>
            <div>
              <Label className="text-xs">Etiqueta</Label>
              <Input value={tier.label} onChange={(e) => updateTier(i, 'label', e.target.value)} className="mt-1" placeholder="Patrocinio de Evento" />
            </div>
            <div>
              <Label className="text-xs">Precio (texto)</Label>
              <Input value={tier.priceLabel} onChange={(e) => updateTier(i, 'priceLabel', e.target.value)} className="mt-1" placeholder="30€" />
            </div>
            <div>
              <Label className="text-xs">Importe (€)</Label>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={tier.priceAmount}
                onChange={(e) => updateTier(i, 'priceAmount', e.target.value)}
                className="mt-1"
                placeholder="30"
              />
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={tiers.length <= 1}
              onClick={() => removeTier(i)}
              className="text-muted-foreground shrink-0"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </div>
      <Button type="button" variant="outline" size="sm" className="gap-2" onClick={addTier}>
        <Plus className="h-3.5 w-3.5" /> Añadir tipo de patrocinio
      </Button>
    </div>
  );
}
