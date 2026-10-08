const fmt = new Intl.DateTimeFormat('es-ES', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Madrid' });

export const formatDate = (d: Date | null | undefined) => (d ? fmt.format(d) : '—');

export function Pill({ tone, children }: { tone?: 'ok' | 'warn' | 'bad' | 'accent'; children: React.ReactNode }) {
  return <span className={`pill ${tone ?? ''}`}>{children}</span>;
}

const TENANT_TONE = { ACTIVE: 'ok', SUSPENDED: 'warn', PENDING_DELETION: 'bad', DELETED: 'bad' } as const;
const TENANT_LABEL = { ACTIVE: 'Activo', SUSPENDED: 'Suspendido', PENDING_DELETION: 'Pendiente de borrado', DELETED: 'Borrado' } as const;
export function TenantStatusPill({ status }: { status: keyof typeof TENANT_TONE }) {
  return <Pill tone={TENANT_TONE[status]}>{TENANT_LABEL[status]}</Pill>;
}

const DOMAIN_TONE = { VERIFIED: 'ok', PENDING: 'warn', RELEASED: undefined } as const;
const DOMAIN_LABEL = { VERIFIED: 'Verificado', PENDING: 'Pendiente', RELEASED: 'Liberado' } as const;
export function DomainStatusPill({ status }: { status: keyof typeof DOMAIN_TONE }) {
  return <Pill tone={DOMAIN_TONE[status]}>{DOMAIN_LABEL[status]}</Pill>;
}

export function PublishPill({ pending, seq, error, hasPublished }: { pending: boolean; seq: number; error: string | null; hasPublished: boolean }) {
  if (error) return <Pill tone="bad">Error al publicar</Pill>;
  if (!hasPublished) return <Pill tone="warn">Sin publicar</Pill>;
  if (pending) return <Pill tone="warn">Cambios sin publicar</Pill>;
  return <Pill tone="ok">Al día · v{seq}</Pill>;
}

const PHASE_TONE = { ACTIVE: 'ok', GRACE: 'warn', PANEL_BLOCKED: 'bad', BLOCKED: 'bad' } as const;
const PHASE_LABEL = { ACTIVE: 'Al día', GRACE: 'En gracia (aviso)', PANEL_BLOCKED: 'Panel bloqueado', BLOCKED: 'Bloqueado' } as const;
export function LicensePhasePill({ phase }: { phase: keyof typeof PHASE_TONE }) {
  return <Pill tone={PHASE_TONE[phase]}>{PHASE_LABEL[phase]}</Pill>;
}

const dayFmt = new Intl.DateTimeFormat('es-ES', { dateStyle: 'long', timeZone: 'Europe/Madrid' });
export const formatDay = (d: Date | number | null | undefined) => (d === null || d === undefined ? '—' : dayFmt.format(d));
