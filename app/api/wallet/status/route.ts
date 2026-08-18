export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getWalletAvailability } from '@/lib/wallet';

export async function GET() {
  const availability = await getWalletAvailability();
  return NextResponse.json(availability);
}
