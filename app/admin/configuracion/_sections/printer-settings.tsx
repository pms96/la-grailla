'use client';

import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ConfigField } from '@/app/admin/_components/config-field';

type Props = { values: Record<string, string>; onChange: (key: string, value: string) => void };

/** Ajustes del ticket térmico Bluetooth (Phomemo M04S) de taquilla. Es de Entradas. */
export function PrinterSettings({ values, onChange }: Props) {
  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Ajustes del ticket térmico Bluetooth (Phomemo M04S) que usa taquilla. La impresión pasa
        directamente del navegador a la impresora — si en un dispositivo concreto sale con ruido,
        lenta o incompleta, prueba a ajustar estos valores sin necesidad de tocar código.
      </p>

      <div className="rounded-lg border border-border p-4 space-y-4">
        <h4 className="font-semibold text-sm">Impresión Bluetooth</h4>
        <div>
          <Label>Impresión directa por Bluetooth en taquilla</Label>
          <Select value={values?.phomemo_printer_enabled ?? 'true'} onValueChange={(v: string) => onChange('phomemo_printer_enabled', v)}>
            <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="true">Activada</SelectItem>
              <SelectItem value="false">Desactivada (siempre PDF)</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground mt-1">
            Si la desactivas aquí, ninguna taquilla intentará conectar con la Phomemo — cada
            venta genera directamente el PDF para guardar o imprimir en otro sitio. Cada
            tablet puede además desactivarla solo para sí misma desde el propio panel de
            Taquilla, sin tocar esto.
          </p>
        </div>
      </div>

      <div className="rounded-lg border border-border p-4 space-y-4">
        <h4 className="font-semibold text-sm">Modo de escritura Bluetooth</h4>
        <Select value={values?.phomemo_write_mode ?? 'auto'} onValueChange={(v: string) => onChange('phomemo_write_mode', v)}>
          <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">Auto (rápido, con confirmaciones intercaladas)</SelectItem>
            <SelectItem value="with_response">Siempre confirmado (el más fiable, pero puede tardar tanto que la impresora corte el ticket a medias)</SelectItem>
            <SelectItem value="without_response">Siempre sin confirmación (rápido, sin red de seguridad)</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          &quot;Auto&quot; manda la mayoría del ticket rápido y sin confirmar, pero intercala una
          confirmación real cada pocos bloques (ver &quot;Confirmar cada&quot; abajo) para comprobar que
          la impresora sigue el ritmo sin perder nada por el camino — en la práctica es el más
          fiable y el más rápido a la vez. &quot;Siempre confirmado&quot; solo hace falta si un
          dispositivo concreto sigue dando problemas con Auto: confirma cada bloque uno a uno, lo
          que en pruebas reales ha llegado a tardar más de un minuto y ha hecho que la propia
          impresora corte el ticket antes de terminar.
        </p>
      </div>

      <div className="rounded-lg border border-border p-4 space-y-4">
        <h4 className="font-semibold text-sm">Velocidad de envío</h4>
        <div className="grid gap-4 sm:grid-cols-2">
          <ConfigField
            label="Tamaño de bloque (bytes)"
            type="number"
            value={values?.phomemo_raster_chunk_size ?? '256'}
            onChange={(v) => onChange('phomemo_raster_chunk_size', v)}
            description="En cuántos bytes se trocea la imagen del ticket antes de mandarla. 256 es el valor probado en hardware real."
          />
          <ConfigField
            label="Pausa entre bloques (ms)"
            type="number"
            value={values?.phomemo_chunk_delay_ms ?? '20'}
            onChange={(v) => onChange('phomemo_chunk_delay_ms', v)}
            description="Solo se aplica a los bloques rápidos (sin confirmar) — los bloques de confirmación ya marcan el ritmo por sí solos."
          />
          <ConfigField
            label="Confirmar cada (bloques)"
            type="number"
            value={values?.phomemo_confirm_every_chunks ?? '8'}
            onChange={(v) => onChange('phomemo_confirm_every_chunks', v)}
            description="Solo en modo Auto: cada cuántos bloques se manda uno confirmado de verdad. Súbelo para ir más rápido, bájalo si sigue saliendo con ruido. 0 desactiva las confirmaciones intercaladas."
          />
          <ConfigField
            label="Pausa entre comandos (ms)"
            type="number"
            value={values?.phomemo_command_delay_ms ?? '30'}
            onChange={(v) => onChange('phomemo_command_delay_ms', v)}
            description="Antes de mandar cada comando de configuración (densidad, calor…) a la impresora."
          />
          <ConfigField
            label="Pausa tras la imagen (ms)"
            type="number"
            value={values?.phomemo_after_raster_delay_ms ?? '300'}
            onChange={(v) => onChange('phomemo_after_raster_delay_ms', v)}
          />
          <ConfigField
            label="Pausa tras el avance de papel (ms)"
            type="number"
            value={values?.phomemo_after_feed_delay_ms ?? '500'}
            onChange={(v) => onChange('phomemo_after_feed_delay_ms', v)}
          />
        </div>
      </div>

      <div className="rounded-lg border border-border p-4 space-y-4">
        <h4 className="font-semibold text-sm">Impresión</h4>
        <div className="grid gap-4 sm:grid-cols-2">
          <ConfigField
            label="Densidad de tinta (1-8)"
            type="number"
            value={values?.phomemo_density ?? '6'}
            onChange={(v) => onChange('phomemo_density', v)}
            description="Más alto = más oscuro. Súbelo si el ticket sale muy claro, bájalo si sale manchado."
          />
          <ConfigField
            label="Avance de papel al terminar"
            type="number"
            value={values?.phomemo_feed ?? '32'}
            onChange={(v) => onChange('phomemo_feed', v)}
            description="32 ≈ 2-3 mm de margen tras cortar el ticket."
          />
        </div>
      </div>
    </div>
  );
}
