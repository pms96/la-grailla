export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getConfigs } from '@/lib/config';
import { handleApiError } from '@/lib/api-error';

const KEYS = [
  'phomemo_printer_enabled',
  'phomemo_write_mode',
  'phomemo_raster_chunk_size',
  'phomemo_chunk_delay_ms',
  'phomemo_command_delay_ms',
  'phomemo_after_raster_delay_ms',
  'phomemo_after_feed_delay_ms',
  'phomemo_density',
  'phomemo_feed',
  'phomemo_confirm_every_chunks',
] as const;

/** Solo los ajustes de impresión BLE (nada sensible) — taquilla los necesita para imprimir. */
export async function GET() {
  const session = await getServerSession(authOptions);
  const role = session?.user?.role ?? '';
  if (!session?.user || !['ADMIN', 'TAQUILLA'].includes(role)) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const configs = await getConfigs([...KEYS]);
    return NextResponse.json({
      printerEnabled: configs.phomemo_printer_enabled !== 'false',
      writeMode: configs.phomemo_write_mode,
      rasterChunkSize: Number(configs.phomemo_raster_chunk_size),
      chunkDelayMs: Number(configs.phomemo_chunk_delay_ms),
      commandDelayMs: Number(configs.phomemo_command_delay_ms),
      afterRasterDelayMs: Number(configs.phomemo_after_raster_delay_ms),
      afterFeedDelayMs: Number(configs.phomemo_after_feed_delay_ms),
      density: Number(configs.phomemo_density),
      feed: Number(configs.phomemo_feed),
      confirmEveryChunks: Number(configs.phomemo_confirm_every_chunks),
    });
  } catch (error) {
    return handleApiError(error, 'GET /api/taquilla/print-settings');
  }
}
