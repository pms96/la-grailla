// Estado consolidado del sponsor para la pantalla admin unificada — resuelve
// SponsorRequest.status y Sponsor.status (dos máquinas de estado distintas)
// en una sola etiqueta/badge, sin fusionar los modelos. Ver plan de
// integración: "Decisión de arquitectura".
export type ConsolidatedSponsorStatus =
  | 'PENDING'
  | 'CONTACTED'
  | 'REJECTED_LEAD'
  | 'PENDIENTE_MATERIALES'
  | 'EN_REVISION'
  | 'PROMPT_GENERADO'
  | 'APROBADO_PARA_VIDEO'
  | 'RECHAZADO';

export type SponsorConsolidationInput = {
  status: string; // SponsorRequestStatus
  sponsor: { status: string } | null; // SponsorPortalStatus
};

export function consolidatedSponsorStatus({ status, sponsor }: SponsorConsolidationInput): ConsolidatedSponsorStatus {
  if (!sponsor) {
    if (status === 'REJECTED') return 'REJECTED_LEAD';
    if (status === 'CONTACTED') return 'CONTACTED';
    return 'PENDING';
  }
  if (sponsor.status === 'PENDIENTE_REVISION' || sponsor.status === 'LISTO_PARA_GENERAR') return 'EN_REVISION';
  return sponsor.status as ConsolidatedSponsorStatus;
}

export const CONSOLIDATED_STATUS_LABELS: Record<ConsolidatedSponsorStatus, string> = {
  PENDING: 'Nuevo lead',
  CONTACTED: 'En contacto',
  REJECTED_LEAD: 'Rechazado',
  PENDIENTE_MATERIALES: 'Esperando materiales',
  EN_REVISION: 'En revisión',
  PROMPT_GENERADO: 'Prompt preparado',
  APROBADO_PARA_VIDEO: 'Aprobado',
  RECHAZADO: 'Rechazado',
};

export const CONSOLIDATED_STATUS_VARIANT: Record<ConsolidatedSponsorStatus, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  PENDING: 'outline',
  CONTACTED: 'outline',
  REJECTED_LEAD: 'destructive',
  PENDIENTE_MATERIALES: 'secondary',
  EN_REVISION: 'secondary',
  PROMPT_GENERADO: 'default',
  APROBADO_PARA_VIDEO: 'default',
  RECHAZADO: 'destructive',
};
