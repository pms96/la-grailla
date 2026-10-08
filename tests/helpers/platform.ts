import { vi } from 'vitest';
import { generateMasterKey } from '@grailla/contracts';

/** Entorno del modo plataforma para tests. Devuelve las claves generadas y una función para restaurarlo todo. */
export function enablePlatformEnv(extra: Record<string, string> = {}) {
  const master = generateMasterKey();
  const values: Record<string, string> = {
    PLATFORM_MODE: 'on',
    PLATFORM_CONTEXT_KEY: generateMasterKey(),
    PLATFORM_SESSION_MASTER: generateMasterKey(),
    SECRETS_KEYS: JSON.stringify({ tk: master }),
    SECRETS_ACTIVE_KID: 'tk',
    LEGACY_TENANT_ID: '01HF7YAT00KKKKKKKKKKKKKKKK',
    LEGACY_NEXTAUTH_SECRET: 'secreto-legacy-de-la-grailla-para-tests',
    ...extra,
  };
  const saved: Record<string, string | undefined> = { NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET, NEXTAUTH_URL: process.env.NEXTAUTH_URL };
  for (const [k, v] of Object.entries(values)) vi.stubEnv(k, v);
  // En modo plataforma NEXTAUTH_SECRET y NEXTAUTH_URL ni siquiera existen: así se demuestra que nada depende de ellos.
  delete process.env.NEXTAUTH_SECRET;
  delete process.env.NEXTAUTH_URL;
  const result = {
    ...values,
    master,
    restore() {
      vi.unstubAllEnvs();
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
  return result as typeof result & Record<keyof typeof values, string>;
}
