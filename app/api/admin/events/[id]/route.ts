export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';

const updateEventSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional().nullable(),
  venue: z.string().optional(),
  city: z.string().optional(),
  address: z.string().optional().nullable(),
  imageUrl: z.string().optional().nullable(),
  artists: z.string().optional().nullable(),
  date: z.string().optional(),
  doorsOpen: z.string().optional().nullable(),
  endTime: z.string().optional().nullable(),
  minAge: z.number().optional(),
  conditions: z.string().optional().nullable(),
  maxCapacity: z.number().optional(),
  maxTicketsPerEmail: z.union([z.number(), z.string(), z.null()]).optional(),
  waitingRoomEnabled: z.boolean().optional(),
  waitingRoomConcurrentSlots: z.union([z.number(), z.string(), z.null()]).optional(),
  waitingRoomPurchaseWindowSeconds: z.union([z.number(), z.string(), z.null()]).optional(),
  waitingRoomMessage: z.string().optional().nullable(),
  status: z.enum(['DRAFT', 'PUBLISHED', 'FINISHED', 'CANCELLED']).optional(),
  latitude: z.union([z.number(), z.string(), z.null()]).optional(),
  longitude: z.union([z.number(), z.string(), z.null()]).optional(),
  temporadaId: z.string().optional().nullable(),
});

const patchEventSchema = z.object({
  alertThresholds: z.string().optional(),
  resetAlerts: z.boolean().optional(),
  latitude: z.union([z.number(), z.string(), z.null()]).optional(),
  longitude: z.union([z.number(), z.string(), z.null()]).optional(),
  temporadaId: z.string().optional().nullable(),
  archivado: z.boolean().optional(),
});

export async function PUT(
  request: Request,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const body = updateEventSchema.parse(await request.json());
    const event = await prisma.event.update({
      where: { id: params?.id },
      data: {
        name: body?.name,
        description: body?.description,
        venue: body?.venue,
        city: body?.city,
        address: body?.address,
        imageUrl: body?.imageUrl,
        artists: body?.artists,
        date: body?.date ? new Date(body.date) : undefined,
        doorsOpen: body?.doorsOpen,
        endTime: body?.endTime,
        minAge: body?.minAge,
        conditions: body?.conditions,
        maxCapacity: body?.maxCapacity,
        maxTicketsPerEmail: body?.maxTicketsPerEmail === undefined
          ? undefined
          : body?.maxTicketsPerEmail === '' || body?.maxTicketsPerEmail == null
            ? null
            : Number(body.maxTicketsPerEmail),
        waitingRoomEnabled: body?.waitingRoomEnabled,
        waitingRoomConcurrentSlots: body?.waitingRoomConcurrentSlots === undefined
          ? undefined
          : body?.waitingRoomConcurrentSlots === '' || body?.waitingRoomConcurrentSlots == null
            ? null
            : Number(body.waitingRoomConcurrentSlots),
        waitingRoomPurchaseWindowSeconds: body?.waitingRoomPurchaseWindowSeconds === undefined
          ? undefined
          : body?.waitingRoomPurchaseWindowSeconds === '' || body?.waitingRoomPurchaseWindowSeconds == null
            ? null
            : Number(body.waitingRoomPurchaseWindowSeconds),
        waitingRoomMessage: body?.waitingRoomMessage,
        status: body?.status,
        latitude: body?.latitude === '' || body?.latitude == null ? null : Number(body.latitude),
        longitude: body?.longitude === '' || body?.longitude == null ? null : Number(body.longitude),
        temporadaId: body?.temporadaId === undefined ? undefined : body.temporadaId || null,
      },
    });
    return NextResponse.json(event);
  } catch (error) {
    return handleApiError(error, 'PUT /api/admin/events/[id]');
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const body = patchEventSchema.parse(await request.json());
    const data: Prisma.EventUpdateInput = {};

    if (typeof body?.alertThresholds === 'string') {
      const cleaned = body.alertThresholds
        .split(',')
        .map((v: string) => parseInt(v.trim(), 10))
        .filter((v: number) => Number.isFinite(v) && v > 0 && v <= 200)
        .sort((a: number, b: number) => a - b);
      data.alertThresholds = cleaned.join(',');
      data.alertsSent = '';
    }
    if (body?.resetAlerts === true) data.alertsSent = '';
    if (body?.latitude !== undefined) data.latitude = body.latitude === '' || body.latitude === null ? null : Number(body.latitude);
    if (body?.longitude !== undefined) data.longitude = body.longitude === '' || body.longitude === null ? null : Number(body.longitude);
    if (body?.temporadaId !== undefined) {
      data.temporada = body.temporadaId === null ? { disconnect: true } : { connect: { id: body.temporadaId } };
    }
    if (body?.archivado !== undefined) data.archivado = body.archivado;

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: 'Nada que actualizar' }, { status: 400 });
    }

    const event = await prisma.event.update({ where: { id: params?.id }, data });
    return NextResponse.json(event);
  } catch (error) {
    return handleApiError(error, 'PATCH /api/admin/events/[id]');
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    await prisma.event.delete({ where: { id: params?.id } });
    return NextResponse.json({ success: true });
  } catch (error) {
    return handleApiError(error, 'DELETE /api/admin/events/[id]');
  }
}
