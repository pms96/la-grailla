import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"
 
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// El servidor no siempre responde JSON (un 413 "Request Entity Too Large" de
// la propia plataforma llega como texto plano) — sin esto, `res.json()`
// lanzaba un "Unexpected token" críptico en vez del error real.
export async function parseJsonSafe<T = Record<string, unknown>>(res: Response): Promise<T & { error?: string }> {
  try {
    return await res.json();
  } catch {
    return { error: `Error inesperado del servidor (${res.status})` } as T & { error?: string };
  }
}

export function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remainingSeconds = seconds % 60

  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`
}