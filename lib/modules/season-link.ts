import { isModuleEnabled } from '@/lib/modules/runtime';

/* El vínculo de eventos, productos, pedidos de tienda y patrocinios con una Temporada es de CONTABILIDAD (la temporada es suya).
 * Sin ese módulo no se ofrece, no se acepta al guardar y no se devuelve el nombre de la temporada: antes Entradas, Tienda y Sponsors
 * leían y escribían ese vínculo igual, y un cliente sin Contabilidad veía y enlazaba temporadas de un módulo que no tiene. */
export function seasonLinkEnabled(): boolean {
  return isModuleEnabled('contabilidad');
}
