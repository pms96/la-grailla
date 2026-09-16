export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getConfig } from '@/lib/config';
import { parseSponsorTiers } from '@/lib/sponsor-tiers';
import { handleApiError } from '@/lib/api-error';

// Público a propósito — lo consumen tanto el formulario público de sponsors
// como el alta manual desde admin, y no hay nada sensible en la lista de
// tipos/precios de patrocinio.
export async function GET() {
  try {
    const tiers = parseSponsorTiers(await getConfig('sponsor_tiers'));
    return NextResponse.json({ tiers });
  } catch (error) {
    return handleApiError(error, 'GET /api/sponsors/tiers');
  }
}
