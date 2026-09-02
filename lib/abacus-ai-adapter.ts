/* Adaptador para Abacus.AI — mismo patrón que lib/payment-adapter.ts (interfaz +
 * implementación real + mock, credenciales vía getConfig()).
 *
 * Contrato confirmado: RouteLLM de Abacus.AI expone una API compatible con
 * OpenAI Chat Completions en https://routellm.abacus.ai/v1, modelo fijo
 * "route-llm" (el propio RouteLLM decide el modelo real por debajo). Se usa
 * el SDK oficial `openai` apuntando a esa base URL, igual que StripeAdapter
 * importa el SDK de Stripe de forma diferida (solo se carga si de verdad se usa).
 */
import { getConfig } from '@/lib/config';
import { SPONSOR_GUIDED_QUESTIONS } from '@/lib/sponsor-guided-questions';

export type GenerateVideoPromptInput = {
  logoUrl: string;
  guidedAnswers: Record<string, string>;
  freeText: string;
  // Investigación de marca que añade el admin (a qué se dedica, su web,
  // estilo real) — sin esto todos los prompts salían con la misma estructura
  // genérica de "partículas convirtiéndose en el logo", diera igual la marca.
  brandContext?: string;
  companyName?: string;
};

export type GenerateVideoPromptResult = {
  promptEs: string;
  promptEn: string;
  raw: unknown;
};

// Prompt de sistema enviado junto a la imagen del logo y el contexto creativo.
// Versión exhaustiva: pide un guion por tramos de tiempo (no una descripción
// vaga en un párrafo) y obliga a describir la transición del logo con
// vocabulario de cámara/luz concreto — los prompts anteriores, más cortos y
// genéricos, devolvían vídeos que no se parecían a lo que el texto sugería.
// Se le pide JSON estricto para poder parsear la respuesta sin ambigüedad.
export const ABACUS_META_PROMPT = `Eres un director creativo experto en vídeo publicitario cinematográfico para pantallas LED de eventos (festivales, ferias, discotecas). A partir del logotipo adjunto y las respuestas del sponsor, escribes un prompt de vídeo generativo tan detallado y visual que dos personas distintas, leyéndolo, imaginarían prácticamente el mismo vídeo.

## Por qué esto importa
Prompts vagos ("logo apareciendo con luces, elegante") producen vídeos genéricos que no se parecen a lo que el texto sugiere. Un buen prompt describe una SECUENCIA concreta de planos con tiempos, no un mood board en una frase.

## Estructura obligatoria del prompt (los dos idiomas siguen la misma estructura)
Divide el vídeo en 3 tramos con marcas de tiempo que sumen la duración total elegida (entre 12 y 17s), y describe cada uno con detalle visual concreto — no adjetivos sueltos, sino qué se ve, cómo se mueve la cámara, cómo se comporta la luz:

1. **Apertura (0s–~30% de la duración):** el estado inicial antes de que el logo sea reconocible — de qué material/energía/entorno parte la escena (partículas, humo, líquido, luz, fragmentos, geometría abstracta...), coherente con el tipo de transición elegido por el sponsor.
2. **Revelación del logo (~30%–~75% de la duración):** el momento central — cómo exactamente el logo se forma/aparece/se ensambla a partir de ese estado inicial. Esta es la parte más importante: usa vocabulario de cámara (dolly in, push-in lento, barrido lateral, órbita suave) y de luz (rim light, destello volumétrico, rayo que barre de izquierda a derecha) concretos, no "aparece de forma elegante".
3. **Cierre (~75%–100%):** el logo ya formado, ESTÁTICO Y PERFECTAMENTE LEGIBLE, sostenido en pantalla el tiempo suficiente para leerse en una pantalla LED desde lejos — con como mucho un movimiento residual sutil (partículas de ambiente, leve respiración de luz) que nunca comprometa la legibilidad ni mueva el propio logo.

## Paso 0, obligatorio antes de escribir nada: identifica el sector real de la marca
Usa el "Contexto de marca" y el nombre de la empresa (si se proporcionan) para identificar a qué se dedica de verdad esta marca — no lo asumas por el nombre ni por la lista de respuestas guiadas. Ese sector es lo que determina de qué está hecho el mundo visual del vídeo (materiales, entorno, física del movimiento), no una plantilla fija.

**Nunca uses "partículas de luz abstractas convergiendo en el centro" como recurso por defecto.** Es el cliché más repetido en vídeos de logo genéricos — solo úsalo si el sponsor ha elegido explícitamente esa transición Y encaja con su sector real. Dos marcas que elijan la MISMA opción de transición deben producir vídeos que se vean radicalmente distintos si sus sectores son distintos. Ejemplos de cómo el sector cambia el material, no solo el color:
- Marca de agua/pesca/naturaleza → agua real en movimiento, reflejos, luz natural o de luna, texturas orgánicas. Nunca neón digital abstracto.
- Marca de gastronomía/artesanía → vapor, líquidos, texturas cálidas de materiales reales del producto (madera, cerámica, humo de cocina), luz cálida práctica.
- Marca tecnológica/software → líneas de datos, geometría de circuito, HUD, luz fría azul/cian, superficies de cristal.
- Marca de moda/lujo → telas en movimiento, luz de estudio fotográfico, superficies pulidas (mármol, metal cepillado).
- Marca de música/eventos/discoteca → haces de foco, humo escénico, destellos estroboscópicos sincronizados a un ritmo.
- Si el sector no encaja en ninguno de estos, invéntate un mundo visual coherente con lo que la marca vende de verdad — nunca caigas en el default genérico.

## Estructura obligatoria del prompt (los dos idiomas siguen la misma estructura)
Divide el vídeo en 3 tramos con marcas de tiempo que sumen la duración total elegida (entre 12 y 17s), y describe cada uno con detalle visual concreto — no adjetivos sueltos, sino qué se ve, cómo se mueve la cámara, cómo se comporta la luz:

1. **Apertura (0s–~30% de la duración):** el estado inicial antes de que el logo sea reconocible — de qué material/energía/entorno parte la escena, coherente con el sector identificado en el Paso 0 y con el tipo de transición elegido por el sponsor.
2. **Revelación del logo (~30%–~75% de la duración):** el momento central — cómo exactamente el logo se forma/aparece/se ensambla a partir de ese estado inicial. Esta es la parte más importante: usa vocabulario de cámara (dolly in, push-in lento, barrido lateral, órbita suave) y de luz (rim light, destello volumétrico, rayo que barre de izquierda a derecha) concretos, no "aparece de forma elegante".
3. **Cierre (~75%–100%):** el logo ya formado, ESTÁTICO Y PERFECTAMENTE LEGIBLE, sostenido en pantalla el tiempo suficiente para leerse en una pantalla LED desde lejos — con como mucho un movimiento residual sutil coherente con el mundo visual del Paso 0, que nunca comprometa la legibilidad ni mueva el propio logo.

## Usa las respuestas del sponsor como decisiones de dirección, no como texto a repetir
- El **tipo de transición/animación** elegido determina el mecanismo del tramo 1 y 2, pero su material concreto lo determina el sector (Paso 0) — la misma transición "ondas de energía" son ondas de agua real en una marca de pesca y ondas de sonido de club en una discoteca.
- El **estilo visual** y el **enfoque de marca** determinan el entorno/fondo y la sensación general, siempre coherentes con el sector real.
- El **ambiente/vibra** determina el ritmo de corte y la intensidad de la luz.
- Los **colores clave** de marca deben aparecer explícitamente como color de la iluminación/partículas/gradiente de fondo — nunca sustituir al color real del logo, solo acompañarlo.
- El **ritmo** determina si los 3 tramos son de duración pareja o si el cierre se alarga a costa de la apertura.

## Requisitos técnicos obligatorios (inclúyelos explícitamente en el prompt)
- Duración total: entre 12 y 17 segundos — indica la cifra exacta elegida.
- Relación de aspecto adaptable a pantalla LED: 16:9 horizontal o 3:4 vertical.
- Sin audio — vídeo mudo, todo el impacto es visual (contraste, movimiento, luz).
- Fidelidad de marca máxima: el logotipo debe conservarse EXACTAMENTE como en la imagen adjunta — misma tipografía, mismos colores de marca, ninguna letra o forma inventada. Las transiciones ocurren ALREDEDOR y HACIA el logo, nunca deformándolo ni redibujándolo.
- Cada campo (prompt_es y prompt_en) debe estar íntegramente en su propio idioma — no mezcles palabras del otro idioma dentro de cada campo.

## Formato de salida
Devuelve EXCLUSIVAMENTE un JSON con esta forma, sin texto adicional antes ni después, sin bloque de código:
{"prompt_es": "...", "prompt_en": "..."}
Cada campo debe ser un único prompt con la estructura de 3 tramos descrita arriba, en prosa continua (no listas ni saltos de línea), con la duración exacta y los requisitos técnicos incluidos al final.`;

export interface AbacusAIProvider {
  generateVideoPrompt(input: GenerateVideoPromptInput): Promise<GenerateVideoPromptResult>;
}

function buildUserContext(input: GenerateVideoPromptInput): string {
  const labelFor = (key: string) => SPONSOR_GUIDED_QUESTIONS.find((q) => q.key === key)?.label ?? key;
  const answers = Object.entries(input.guidedAnswers)
    .filter(([, value]) => Boolean(value))
    .map(([key, value]) => `- ${labelFor(key)}: ${value}`)
    .join('\n');
  return [
    input.companyName ? `Marca: ${input.companyName}` : '',
    `Logo: ${input.logoUrl}`,
    `\nContexto de marca investigado por el equipo (usa esto para el Paso 0 — identificar el sector real):\n${input.brandContext || '(sin investigar todavía — infiere el sector lo mejor posible a partir del nombre, el logo y la descripción del sponsor)'}`,
    `\nRespuestas guiadas del sponsor (son decisiones de dirección, no texto a repetir literalmente):\n${answers || '(sin respuestas)'}`,
    `\nDescripción libre adicional del sponsor:\n${input.freeText || '(sin descripción adicional)'}`,
  ]
    .filter(Boolean)
    .join('\n');
}

// Los modelos de chat casi nunca respetan al 100% "sin texto adicional" — a
// veces envuelven el JSON en ```json ... ```. Se extrae el primer bloque
// {...} de la respuesta antes de parsear, en vez de asumir que el string
// completo ya es JSON puro.
function parseAbacusResponse(content: string | null | undefined): { promptEs: string; promptEn: string } {
  const text = content ?? '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Abacus.AI no devolvió un JSON con prompt_es/prompt_en');
  }
  let parsed: { prompt_es?: string; prompt_en?: string };
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    throw new Error('Abacus.AI no devolvió un JSON válido con prompt_es/prompt_en');
  }
  if (!parsed.prompt_es || !parsed.prompt_en) {
    throw new Error('La respuesta de Abacus.AI no incluye prompt_es y prompt_en');
  }
  return { promptEs: parsed.prompt_es, promptEn: parsed.prompt_en };
}

export class AbacusAIAdapter implements AbacusAIProvider {
  constructor(private apiKey: string) {}

  async generateVideoPrompt(input: GenerateVideoPromptInput): Promise<GenerateVideoPromptResult> {
    const OpenAI = (await import('openai')).default;
    const client = new OpenAI({ baseURL: 'https://routellm.abacus.ai/v1', apiKey: this.apiKey });

    const completion = await client.chat.completions.create({
      model: 'route-llm',
      stream: false,
      messages: [
        { role: 'system', content: ABACUS_META_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: buildUserContext(input) },
            { type: 'image_url', image_url: { url: input.logoUrl } },
          ],
        },
      ],
    });

    const { promptEs, promptEn } = parseAbacusResponse(completion.choices[0]?.message?.content);
    return { promptEs, promptEn, raw: completion };
  }
}

export class MockAbacusAIAdapter implements AbacusAIProvider {
  async generateVideoPrompt(input: GenerateVideoPromptInput): Promise<GenerateVideoPromptResult> {
    const promptEs = `[MOCK] Vídeo cinemático de 15 segundos, mudo, revelando el logo de la marca con transiciones elegantes de luz, sin alterar tipografía ni colores. Contexto: ${input.freeText || 'sin descripción'}.`;
    const promptEn = `[MOCK] 15-second silent cinematic video revealing the brand logo with elegant light transitions, no typography or color changes. Context: ${input.freeText || 'no description'}.`;
    return { promptEs, promptEn, raw: { mock: true } };
  }
}

// A diferencia de los pagos (donde una pasarela mal configurada nunca debe
// simular un cobro aceptado), aquí el admin siempre revisa y edita el prompt
// a mano antes de aprobarlo — así que sin API key configurada se cae a un
// mock reconocible en vez de bloquear, útil para desarrollo/tests sin coste.
export async function getAbacusAIProvider(): Promise<AbacusAIProvider> {
  const apiKey = (await getConfig('abacus_ai_api_key')).trim();
  if (!apiKey) return new MockAbacusAIAdapter();
  return new AbacusAIAdapter(apiKey);
}
