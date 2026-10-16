import { cache } from 'react';
import { getConfigs } from '@/lib/config';
import { SECTION_CONFIG_KEYS, SECTION_KINDS, parseSection, type ContentSection, type SectionKind } from '@/lib/content/sections';

/** Las cuatro secciones de contenido del cliente, ya leídas y normalizadas. Una sola consulta por petición aunque la pidan el layout (para los
 *  enlaces del menú) y la portada: `cache` de React recuerda el resultado solo durante esa petición, nunca entre clientes. */
export const getContentSections = cache(async (): Promise<Record<SectionKind, ContentSection>> => {
  const values = await getConfigs(SECTION_KINDS.map((k) => SECTION_CONFIG_KEYS[k]));
  const out = {} as Record<SectionKind, ContentSection>;
  for (const kind of SECTION_KINDS) out[kind] = parseSection(values[SECTION_CONFIG_KEYS[kind]], kind);
  return out;
});
