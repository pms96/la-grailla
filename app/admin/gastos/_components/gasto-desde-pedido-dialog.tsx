'use client';

import { useEffect, useState } from 'react';
import type { Pedido, Proveedor, LineaPedido, Articulo, Temporada } from '@prisma/client';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { precioFinalUnidad, precioTrasDescuento } from '@/lib/compras/calculadora';

type PedidoConDetalle = Pedido & {
  proveedor: Proveedor;
  temporada: Temporada;
  lineas: (LineaPedido & { articulo: Articulo })[];
};

type Props = {
  pedido: PedidoConDetalle | null;
  onClose: () => void;
  onSaved: () => void;
};

export function GastoDesdePedidoDialog({ pedido, onClose, onSaved }: Props) {
  const [importeSinIva, setImporteSinIva] = useState('');
  const [numDocumento, setNumDocumento] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!pedido) return;
    const total = pedido.lineas.reduce((sum, l) => sum + precioTrasDescuento(l.precioSinIva, l.descuentoPercent) * l.cantidad, 0);
    setImporteSinIva(total.toFixed(2));
    setNumDocumento('');
  }, [pedido]);

  if (!pedido) return null;

  const totalConIva = pedido.lineas.reduce((sum, l) => sum + precioFinalUnidad(l.precioSinIva, l.descuentoPercent, l.ivaPercent) * l.cantidad, 0);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/admin/gastos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          temporadaId: pedido.temporadaId,
          categoria: 'Bebidas y bar',
          concepto: `Pedido a ${pedido.proveedor.nombre}`,
          proveedorId: pedido.proveedorId,
          pedidoId: pedido.id,
          importeSinIva: Number(importeSinIva) || 0,
          ivaPercent: 21,
          numDocumento: numDocumento || null,
          tipoDocumento: 'Factura',
        }),
      });
      if (!res.ok) { toast.error('No se pudo registrar el gasto'); return; }
      toast.success('Gasto registrado');
      onSaved();
    } catch {
      toast.error('Error de conexión');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Registrar factura de {pedido.proveedor.nombre}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            El pedido planificado sumaba {totalConIva.toFixed(2)}€ c/IVA. Ajusta el importe al de la factura real
            del proveedor (descuentos, abonos, etc.) antes de guardarlo como gasto.
          </p>
          <div>
            <Label>Importe s/IVA (€) *</Label>
            <Input type="number" step="0.01" value={importeSinIva} onChange={(e) => setImporteSinIva(e.target.value)} className="mt-1" />
          </div>
          <div>
            <Label>Nº de factura</Label>
            <Input value={numDocumento} onChange={(e) => setNumDocumento(e.target.value)} className="mt-1" placeholder="25/008671" />
          </div>
          <Button onClick={handleSave} disabled={saving} className="w-full gap-2">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Registrar gasto
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
