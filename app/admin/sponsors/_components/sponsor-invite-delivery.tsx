'use client';

import { Button } from '@/components/ui/button';
import { Mail, Copy, Loader2, MessageCircle, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { buildWhatsAppLink } from '@/lib/phone';

type Props = {
  portalUrl: string;
  contactName: string;
  phone?: string | null;
  emailStatus?: 'SENT' | 'FAILED' | null;
  // false = el sponsor todavía no tiene email guardado (alta manual sin
  // email) — oculta "Reenviar invitación" en vez de dejar que falle al
  // intentar mandarlo a nadie. Por defecto true para no romper otros usos.
  hasEmail?: boolean;
  onResend?: () => void;
  onRegenerate?: () => void;
  resending?: boolean;
  regenerating?: boolean;
};

// Un único componente para las 3 vías de entrega del enlace del portal —
// usado tanto en la confirmación de alta manual como en el detalle unificado
// del sponsor. El enlace siempre está disponible aquí, no depende de que el
// email haya funcionado: copiar/WhatsApp son la vía de respaldo si SMTP falla.
export function SponsorInviteDelivery({
  portalUrl,
  contactName,
  phone,
  emailStatus,
  hasEmail = true,
  onResend,
  onRegenerate,
  resending,
  regenerating,
}: Props) {
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(portalUrl);
      toast.success('Enlace copiado');
    } catch {
      toast.error('No se pudo copiar el enlace — cópialo a mano');
    }
  };

  const whatsappUrl = buildWhatsAppLink(
    phone,
    `Hola ${contactName}, aquí tienes el acceso a tu portal de sponsor de La Grailla: ${portalUrl}`
  );

  return (
    <div className="space-y-2">
      <div className="rounded-md bg-muted/50 p-2 overflow-x-auto">
        <code className="text-xs whitespace-nowrap">{portalUrl}</code>
      </div>
      {!hasEmail && (
        <p className="text-xs text-muted-foreground">Sin email guardado — comparte el enlace por WhatsApp o copiándolo. El sponsor puede añadir su email desde el propio portal.</p>
      )}
      {hasEmail && emailStatus === 'FAILED' && (
        <p className="text-xs text-destructive">⚠️ La invitación por email no se pudo enviar — usa copiar enlace o WhatsApp mientras tanto.</p>
      )}
      <div className="flex flex-wrap gap-2">
        {hasEmail && onResend && (
          <Button size="sm" variant="outline" className="gap-2" disabled={resending} onClick={onResend}>
            {resending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Mail className="h-3.5 w-3.5" />}
            {emailStatus === 'FAILED' ? 'Reintentar envío' : 'Reenviar invitación'}
          </Button>
        )}
        <Button size="sm" variant="outline" className="gap-2" onClick={copyLink}>
          <Copy className="h-3.5 w-3.5" /> Copiar enlace
        </Button>
        <Button size="sm" variant="outline" className="gap-2" asChild>
          <a href={whatsappUrl} target="_blank" rel="noopener noreferrer">
            <MessageCircle className="h-3.5 w-3.5" /> WhatsApp
          </a>
        </Button>
        {onRegenerate && (
          <Button size="sm" variant="ghost" className="gap-2 text-muted-foreground" disabled={regenerating} onClick={onRegenerate}>
            {regenerating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Regenerar enlace
          </Button>
        )}
      </div>
    </div>
  );
}
