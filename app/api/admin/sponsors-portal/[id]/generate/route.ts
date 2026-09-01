export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';
import { getAbacusAIProvider } from '@/lib/abacus-ai-adapter';
import type { Prisma } from '@prisma/client';

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const sponsorId = params?.id;
    const sponsor = await prisma.sponsor.findUnique({ where: { id: sponsorId }, include: { currentAsset: true } });
    if (!sponsor) {
      return NextResponse.json({ error: 'Sponsor no encontrado' }, { status: 404 });
    }
    if (!sponsor.currentAsset) {
      return NextResponse.json({ error: 'El sponsor todavía no ha subido ningún logo' }, { status: 400 });
    }

    // Reclamo atómico del slot: si dos admins pulsan "Generar" a la vez, o ya
    // se alcanzó el límite, este update afecta 0 filas para el segundo — sin
    // necesidad de un lock aparte. El contador sube ANTES de llamar a la IA,
    // porque el coste ya se genera aunque la llamada falle después.
    const claim = await prisma.sponsor.updateMany({
      where: {
        id: sponsorId,
        isGenerating: false,
        generationCount: { lt: sponsor.maxGenerations },
        status: { in: ['LISTO_PARA_GENERAR', 'PROMPT_GENERADO'] },
      },
      data: { isGenerating: true, generationCount: { increment: 1 } },
    });
    if (claim.count === 0) {
      return NextResponse.json(
        { error: 'No se puede generar ahora mismo: ya hay una generación en curso, se alcanzó el límite de 3 intentos, o el sponsor no está listo para generar.' },
        { status: 409 }
      );
    }

    const attemptNumber = sponsor.generationCount + 1;
    let promptEs: string | undefined;
    let promptEn: string | undefined;
    let raw: unknown;
    let errorMessage: string | undefined;

    try {
      const provider = await getAbacusAIProvider();
      const result = await provider.generateVideoPrompt({
        logoUrl: sponsor.currentAsset.url,
        guidedAnswers: (sponsor.guidedAnswers as Record<string, string>) ?? {},
        freeText: sponsor.freeText ?? '',
      });
      promptEs = result.promptEs;
      promptEn = result.promptEn;
      raw = result.raw;
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    await prisma.promptGenerationLog.create({
      data: {
        sponsorId,
        attemptNumber,
        adminId: session.user?.id,
        assetIdUsed: sponsor.currentAssetId,
        descriptionSnapshot: sponsor.freeText,
        guidedAnswersSnapshot: (sponsor.guidedAnswers ?? undefined) as Prisma.InputJsonValue,
        rawResponse: (raw ?? undefined) as Prisma.InputJsonValue,
        promptEs,
        promptEn,
        success: Boolean(promptEs && promptEn),
        errorMessage,
      },
    });

    if (promptEs && promptEn) {
      await prisma.sponsorVideoPrompt.upsert({
        where: { sponsorId },
        create: { sponsorId, promptEs, promptEn },
        update: { promptEs, promptEn, approvedAt: null, approvedById: null },
      });
      await prisma.sponsor.update({
        where: { id: sponsorId },
        data: { isGenerating: false, status: 'PROMPT_GENERADO' },
      });
      return NextResponse.json({ success: true, promptEs, promptEn, attemptNumber });
    }

    await prisma.sponsor.update({ where: { id: sponsorId }, data: { isGenerating: false } });
    return NextResponse.json({ success: false, error: errorMessage, attemptNumber }, { status: 502 });
  } catch (error) {
    // Si algo revienta antes de liberar isGenerating, lo liberamos igualmente
    // para no dejar al sponsor bloqueado en "generando" para siempre.
    await prisma.sponsor.updateMany({ where: { id: params?.id, isGenerating: true }, data: { isGenerating: false } }).catch(() => {});
    return handleApiError(error, 'POST /api/admin/sponsors-portal/[id]/generate');
  }
}
