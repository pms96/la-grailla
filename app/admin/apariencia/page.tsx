'use client';

import { useEffect, useMemo, useState } from 'react';
import { Loader2, Save, RotateCcw, Palette, Type, Image as ImageIcon, LayoutTemplate, Sparkles, TriangleAlert, Film } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PageHeader } from '@/components/layouts/page-header';
import { cn } from '@/lib/utils';
import { ImageUploadField } from '@/app/admin/_components/image-upload-field';
import { VideoUploadField } from '@/app/admin/_components/video-upload-field';
import {
  FONT_CATALOG, FONT_KEYS, MODES, RADII, RADIUS_VALUE, TEMPLATES, TEMPLATE_LABELS, TEMPLATE_PRESETS,
  deriveTokens, hexToHsl, hslToHex, themeContrastIssues, themeContrastWarnings,
  type FontKey, type ModeKey, type RadiusKey, type SiteTheme, type TemplateKey, type TokenSet,
} from '@/lib/brand/theme';

/* Apariencia: logo, colores, tipografías, forma de las esquinas, plantilla y textos de marca del cliente. Lo que se elige aquí es lo ÚNICO
 * que cambia la web: el resto de colores (texto, bordes, tarjetas…) se deriva con contraste legible. La vista previa usa el mismo cálculo
 * que el servidor, así que lo que se ve es lo que se publica. */

const MODE_LABELS: Record<ModeKey, string> = { dark: 'Oscuro', light: 'Claro', system: 'El del dispositivo' };
const RADIUS_LABELS: Record<RadiusKey, string> = { recto: 'Rectas', suave: 'Suaves', redondo: 'Redondeadas' };

type Loaded = { theme: SiteTheme; saved: boolean; legacy: boolean };

function tokenStyle(set: TokenSet, radius: RadiusKey): React.CSSProperties {
  const vars: Record<string, string> = { '--radius': RADIUS_VALUE[radius] };
  for (const [k, v] of Object.entries(set)) vars[`--${k}`] = v;
  return vars as React.CSSProperties;
}

function ColorField({ label, hint, value, onChange }: { label: string; hint?: string; value: string; onChange: (hex: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <div>
      <Label>{label}</Label>
      <div className="mt-1 flex items-center gap-2">
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value.toLowerCase())}
          aria-label={label}
          className="h-10 w-12 cursor-pointer rounded-md border border-input bg-background p-1"
        />
        <Input
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (/^#[0-9a-fA-F]{6}$/.test(e.target.value)) onChange(e.target.value.toLowerCase());
          }}
          className="font-mono w-32"
          spellCheck={false}
          aria-label={`${label} (hexadecimal)`}
        />
      </div>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function OptionalColorField({ label, hint, value, auto, onChange }: { label: string; hint: string; value: string | undefined; auto: string; onChange: (hex: string | undefined) => void }) {
  return (
    <div className="space-y-2">
      <ColorField label={label} value={value ?? auto} onChange={onChange} hint={hint} />
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <Switch checked={value === undefined} onCheckedChange={(on: boolean) => onChange(on ? undefined : auto)} />
        Calcular automáticamente a partir del color principal
      </label>
    </div>
  );
}

/** Maqueta de la web con los colores calculados. Los componentes usan los tokens, así que se ven igual que en el sitio. */
function Preview({ theme, mode }: { theme: SiteTheme; mode: 'light' | 'dark' }) {
  const set = deriveTokens(theme)[mode];
  const logo = mode === 'dark' ? (theme.assets.logoOnDark ?? theme.assets.logoOnLight) : (theme.assets.logoOnLight ?? theme.assets.logoOnDark);
  const display = `var(${FONT_CATALOG[theme.fonts.display].cssVar}), system-ui, sans-serif`;
  const body = `var(${FONT_CATALOG[theme.fonts.body].cssVar}), system-ui, sans-serif`;
  const feria = theme.template === 'feria';
  return (
    <div
      className={cn('overflow-hidden rounded-lg border border-border text-sm', mode === 'dark' && 'dark')}
      style={{ ...tokenStyle(set, theme.radius), background: 'hsl(var(--background))', color: 'hsl(var(--foreground))', fontFamily: body }}
      aria-label={`Vista previa en modo ${mode === 'dark' ? 'oscuro' : 'claro'}`}
    >
      <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: 'hsl(var(--border))' }}>
        {logo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logo} alt="" className="h-6 w-auto object-contain" />
        ) : (
          <span className="text-base font-bold" style={{ fontFamily: display }}>{theme.brand.name || 'Tu marca'}</span>
        )}
        <div className="flex items-center gap-3 text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>
          <span>Eventos</span><span>Tienda</span>
          {feria && theme.brand.sticker && (
            <span className="brand-sticker !px-2 !py-0.5 text-xs" style={{ color: 'hsl(var(--lima))' }}>{theme.brand.sticker}</span>
          )}
        </div>
      </div>
      {theme.template === 'marquesina' ? (
        <div>
          <div className="px-4 pb-4 pt-6">
            <p className="mb-2 text-xs uppercase tracking-[0.14em]" style={{ color: 'hsl(var(--muted-foreground))' }}>Próximo evento</p>
            <h3 className="break-words text-5xl uppercase leading-[0.86]" style={{ fontFamily: display }}>{theme.brand.name || 'Tu marca'}</h3>
          </div>
          <div className="whitespace-nowrap px-4 py-2 text-lg uppercase" style={{ background: 'hsl(var(--accent))', color: 'hsl(var(--accent-foreground))', fontFamily: display }}>
            Sáb 14 nov / Tu sala / Entradas / Sáb 14 nov
          </div>
        </div>
      ) : theme.template === 'tipo' ? (
        <div>
          <div className="flex items-end justify-between gap-3 px-4 pb-4 pt-6" style={{ background: 'hsl(var(--primary))', color: 'hsl(var(--primary-foreground))' }}>
            <h3 className="break-words text-4xl leading-[0.9]" style={{ fontFamily: display, fontWeight: 800, letterSpacing: '-0.04em' }}>{theme.brand.name || 'Tu marca'}</h3>
            <span className="grid h-14 w-14 shrink-0 grid-cols-2 grid-rows-2" aria-hidden>
              <span className="rounded-full" style={{ background: 'hsl(var(--accent))' }} />
              <span style={{ background: 'hsl(var(--primary-foreground))' }} />
              <span style={{ background: 'hsl(var(--foreground))' }} />
              <span className="rounded-tl-full" style={{ background: 'hsl(var(--accent))' }} />
            </span>
          </div>
          <div className="whitespace-nowrap px-4 py-2 text-sm font-extrabold uppercase" style={{ background: 'hsl(var(--foreground))', color: 'hsl(var(--background))', fontFamily: display }}>
            Sáb 14 nov / Tu sala / Entradas / Sáb 14 nov
          </div>
        </div>
      ) : theme.template === 'drop' ? (
        <div>
          <div className="px-4 pb-5 pt-6" style={{ background: 'hsl(var(--primary))', color: 'hsl(var(--primary-foreground))' }}>
            <p className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] opacity-75">{theme.brand.name || 'Tu marca'}</p>
            <h3 className="text-4xl leading-[0.94]" style={{ fontFamily: display, fontWeight: 700, letterSpacing: '-0.04em' }}>{theme.brand.tagline || 'Tu tienda'}</h3>
          </div>
          <div className="flex gap-2 px-4 py-4" aria-hidden>
            {['hsl(var(--primary))', 'hsl(var(--accent))', 'hsl(var(--muted))'].map((bg, i) => (
              <span key={i} className="relative block h-24 flex-1 rounded-md" style={{ background: bg }}>
                <span className="absolute bottom-1.5 left-1.5 -rotate-3 rounded px-1.5 text-xs font-bold" style={{ background: 'hsl(var(--accent))', color: 'hsl(var(--accent-foreground))', fontFamily: display }}>19,00€</span>
              </span>
            ))}
          </div>
        </div>
      ) : theme.template === 'cine' ? (
        <div className="relative overflow-hidden px-4 pb-5 pt-14">
          <div className="absolute inset-0" style={{ background: 'radial-gradient(ellipse at 70% 10%, hsl(var(--primary) / 0.4), transparent 60%)' }} aria-hidden />
          <p className="relative mb-2 text-xs uppercase tracking-[0.2em]" style={{ color: 'hsl(var(--muted-foreground))' }}>Próximo evento</p>
          <h3 className="relative text-4xl leading-[0.98]" style={{ fontFamily: display, fontWeight: 500, letterSpacing: '-0.02em' }}>{theme.brand.name || 'Tu marca'}</h3>
          <div className="relative mt-5 flex gap-2" aria-hidden>
            {[0, 1, 2].map((i) => (
              <span key={i} className="block h-20 w-14 shrink-0" style={{ background: i === 0 ? 'hsl(var(--primary))' : 'hsl(var(--muted))' }} />
            ))}
          </div>
        </div>
      ) : theme.template === 'estudio' ? (
        <div className="px-4 pb-5 pt-6">
          <p className="mb-3 text-xs uppercase tracking-[0.14em]" style={{ color: 'hsl(var(--muted-foreground))' }}>{theme.brand.name || 'Tu marca'}</p>
          <h3 className="text-3xl leading-[1.02]" style={{ fontFamily: display, fontWeight: 500, letterSpacing: '-0.035em' }}>
            {theme.brand.tagline || 'Una frase que cuente qué hacéis'}
          </h3>
          <div className="mt-5 border-t" style={{ borderColor: 'hsl(var(--border))' }}>
            {['Proyecto uno', 'Proyecto dos'].map((name, i) => (
              <div key={name} className="flex items-baseline justify-between gap-3 border-b py-2" style={{ borderColor: 'hsl(var(--border))', opacity: i === 0 ? 1 : 0.4 }}>
                <span className="text-lg" style={{ fontFamily: display, fontWeight: 500, letterSpacing: '-0.03em' }}>{name}</span>
                <span className="text-[10px] uppercase tracking-wider" style={{ color: 'hsl(var(--muted-foreground))' }}>Cliente · 2025</span>
              </div>
            ))}
          </div>
        </div>
      ) : theme.template === 'galeria' ? (
        <div className="px-4 pb-6 pt-6">
          <p className="mb-3 text-xs uppercase tracking-[0.14em]" style={{ color: 'hsl(var(--muted-foreground))' }}>Próximo evento</p>
          <h3 className="break-words text-4xl leading-[0.95]" style={{ fontFamily: display, fontWeight: 400 }}>{theme.brand.name || 'Tu marca'}</h3>
          <div className="mt-5 flex items-end justify-between gap-4 border-t pt-3 text-xs" style={{ borderColor: 'hsl(var(--border))' }}>
            <span style={{ color: 'hsl(var(--muted-foreground))' }}>Sábado, 14 de noviembre<br />Tu sala, tu ciudad</span>
            <span className="block h-20 w-16 shrink-0" style={{ background: 'hsl(var(--primary) / 0.1)' }} aria-hidden />
          </div>
        </div>
      ) : (
      <div className={cn('relative px-4 py-8', feria && 'hero-gradient')}>
        <p className="mb-3 text-xs font-semibold uppercase tracking-[0.2em]" style={{ color: 'hsl(var(--muted-foreground))' }}>Próximo evento</p>
        <h3 className={cn('mb-2 text-2xl leading-tight', feria ? 'font-bold' : 'font-semibold tracking-tight')} style={{ fontFamily: display }}>
          {theme.brand.tagline || 'Una frase que cuente quién eres'}
        </h3>
        <p className="mb-4 max-w-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>Así se ve el texto normal de tu web.</p>
        <div className="flex items-center gap-2">
          <span
            className={cn('inline-flex h-9 items-center px-4 text-sm font-semibold', feria ? 'rounded-full' : 'rounded-md')}
            style={{ background: 'hsl(var(--primary))', color: 'hsl(var(--primary-foreground))', fontFamily: display }}
          >
            Comprar entradas
          </span>
          <span
            className="inline-flex h-9 items-center rounded-md px-3 text-sm font-semibold"
            style={{ background: 'hsl(var(--accent))', color: 'hsl(var(--accent-foreground))', fontFamily: display }}
          >
            Acento
          </span>
        </div>
      </div>
      )}
      <div className="grid grid-cols-2 gap-3 border-t p-4" style={{ borderColor: 'hsl(var(--border))' }}>
        {['Tarjeta', 'Otra tarjeta'].map((t) => (
          <div key={t} className="rounded-lg border p-3" style={{ borderColor: 'hsl(var(--border))', background: 'hsl(var(--card))', color: 'hsl(var(--card-foreground))' }}>
            <p className="font-semibold" style={{ fontFamily: display }}>{t}</p>
            <p className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>Texto secundario</p>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function AparienciaPage() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [theme, setTheme] = useState<SiteTheme | null>(null);
  const [saving, setSaving] = useState(false);

  const load = () =>
    fetch('/api/admin/theme')
      .then((r) => r.json())
      .then((d: Loaded) => {
        setLoaded(d);
        setTheme(d.theme);
      })
      .catch(() => toast.error('No se ha podido cargar la apariencia'));
  useEffect(() => {
    load();
  }, []);

  const issues = useMemo(() => (theme ? themeContrastIssues(theme) : []), [theme]);
  const warnings = useMemo(() => (theme ? themeContrastWarnings(theme) : []), [theme]);
  const dirty = useMemo(() => !!theme && !!loaded && JSON.stringify(theme) !== JSON.stringify(loaded.theme), [theme, loaded]);

  if (!theme || !loaded) {
    return <div className="flex justify-center py-20"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>;
  }

  const patch = (p: Partial<SiteTheme>) => setTheme((t) => (t ? { ...t, ...p } : t));
  const setColors = (c: Partial<SiteTheme['colors']>) => setTheme((t) => (t ? { ...t, colors: { ...t.colors, ...c } } : t));
  const setAssets = (a: Partial<SiteTheme['assets']>) =>
    setTheme((t) => {
      if (!t) return t;
      const assets = { ...t.assets, ...a };
      for (const k of Object.keys(assets) as (keyof typeof assets)[]) if (!assets[k]) delete assets[k]; // '' = quitar
      return { ...t, assets };
    });
  const setBrand = (b: Partial<SiteTheme['brand']>) => setTheme((t) => (t ? { ...t, brand: { ...t.brand, ...b } } : t));

  // Superficies por defecto (las que se calculan solas), para mostrarlas en el selector.
  const auto = deriveTokens({ colors: { primary: theme.colors.primary, accent: theme.colors.accent } });
  const hslTriplet = (v: string) => {
    const [h, s, l] = v.split(' ');
    return hslToHex({ h: parseFloat(h), s: parseFloat(s), l: parseFloat(l) });
  };

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/admin/theme', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(theme) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error([data?.error ?? 'No se ha podido guardar', ...(data?.details ?? [])].join(' '));
        return;
      }
      toast.success('Apariencia guardada');
      await load();
    } catch {
      toast.error('Error de conexión al guardar');
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    if (!window.confirm(loaded.legacy ? 'Volver a la apariencia original del sitio. ¿Seguro?' : 'Volver a la apariencia por defecto. ¿Seguro?')) return;
    const res = await fetch('/api/admin/theme', { method: 'DELETE' });
    if (!res.ok) return toast.error('No se ha podido restablecer');
    toast.success('Apariencia restablecida');
    await load();
  };

  const roleFonts = (role: 'display' | 'body') => FONT_KEYS.filter((k) => FONT_CATALOG[k].roles.includes(role));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Apariencia"
        description="Logo, colores, tipografías y textos de marca de tu web, de los emails y de los documentos."
        actions={
          <>
            {loaded.saved && (
              <Button variant="ghost" onClick={reset} className="gap-2">
                <RotateCcw className="h-4 w-4" /> Restablecer
              </Button>
            )}
            <Button onClick={save} disabled={saving || !dirty || issues.length > 0} className="gap-2">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Guardar
            </Button>
          </>
        }
      />

      {!loaded.saved && (
        <p className="rounded-md border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
          {loaded.legacy
            ? 'Ahora mismo se usa la apariencia original del sitio. Cuando guardes, la web pasará a usar lo que elijas aquí.'
            : 'Todavía no has personalizado tu apariencia: tu web usa un diseño neutro. Elige tu logo, tus colores y tus textos.'}
        </p>
      )}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
        <div className="space-y-6">
          <Card><CardContent className="space-y-4 p-6">
            <h2 className="flex items-center gap-2 font-display text-lg font-semibold"><Sparkles className="h-4 w-4 text-primary" /> Identidad</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="brand-name">Nombre</Label>
                <Input id="brand-name" className="mt-1" maxLength={60} value={theme.brand.name} onChange={(e) => setBrand({ name: e.target.value })} />
              </div>
              <div>
                <Label htmlFor="brand-legal">Razón social</Label>
                <Input id="brand-legal" className="mt-1" maxLength={100} value={theme.brand.legalName} onChange={(e) => setBrand({ legalName: e.target.value })} placeholder="Para el pie y los textos legales" />
              </div>
            </div>
            <div>
              <Label htmlFor="brand-tagline">Eslogan</Label>
              <Input id="brand-tagline" className="mt-1" maxLength={160} value={theme.brand.tagline} onChange={(e) => setBrand({ tagline: e.target.value })} placeholder="Una frase que explique qué haces" />
            </div>
            <div>
              <Label htmlFor="brand-desc">Descripción para buscadores y redes</Label>
              <Textarea id="brand-desc" className="mt-1" rows={3} maxLength={300} value={theme.brand.description} onChange={(e) => setBrand({ description: e.target.value })} />
              <p className="mt-1 text-xs text-muted-foreground">Si la dejas vacía se usa el eslogan.</p>
            </div>
            {theme.template === 'feria' && (
              <div>
                <Label htmlFor="brand-sticker">Pegatina de la cabecera</Label>
                <Input id="brand-sticker" className="mt-1 max-w-xs" maxLength={24} value={theme.brand.sticker} onChange={(e) => setBrand({ sticker: e.target.value })} placeholder="Opcional" />
              </div>
            )}
          </CardContent></Card>

          <Card><CardContent className="space-y-4 p-6">
            <h2 className="flex items-center gap-2 font-display text-lg font-semibold"><LayoutTemplate className="h-4 w-4 text-primary" /> Plantilla</h2>
            <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Plantilla de la portada">
              {TEMPLATES.map((t: TemplateKey) => (
                <button
                  key={t}
                  type="button"
                  role="radio"
                  aria-checked={theme.template === t}
                  onClick={() => patch({ template: t })}
                  className={cn(
                    'rounded-lg border-2 p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    theme.template === t ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/40'
                  )}
                >
                  <p className="font-display font-semibold">{TEMPLATE_LABELS[t].label}</p>
                  <p className="mt-1 text-sm text-muted-foreground">{TEMPLATE_LABELS[t].description}</p>
                </button>
              ))}
            </div>
            {(() => {
              const preset = TEMPLATE_PRESETS[theme.template];
              if (!preset) return null;
              const applied = theme.mode === preset.mode && theme.radius === preset.radius && theme.fonts.display === preset.fonts.display && theme.fonts.body === preset.fonts.body;
              if (applied) return null;
              return (
                <div className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-muted/30 p-3 text-sm">
                  <p className="min-w-0 flex-1">Esta plantilla luce mejor con {preset.note}.</p>
                  <Button type="button" size="sm" variant="outline" onClick={() => patch({ mode: preset.mode, radius: preset.radius, fonts: { ...preset.fonts } })}>
                    Usar ajustes recomendados
                  </Button>
                </div>
              );
            })()}
          </CardContent></Card>

          <Card><CardContent className="space-y-5 p-6">
            <h2 className="flex items-center gap-2 font-display text-lg font-semibold"><Palette className="h-4 w-4 text-primary" /> Colores</h2>
            <div className="grid gap-5 sm:grid-cols-2">
              <ColorField label="Color principal" hint="Botones, enlaces y detalles." value={theme.colors.primary} onChange={(hex) => setColors({ primary: hex })} />
              <ColorField label="Color de acento" hint="Destacados: pegatinas, etiquetas." value={theme.colors.accent} onChange={(hex) => setColors({ accent: hex })} />
              <OptionalColorField label="Fondo en modo oscuro" hint="El color de fondo de la web oscura." value={theme.colors.surfaceDark} auto={hslTriplet(auto.dark.background)} onChange={(hex) => setColors({ surfaceDark: hex })} />
              <OptionalColorField label="Fondo en modo claro" hint="El color de fondo de la web clara." value={theme.colors.surfaceLight} auto={hslTriplet(auto.light.background)} onChange={(hex) => setColors({ surfaceLight: hex })} />
            </div>
            {issues.length > 0 && (
              <div role="alert" className="flex gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive-text" />
                <ul className="space-y-1">{issues.map((i) => <li key={i}>{i} Elige un fondo o un color con más contraste.</li>)}</ul>
              </div>
            )}
            {issues.length === 0 && warnings.length > 0 && (
              <ul className="space-y-1 rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground" aria-label="Avisos de contraste">
                {warnings.map((w) => <li key={w}>{w} Puedes guardarlo igualmente.</li>)}
              </ul>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label>Modo por defecto</Label>
                <Select value={theme.mode} onValueChange={(v: string) => patch({ mode: v as ModeKey })}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>{MODES.map((m) => <SelectItem key={m} value={m}>{MODE_LABELS[m]}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div>
                <Label>Esquinas</Label>
                <Select value={theme.radius} onValueChange={(v: string) => patch({ radius: v as RadiusKey })}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>{RADII.map((r) => <SelectItem key={r} value={r}>{RADIUS_LABELS[r]}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            </div>
          </CardContent></Card>

          <Card><CardContent className="space-y-4 p-6">
            <h2 className="flex items-center gap-2 font-display text-lg font-semibold"><Type className="h-4 w-4 text-primary" /> Tipografías</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label>Titulares</Label>
                <Select value={theme.fonts.display} onValueChange={(v: string) => patch({ fonts: { ...theme.fonts, display: v as FontKey } })}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>{roleFonts('display').map((k) => <SelectItem key={k} value={k}>{FONT_CATALOG[k].label}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div>
                <Label>Texto</Label>
                <Select value={theme.fonts.body} onValueChange={(v: string) => patch({ fonts: { ...theme.fonts, body: v as FontKey } })}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>{roleFonts('body').map((k) => <SelectItem key={k} value={k}>{FONT_CATALOG[k].label}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            </div>
          </CardContent></Card>

          <Card><CardContent className="space-y-4 p-6">
            <h2 className="flex items-center gap-2 font-display text-lg font-semibold"><ImageIcon className="h-4 w-4 text-primary" /> Logo e imágenes</h2>
            <div className="grid gap-6 sm:grid-cols-2">
              <div>
                <Label>Logo para fondos oscuros</Label>
                <p className="mb-2 text-xs text-muted-foreground">La versión clara o blanca.</p>
                <ImageUploadField value={theme.assets.logoOnDark ?? ''} onChange={(url) => setAssets({ logoOnDark: url })} prefix="brand" fit="contain" previewClassName="bg-zinc-900" accept="image/png,image/jpeg" label="logo para fondos oscuros" />
              </div>
              <div>
                <Label>Logo para fondos claros</Label>
                <p className="mb-2 text-xs text-muted-foreground">La versión oscura. También se usa en emails y PDFs.</p>
                <ImageUploadField value={theme.assets.logoOnLight ?? ''} onChange={(url) => setAssets({ logoOnLight: url })} prefix="brand" fit="contain" previewClassName="bg-white" accept="image/png,image/jpeg" label="logo para fondos claros" />
              </div>
              <div>
                <Label>Icono de la pestaña (favicon)</Label>
                <p className="mb-2 text-xs text-muted-foreground">Cuadrado, PNG.</p>
                <ImageUploadField value={theme.assets.favicon ?? ''} onChange={(url) => setAssets({ favicon: url })} prefix="brand" fit="contain" accept="image/png,image/jpeg" label="icono de la pestaña" />
              </div>
              <div>
                <Label>Imagen para redes sociales</Label>
                <p className="mb-2 text-xs text-muted-foreground">Al compartir un enlace. 1200 × 630.</p>
                <ImageUploadField value={theme.assets.ogImage ?? ''} onChange={(url) => setAssets({ ogImage: url })} prefix="brand" accept="image/png,image/jpeg" label="imagen para redes sociales" />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">Sin logo, la web muestra el nombre como marca de texto. Los PDFs y los pases de wallet necesitan un logo en PNG o JPEG.</p>
          </CardContent></Card>

          {theme.template === 'cine' && (
            <Card><CardContent className="space-y-4 p-6">
              <h2 className="flex items-center gap-2 font-display text-lg font-semibold"><Film className="h-4 w-4 text-primary" /> Cabecera con vídeo</h2>
              <div className="grid gap-6 sm:grid-cols-2">
                <div>
                  <Label>Vídeo de la cabecera</Label>
                  <p className="mb-2 text-xs text-muted-foreground">MP4 o WebM, sin sonido, de 10 a 20 segundos y hasta 12 MB. Se reproduce en bucle y mudo, solo en pantallas grandes: en el móvil se ve la imagen de la cabecera.</p>
                  <VideoUploadField value={theme.assets.heroVideo ?? ''} onChange={(url) => setAssets({ heroVideo: url || undefined })} label="vídeo de la cabecera" />
                </div>
                <div>
                  <Label>Imagen de la cabecera (póster)</Label>
                  <p className="mb-2 text-xs text-muted-foreground">Se ve mientras carga el vídeo y a quien pide menos movimiento o tiene el ahorro de datos. Recomendado: un fotograma del vídeo.</p>
                  <ImageUploadField value={theme.assets.heroPoster ?? ''} onChange={(url) => setAssets({ heroPoster: url || undefined })} prefix="brand" accept="image/png,image/jpeg" label="imagen de la cabecera" />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">Sin vídeo ni imagen, la cabecera muestra un resplandor del color principal.</p>
            </CardContent></Card>
          )}
        </div>

        <aside className="space-y-4 xl:sticky xl:top-6 xl:self-start">
          <h2 className="font-display text-lg font-semibold">Vista previa</h2>
          <Preview theme={theme} mode="dark" />
          <Preview theme={theme} mode="light" />
          <p className="text-xs text-muted-foreground">
            El texto, los bordes y las tarjetas se calculan a partir de tus colores para que siempre se lean bien.
            {` Tono principal: ${Math.round(hexToHsl(theme.colors.primary).h)}°.`}
          </p>
        </aside>
      </div>
    </div>
  );
}
