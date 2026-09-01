'use client';

import { useEffect, useState } from 'react';
import type { AppConfig } from '@prisma/client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Loader2, Save, CreditCard, Mail, Globe, FileText, Send, Wallet, ShieldAlert, Zap, Sparkles, Clapperboard } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/layouts/page-header';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ConfigField } from '@/app/admin/_components/config-field';

export default function ConfiguracionPage() {
  const [configs, setConfigs] = useState<AppConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [testingGateway, setTestingGateway] = useState<'stripe' | 'sumup' | null>(null);

  useEffect(() => {
    fetch('/api/admin/config')
      .then((r) => r.json())
      .then((d) => {
        setConfigs(d ?? []);
        const vals: Record<string, string> = {};
        (d ?? []).forEach((c: AppConfig) => { vals[c?.key ?? ''] = c?.value ?? ''; });
        setValues(vals);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const updateValue = (key: string, value: string) => {
    setValues((prev) => ({ ...(prev ?? {}), [key]: value }));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const configsToSave = Object.entries(values ?? {}).map(([key, value]) => {
        const existing = configs?.find((c) => c?.key === key);
        return { key, value, label: existing?.label ?? key, group: existing?.group ?? 'general' };
      });
      await fetch('/api/admin/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ configs: configsToSave }),
      });
      toast.success('Configuración guardada');
    } catch {
      toast.error('Error al guardar');
    } finally {
      setSaving(false);
    }
  };

  const testGateway = async (gateway: 'stripe' | 'sumup') => {
    setTestingGateway(gateway);
    try {
      const body =
        gateway === 'stripe'
          ? { gateway, secretKey: values?.stripe_secret_key ?? '' }
          : { gateway, apiKey: values?.sumup_api_key ?? '', merchantCode: values?.sumup_merchant_code ?? '' };
      const res = await fetch('/api/admin/config/test-gateway', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data?.ok) {
        toast.success(gateway === 'stripe' ? 'Conexión con Stripe correcta' : 'Conexión con SumUp correcta');
      } else {
        toast.error(data?.error ?? 'No se ha podido conectar');
      }
    } catch {
      toast.error('Error de conexión');
    } finally {
      setTestingGateway(null);
    }
  };

  if (loading) return <div className="flex justify-center py-20"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <PageHeader title="Configuración" description="Ajustes globales de la aplicación" />
        <Button onClick={handleSave} disabled={saving} className="gap-2">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Guardar
        </Button>
      </div>

      <Tabs defaultValue="payment">
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="payment" className="gap-2"><CreditCard className="h-3.5 w-3.5" /> Pagos</TabsTrigger>
          <TabsTrigger value="content" className="gap-2"><Sparkles className="h-3.5 w-3.5" /> Contenido</TabsTrigger>
          <TabsTrigger value="social" className="gap-2"><Globe className="h-3.5 w-3.5" /> Redes sociales</TabsTrigger>
          <TabsTrigger value="smtp" className="gap-2"><Send className="h-3.5 w-3.5" /> Email</TabsTrigger>
          <TabsTrigger value="wallet" className="gap-2"><Wallet className="h-3.5 w-3.5" /> Wallets</TabsTrigger>
          <TabsTrigger value="abacus" className="gap-2"><Clapperboard className="h-3.5 w-3.5" /> Vídeo IA</TabsTrigger>
          <TabsTrigger value="security" className="gap-2"><ShieldAlert className="h-3.5 w-3.5" /> Seguridad</TabsTrigger>
          <TabsTrigger value="legal" className="gap-2"><FileText className="h-3.5 w-3.5" /> Legal</TabsTrigger>
          <TabsTrigger value="general" className="gap-2"><Mail className="h-3.5 w-3.5" /> General</TabsTrigger>
        </TabsList>

        <TabsContent value="payment">
          <Card><CardContent className="p-6 space-y-4">
            <div>
              <Label>Pasarela de pago activa</Label>
              <Select value={values?.payment_gateway ?? 'mock'} onValueChange={(v: string) => updateValue('payment_gateway', v)}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="mock">Desactivada (modo prueba)</SelectItem>
                  <SelectItem value="stripe">Stripe</SelectItem>
                  <SelectItem value="sumup">SumUp</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="rounded-lg border border-border p-4 space-y-4">
              <h4 className="font-semibold text-sm">Stripe</h4>
              <ConfigField label="Publishable Key" value={values?.stripe_publishable_key ?? ''} onChange={(v) => updateValue('stripe_publishable_key', v)} placeholder="pk_..." />
              <ConfigField label="Secret Key" type="password" value={values?.stripe_secret_key ?? ''} onChange={(v) => updateValue('stripe_secret_key', v)} placeholder="sk_..." />
              <ConfigField
                label="Webhook Secret"
                type="password"
                value={values?.stripe_webhook_secret ?? ''}
                onChange={(v) => updateValue('stripe_webhook_secret', v)}
                placeholder="whsec_..."
                description="En Stripe Dashboard → Developers → Webhooks, crea un endpoint apuntando a /api/webhooks/stripe escuchando checkout.session.completed, checkout.session.async_payment_succeeded, checkout.session.async_payment_failed y checkout.session.expired. Copia aquí el 'Signing secret' que te da Stripe al crearlo."
              />
              <Button type="button" variant="outline" size="sm" className="gap-2" disabled={testingGateway === 'stripe'} onClick={() => testGateway('stripe')}>
                {testingGateway === 'stripe' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
                Probar conexión con Stripe
              </Button>
            </div>

            <div className="rounded-lg border border-border p-4 space-y-4">
              <h4 className="font-semibold text-sm">SumUp</h4>
              <ConfigField label="API Key" type="password" value={values?.sumup_api_key ?? ''} onChange={(v) => updateValue('sumup_api_key', v)} />
              <ConfigField
                label="Merchant Code"
                value={values?.sumup_merchant_code ?? ''}
                onChange={(v) => updateValue('sumup_merchant_code', v)}
                placeholder="MC..."
                description="Lo encuentras en tu cuenta de SumUp, en Ajustes → Datos de la cuenta. Es obligatorio para crear cobros, la API key sola no basta."
              />
              <Button type="button" variant="outline" size="sm" className="gap-2" disabled={testingGateway === 'sumup'} onClick={() => testGateway('sumup')}>
                {testingGateway === 'sumup' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
                Probar conexión con SumUp
              </Button>
            </div>

            <ConfigField label="Comisión por entrada (%)" type="number" value={values?.commission_percentage ?? '0'} onChange={(v) => updateValue('commission_percentage', v)} />
          </CardContent></Card>
        </TabsContent>

        <TabsContent value="content">
          <Card><CardContent className="p-6 space-y-4">
            <p className="text-sm text-muted-foreground">Textos que se muestran en la home y el footer de la web pública. Déjalos vacíos para usar el texto por defecto.</p>
            <div className="rounded-lg border border-border p-4 space-y-4">
              <h4 className="font-semibold text-sm">Home</h4>
              <ConfigField
                label="Badge del hero (cuando no hay próximo evento)"
                value={values?.home_hero_badge_fallback ?? ''}
                onChange={(v) => updateValue('home_hero_badge_fallback', v)}
              />
              <ConfigField label="Subtítulo principal" value={values?.home_hero_subtitle_1 ?? ''} onChange={(v) => updateValue('home_hero_subtitle_1', v)} />
              <ConfigField label="Subtítulo secundario" value={values?.home_hero_subtitle_2 ?? ''} onChange={(v) => updateValue('home_hero_subtitle_2', v)} />
              <ConfigField label="Título del CTA de sponsors" value={values?.home_sponsors_cta_title ?? ''} onChange={(v) => updateValue('home_sponsors_cta_title', v)} />
              <ConfigField label="Subtítulo del CTA de sponsors" value={values?.home_sponsors_cta_subtitle ?? ''} onChange={(v) => updateValue('home_sponsors_cta_subtitle', v)} />
            </div>
            <div className="rounded-lg border border-border p-4 space-y-4">
              <h4 className="font-semibold text-sm">Footer</h4>
              <ConfigField label="Tagline" value={values?.footer_tagline ?? ''} onChange={(v) => updateValue('footer_tagline', v)} />
              <ConfigField label="Copyright" value={values?.footer_copyright ?? ''} onChange={(v) => updateValue('footer_copyright', v)} />
            </div>
          </CardContent></Card>
        </TabsContent>

        <TabsContent value="social">
          <Card><CardContent className="p-6 space-y-4">
            <ConfigField label="Instagram" value={values?.social_instagram ?? ''} onChange={(v) => updateValue('social_instagram', v)} placeholder="https://instagram.com/lagrailla" />
            <ConfigField label="TikTok" value={values?.social_tiktok ?? ''} onChange={(v) => updateValue('social_tiktok', v)} placeholder="https://tiktok.com/@lagrailla" />
            <ConfigField label="Twitter/X" value={values?.social_twitter ?? ''} onChange={(v) => updateValue('social_twitter', v)} />
            <ConfigField label="Facebook" value={values?.social_facebook ?? ''} onChange={(v) => updateValue('social_facebook', v)} />
          </CardContent></Card>
        </TabsContent>

        <TabsContent value="smtp">
          <Card><CardContent className="p-6 space-y-4">
            <p className="text-sm text-muted-foreground">Si activas el SMTP propio, las entradas se enviarán como PDF adjunto desde tu servidor de correo. Si lo dejas desactivado, se usará el servicio de correo integrado y el PDF se enviará como enlace de descarga.</p>
            <div>
              <Label>Envío por SMTP propio</Label>
              <Select value={values?.smtp_enabled ?? 'false'} onValueChange={(v: string) => updateValue('smtp_enabled', v)}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="false">Desactivado (servicio integrado)</SelectItem>
                  <SelectItem value="true">Activado</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <ConfigField label="Servidor SMTP" value={values?.smtp_host ?? ''} onChange={(v) => updateValue('smtp_host', v)} placeholder="smtp.tudominio.com" />
              <ConfigField label="Puerto" value={values?.smtp_port ?? ''} onChange={(v) => updateValue('smtp_port', v)} placeholder="587" />
              <ConfigField label="Usuario" value={values?.smtp_user ?? ''} onChange={(v) => updateValue('smtp_user', v)} />
              <ConfigField label="Contraseña" type="password" value={values?.smtp_password ?? ''} onChange={(v) => updateValue('smtp_password', v)} />
              <div>
                <Label>Conexión segura (SSL/TLS)</Label>
                <Select value={values?.smtp_secure ?? 'true'} onValueChange={(v: string) => updateValue('smtp_secure', v)}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="true">Sí (puerto 465)</SelectItem>
                    <SelectItem value="false">No (STARTTLS, puerto 587)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <ConfigField label="Email remitente" value={values?.smtp_from_email ?? ''} onChange={(v) => updateValue('smtp_from_email', v)} placeholder="entradas@tudominio.com" />
              <ConfigField label="Nombre remitente" value={values?.smtp_from_name ?? ''} onChange={(v) => updateValue('smtp_from_name', v)} placeholder="La Grailla" />
            </div>
          </CardContent></Card>
        </TabsContent>

        <TabsContent value="wallet">
          <Card><CardContent className="p-6 space-y-6">
            <p className="text-sm text-muted-foreground">Los botones de Apple Wallet y Google Wallet solo aparecen en las entradas cuando estas credenciales están completas. Requieren una cuenta de desarrollador de Apple y un emisor de Google Wallet.</p>
            <div className="rounded-lg border border-border p-4 space-y-4">
              <h4 className="font-semibold text-sm">Google Wallet</h4>
              <ConfigField label="Issuer ID" value={values?.google_wallet_issuer_id ?? ''} onChange={(v) => updateValue('google_wallet_issuer_id', v)} placeholder="3388000000022..." />
              <ConfigField label="Service Account JSON" type="textarea" rows={5} value={values?.google_wallet_service_account ?? ''} onChange={(v) => updateValue('google_wallet_service_account', v)} placeholder='{"client_email": "...", "private_key": "..."}' />
            </div>
            <div className="rounded-lg border border-border p-4 space-y-4">
              <h4 className="font-semibold text-sm">Apple Wallet</h4>
              <div>
                <Label>Activar Apple Wallet</Label>
                <Select value={values?.apple_wallet_enabled ?? 'false'} onValueChange={(v: string) => updateValue('apple_wallet_enabled', v)}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="false">Desactivado</SelectItem>
                    <SelectItem value="true">Activado</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <ConfigField label="Pass Type ID" value={values?.apple_wallet_pass_type_id ?? ''} onChange={(v) => updateValue('apple_wallet_pass_type_id', v)} placeholder="pass.com.lagrailla.entrada" />
                <ConfigField label="Team ID" value={values?.apple_wallet_team_id ?? ''} onChange={(v) => updateValue('apple_wallet_team_id', v)} />
                <ConfigField label="Contraseña del certificado" type="password" value={values?.apple_wallet_cert_password ?? ''} onChange={(v) => updateValue('apple_wallet_cert_password', v)} />
              </div>
              <ConfigField label="Certificado .p12 (en base64)" type="textarea" rows={4} value={values?.apple_wallet_cert_p12_base64 ?? ''} onChange={(v) => updateValue('apple_wallet_cert_p12_base64', v)} />
            </div>
          </CardContent></Card>
        </TabsContent>

        <TabsContent value="abacus">
          <Card><CardContent className="p-6 space-y-4">
            <p className="text-sm text-muted-foreground">
              Se usa en el Portal de Sponsors (`/admin/sponsors-portal`) para generar el prompt de
              vídeo ES/EN a partir del logo y las respuestas del sponsor. Sin API key, ese botón usa
              un texto de ejemplo (modo mock) — útil para probar el flujo sin gastar generaciones reales.
            </p>
            <ConfigField
              label="API Key de Abacus.AI"
              type="password"
              value={values?.abacus_ai_api_key ?? ''}
              onChange={(v) => updateValue('abacus_ai_api_key', v)}
              description="La API key de tu cuenta de Abacus.AI (ChatLLM). El contrato exacto del endpoint no se ha podido verificar contra documentación en vivo — si al generar un prompt real ves un error, puede que el payload/endpoint necesiten un ajuste en lib/abacus-ai-adapter.ts."
            />
          </CardContent></Card>
        </TabsContent>

        <TabsContent value="security">
          <Card><CardContent className="p-6 space-y-4">
            <p className="text-sm text-muted-foreground">Límite anti-abuso de compras por IP. Se aplica de forma global a todos los eventos, para evitar bots o compras masivas automatizadas.</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <ConfigField label="Máx. pedidos por IP" type="number" value={values?.orders_rate_limit_per_ip ?? '10'} onChange={(v) => updateValue('orders_rate_limit_per_ip', v)} />
              <ConfigField label="Ventana de tiempo (segundos)" type="number" value={values?.orders_rate_limit_window_seconds ?? '60'} onChange={(v) => updateValue('orders_rate_limit_window_seconds', v)} />
            </div>
            <p className="text-xs text-muted-foreground">Con los valores por defecto, una misma IP no puede crear más de 10 pedidos cada 60 segundos. Si el lanzamiento espera mucho tráfico legítimo desde la misma red (wifi compartido, datos móviles), sube estos valores.</p>
          </CardContent></Card>
        </TabsContent>

        <TabsContent value="legal">
          <Card><CardContent className="p-6 space-y-4">
            <ConfigField label="Aviso Legal" type="textarea" rows={6} value={values?.legal_notice ?? ''} onChange={(v) => updateValue('legal_notice', v)} />
            <ConfigField label="Política de Privacidad" type="textarea" rows={6} value={values?.privacy_policy ?? ''} onChange={(v) => updateValue('privacy_policy', v)} />
            <ConfigField label="Política de Cookies" type="textarea" rows={6} value={values?.cookies_policy ?? ''} onChange={(v) => updateValue('cookies_policy', v)} />
          </CardContent></Card>
        </TabsContent>

        <TabsContent value="general">
          <Card><CardContent className="p-6 space-y-4">
            <ConfigField label="Email de administración" value={values?.admin_email ?? ''} onChange={(v) => updateValue('admin_email', v)} />
            <div>
              <Label>Banner de cookies</Label>
              <Select value={values?.cookies_banner_enabled ?? 'true'} onValueChange={(v: string) => updateValue('cookies_banner_enabled', v)}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="true">Mostrar</SelectItem>
                  <SelectItem value="false">Ocultar</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardContent></Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
