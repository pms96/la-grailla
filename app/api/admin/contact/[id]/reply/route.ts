export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { sendMail } from '@/lib/mailer';
import { getOperatorEmail } from '@/lib/config';
import { handleApiError } from '@/lib/api-error';
import { contactReplyEmail, replySchema } from '@/lib/contact';

/* Responder a un mensaje desde el panel. El email sale por el SMTP del cliente; si no se puede enviar, la respuesta se guarda como
 * «no enviada» (queda constancia del intento) y el mensaje NO pasa a respondido. */

export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  try {
    const { body } = replySchema.parse(await request.json());
    const original = await prisma.contactMessage.findUnique({ where: { id: params.id } });
    if (!original) return NextResponse.json({ error: 'Mensaje no encontrado' }, { status: 404 });

    const mail = await contactReplyEmail(original, body);
    // Las respuestas del visitante llegan al correo del cliente (si lo tiene configurado).
    const replyTo = (await getOperatorEmail()) || undefined;
    const result = await sendMail({ to: original.email, subject: mail.subject, html: mail.html, replyTo });

    const reply = await prisma.contactReply.create({
      data: {
        messageId: original.id,
        body,
        sentBy: session?.user?.email ?? null,
        emailSent: result.success,
        emailError: result.success ? null : (result.error ?? 'Error desconocido').slice(0, 500),
      },
    });
    if (!result.success) {
      return NextResponse.json({ error: `No se ha podido enviar el email: ${result.error ?? 'error desconocido'}`, reply }, { status: 502 });
    }
    await prisma.contactMessage.update({ where: { id: original.id }, data: { status: 'ANSWERED' } });
    return NextResponse.json({ success: true, reply });
  } catch (error) {
    return handleApiError(error, 'POST /api/admin/contact/[id]/reply');
  }
}
