'use client';

import { useEffect, useState } from 'react';
import type { AppConfig } from '@prisma/client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2, Save, CreditCard, Mail, Globe, FileText, Send, Wallet, Ticket } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/layouts/page-header';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

export default function ConfiguracionPage() {
  const [configs, setConfigs] = useState<AppConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});

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

  const handleChange = (key: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    updateValue(key, e.target.value ?? '');

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
        <TabsList>
          <TabsTrigger value="payment" className="gap-2"><CreditCard className="h-3.5 w-3.5" /> Pagos</TabsTrigger>
          <TabsTrigger value="social" className="gap-2"><Globe className="h-3.5 w-3.5" /> Redes</TabsTrigger>
          <TabsTrigger value="smtp" className="gap-2"><Send className="h-3.5 w-3.5" /> Email SMTP</TabsTrigger>
          <TabsTrigger value="wallet" className="gap-2"><Wallet className="h-3.5 w-3.5" /> Wallet</TabsTrigger>
          <TabsTrigger value="tickets" className="gap-2"><Ticket className="h-3.5 w-3.5" /> Entradas</TabsTrigger>
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
            <div><Label>Stripe Publishable Key</Label><Input value={values?.stripe_publishable_key ?? ''} onChange={handleChange('stripe_publishable_key')} className="mt-1" placeholder="pk_..." /></div>
            <div><Label>Stripe Secret Key</Label><Input type="password" value={values?.stripe_secret_key ?? ''} onChange={handleChange('stripe_secret_key')} className="mt-1" placeholder="sk_..." /></div>
            <div>
              <Label>Stripe Webhook Secret</Label>
              <Input type="password" value={values?.stripe_webhook_secret ?? ''} onChange={handleChange('stripe_webhook_secret')} className="mt-1" placeholder="whsec_..." />
              <p className="text-xs text-muted-foreground mt-1">
                En Stripe Dashboard → Developers → Webhooks, crea un endpoint apuntando a <code>/api/webhooks/stripe</code> escuchando
                {' '}<code>checkout.session.completed</code>, <code>checkout.session.async_payment_succeeded</code>, <code>checkout.session.async_payment_failed</code> y <code>checkout.session.expired</code>. Copia aquí el "Signing secret" que te da Stripe al crearlo.
              </p>
            </div>
            <div><Label>SumUp API Key</Label><Input type="password" value={values?.sumup_api_key ?? ''} onChange={handleChange('sumup_api_key')} className="mt-1" /></div>
            <div>
              <Label>SumUp Merchant Code</Label>
              <Input value={values?.sumup_merchant_code ?? ''} onChange={handleChange('sumup_merchant_code')} className="mt-1" placeholder="MC..." />
              <p className="text-xs text-muted-foreground mt-1">Lo encuentras en tu cuenta de SumUp, en Ajustes → Datos de la cuenta. Es obligatorio para crear cobros, la API key sola no basta.</p>
            </div>
            <div><Label>Comisión por entrada (%)</Label><Input type="number" step="0.1" value={values?.commission_percentage ?? '0'} onChange={handleChange('commission_percentage')} className="mt-1" /></div>
          </CardContent></Card>
        </TabsContent>

        <TabsContent value="social">
          <Card><CardContent className="p-6 space-y-4">
            <div><Label>Instagram</Label><Input value={values?.social_instagram ?? ''} onChange={handleChange('social_instagram')} className="mt-1" placeholder="https://instagram.com/lagrailla" /></div>
            <div><Label>TikTok</Label><Input value={values?.social_tiktok ?? ''} onChange={handleChange('social_tiktok')} className="mt-1" placeholder="https://tiktok.com/@lagrailla" /></div>
            <div><Label>Twitter/X</Label><Input value={values?.social_twitter ?? ''} onChange={handleChange('social_twitter')} className="mt-1" /></div>
            <div><Label>Facebook</Label><Input value={values?.social_facebook ?? ''} onChange={handleChange('social_facebook')} className="mt-1" /></div>
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
              <div><Label>Servidor SMTP</Label><Input value={values?.smtp_host ?? ''} onChange={handleChange('smtp_host')} className="mt-1" placeholder="smtp.tudominio.com" /></div>
              <div><Label>Puerto</Label><Input value={values?.smtp_port ?? ''} onChange={handleChange('smtp_port')} className="mt-1" placeholder="587" /></div>
              <div><Label>Usuario</Label><Input value={values?.smtp_user ?? ''} onChange={handleChange('smtp_user')} className="mt-1" /></div>
              <div><Label>Contraseña</Label><Input type="password" value={values?.smtp_password ?? ''} onChange={handleChange('smtp_password')} className="mt-1" /></div>
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
              <div><Label>Email remitente</Label><Input value={values?.smtp_from_email ?? ''} onChange={handleChange('smtp_from_email')} className="mt-1" placeholder="entradas@tudominio.com" /></div>
              <div><Label>Nombre remitente</Label><Input value={values?.smtp_from_name ?? ''} onChange={handleChange('smtp_from_name')} className="mt-1" placeholder="La Grailla" /></div>
            </div>
          </CardContent></Card>
        </TabsContent>

        <TabsContent value="wallet">
          <Card><CardContent className="p-6 space-y-6">
            <p className="text-sm text-muted-foreground">Los botones de Apple Wallet y Google Wallet solo aparecen en las entradas cuando estas credenciales están completas. Requieren una cuenta de desarrollador de Apple y un emisor de Google Wallet.</p>
            <div className="space-y-4">
              <h4 className="font-semibold">Google Wallet</h4>
              <div><Label>Issuer ID</Label><Input value={values?.google_wallet_issuer_id ?? ''} onChange={handleChange('google_wallet_issuer_id')} className="mt-1" placeholder="3388000000022..." /></div>
              <div><Label>Service Account JSON</Label><Textarea value={values?.google_wallet_service_account ?? ''} onChange={handleChange('google_wallet_service_account')} className="mt-1 font-mono text-xs" rows={5} placeholder='{"client_email": "...", "private_key": "..."}' /></div>
            </div>
            <div className="space-y-4 border-t border-border pt-6">
              <h4 className="font-semibold">Apple Wallet</h4>
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
                <div><Label>Pass Type ID</Label><Input value={values?.apple_wallet_pass_type_id ?? ''} onChange={handleChange('apple_wallet_pass_type_id')} className="mt-1" placeholder="pass.com.lagrailla.entrada" /></div>
                <div><Label>Team ID</Label><Input value={values?.apple_wallet_team_id ?? ''} onChange={handleChange('apple_wallet_team_id')} className="mt-1" /></div>
                <div><Label>Contraseña del certificado</Label><Input type="password" value={values?.apple_wallet_cert_password ?? ''} onChange={handleChange('apple_wallet_cert_password')} className="mt-1" /></div>
              </div>
              <div><Label>Certificado .p12 (en base64)</Label><Textarea value={values?.apple_wallet_cert_p12_base64 ?? ''} onChange={handleChange('apple_wallet_cert_p12_base64')} className="mt-1 font-mono text-xs" rows={4} /></div>
            </div>
          </CardContent></Card>
        </TabsContent>

        <TabsContent value="tickets">
          <Card><CardContent className="p-6 space-y-4">
            <p className="text-sm text-muted-foreground">Límite anti-abuso de compras por IP. Se aplica de forma global a todos los eventos, para evitar bots o compras masivas automatizadas.</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <div><Label>Máx. pedidos por IP</Label><Input type="number" min={1} value={values?.orders_rate_limit_per_ip ?? '10'} onChange={handleChange('orders_rate_limit_per_ip')} className="mt-1" /></div>
              <div><Label>Ventana de tiempo (segundos)</Label><Input type="number" min={1} value={values?.orders_rate_limit_window_seconds ?? '60'} onChange={handleChange('orders_rate_limit_window_seconds')} className="mt-1" /></div>
            </div>
            <p className="text-xs text-muted-foreground">Con los valores por defecto, una misma IP no puede crear más de 10 pedidos cada 60 segundos. Si el lanzamiento espera mucho tráfico legítimo desde la misma red (wifi compartido, datos móviles), sube estos valores.</p>
          </CardContent></Card>
        </TabsContent>

        <TabsContent value="legal">
          <Card><CardContent className="p-6 space-y-4">
            <div><Label>Aviso Legal</Label><Textarea value={values?.legal_notice ?? ''} onChange={handleChange('legal_notice')} className="mt-1" rows={6} /></div>
            <div><Label>Política de Privacidad</Label><Textarea value={values?.privacy_policy ?? ''} onChange={handleChange('privacy_policy')} className="mt-1" rows={6} /></div>
            <div><Label>Política de Cookies</Label><Textarea value={values?.cookies_policy ?? ''} onChange={handleChange('cookies_policy')} className="mt-1" rows={6} /></div>
          </CardContent></Card>
        </TabsContent>

        <TabsContent value="general">
          <Card><CardContent className="p-6 space-y-4">
            <div><Label>Email de administración</Label><Input value={values?.admin_email ?? ''} onChange={handleChange('admin_email')} className="mt-1" /></div>
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
