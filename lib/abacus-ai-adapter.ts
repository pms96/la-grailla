/* Adaptador para Abacus.AI — mismo patrón que lib/payment-adapter.ts (interfaz +
 * implementación real + mock, fetch() plano, credenciales vía getConfig()).
 *
 * El contrato exacto (endpoint/payload) de la API de Abacus.AI para "generar un
 * prompt de vídeo a partir de una imagen + texto" no se ha podido verificar
 * contra documentación en vivo — AbacusAIAdapter.generateVideoPrompt() deja el
 * fetch() con la URL/payload más plausibles según las convenciones de su API
 * documentada (ChatLLM, API key en cabecera), pero hay que confirmarlo contra
 * la referencia real de la cuenta antes de dar el flujo por definitivo.
 */
import { getConfig } from '@/lib/config';

export type GenerateVideoPromptInput = {
  logoUrl: string;
  guidedAnswers: Record<string, string>;
  freeText: string;
};

export type GenerateVideoPromptResult = {
  promptEs: string;
  promptEn: string;
  raw: unknown;
};

// Prompt de sistema enviado junto a la imagen del logo y el contexto creativo.
// Se le pide JSON estricto para poder parsear la respuesta sin ambigüedad.
export const ABACUS_META_PROMPT = `Eres un director creativo experto en vídeo publicitario para pantallas LED de eventos. A partir del logotipo adjunto y la descripción creativa proporcionada, genera un prompt profesional para una herramienta de vídeo generativo, en dos idiomas (español e inglés).

Requisitos técnicos obligatorios que el prompt debe incorporar explícitamente:
- Duración del vídeo: entre 12 y 17 segundos.
- Relación de aspecto adaptable a pantalla LED: 16:9 horizontal o 3:4 vertical.
- Sin audio — el vídeo es mudo, todo el impacto debe ser visual (contraste, movimiento, luz).
- Fidelidad de marca máxima: el logotipo debe conservarse exactamente como se ve en la imagen — no alterar su tipografía, no cambiar sus colores de marca, no inventar elementos tipográficos que no existan en el original. Se permiten revelaciones progresivas, transiciones cinemáticas y efectos de iluminación elegantes alrededor del logo, nunca alteraciones del logo en sí.

Devuelve exclusivamente un JSON con esta forma, sin texto adicional antes ni después:
{"prompt_es": "...", "prompt_en": "..."}`;

export interface AbacusAIProvider {
  generateVideoPrompt(input: GenerateVideoPromptInput): Promise<GenerateVideoPromptResult>;
}

function buildUserContext(input: GenerateVideoPromptInput): string {
  const answers = Object.entries(input.guidedAnswers)
    .map(([key, value]) => `- ${key}: ${value}`)
    .join('\n');
  return `Logo: ${input.logoUrl}\n\nRespuestas guiadas:\n${answers}\n\nDescripción libre:\n${input.freeText || '(sin descripción adicional)'}`;
}

function parseAbacusResponse(raw: unknown): { promptEs: string; promptEn: string } {
  const text =
    typeof raw === 'string'
      ? raw
      : (raw as { result?: string; text?: string; content?: string })?.result ??
        (raw as { text?: string })?.text ??
        (raw as { content?: string })?.content ??
        '';
  let parsed: { prompt_es?: string; prompt_en?: string };
  try {
    parsed = JSON.parse(text);
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
    const response = await fetch('https://api.abacus.ai/api/v0/evaluatePrompt', {
      method: 'POST',
      headers: {
        apiKey: this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prompt: buildUserContext(input),
        systemMessage: ABACUS_META_PROMPT,
        imageUrls: [input.logoUrl],
      }),
    });

    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const message = (data as { error?: string; message?: string })?.error ?? (data as { message?: string })?.message ?? `HTTP ${response.status}`;
      throw new Error(`Abacus.AI: ${message}`);
    }

    const { promptEs, promptEn } = parseAbacusResponse(data);
    return { promptEs, promptEn, raw: data };
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
