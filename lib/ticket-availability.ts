export type EventDemandLevel = 'sold_out' | 'high' | 'normal';

// No exponemos plazas restantes ni el aforo total al público — solo un nivel
// cualitativo de demanda, para no dar pistas de cuánto queda por vender.
export function getEventDemandLevel(maxCapacity: number, currentCount: number): EventDemandLevel {
  const spotsLeft = (maxCapacity ?? 0) - (currentCount ?? 0);
  if (spotsLeft <= 0) return 'sold_out';
  if ((maxCapacity ?? 0) > 0 && spotsLeft <= 50 && spotsLeft / maxCapacity <= 0.2) return 'high';
  return 'normal';
}
