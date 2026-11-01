import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { createTestEvent, cleanupTestEvent } from '../helpers/fixtures';
import { isEventPageVisible } from '@/lib/public-event';

type TestSession = { user: { id: string; role: string; modules: string[] | null } } | null;
let session: TestSession = null;
vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => session) }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

const { GET: minorPdf } = await import('@/app/api/events/[slug]/minor-authorization/route');
const as = (role: 'ADMIN' | 'TAQUILLA', modules: string[] | null): TestSession => ({ user: { id: 'u', role, modules } });
const call = (slug: string) => minorPdf(new Request(`http://localhost/api/events/${slug}/minor-authorization`), { params: Promise.resolve({ slug }) });

/* H-059: la ficha pública y el PDF de autorización de menores servían un evento en BORRADOR por su slug (cartel, fecha, lugar y precios antes del
 * anuncio), mientras `/api/events*` y `/comprar` sí lo escondían. Mismo criterio: un borrador solo lo ve un ADMIN con Entradas. */
describe('borradores fuera de la web pública (H-059)', () => {
  it('isEventPageVisible: un borrador solo se ve con permiso de borradores', () => {
    expect(isEventPageVisible('DRAFT', false)).toBe(false);
    expect(isEventPageVisible('DRAFT', true)).toBe(true);
    for (const status of ['PUBLISHED', 'FINISHED', 'CANCELLED']) expect(isEventPageVisible(status, false), status).toBe(true);
  });

  describe('PDF de autorización de menores', () => {
    let draft: Awaited<ReturnType<typeof createTestEvent>>;
    let published: Awaited<ReturnType<typeof createTestEvent>>;
    beforeAll(async () => {
      draft = await createTestEvent({ status: 'DRAFT' });
      published = await createTestEvent({ status: 'PUBLISHED' });
      await prisma.event.updateMany({ where: { id: { in: [draft.id, published.id] } }, data: { minorAuthorizationEnabled: true } });
    });
    afterAll(async () => {
      await cleanupTestEvent(draft.id);
      await cleanupTestEvent(published.id);
    });

    it('de un borrador: 404 para un anónimo, para la taquilla y para un rol restringido sin Entradas', async () => {
      for (const s of [null, as('TAQUILLA', null), as('ADMIN', ['tienda'])]) {
        session = s;
        expect((await call(draft.slug)).status, JSON.stringify(s)).toBe(404);
      }
    });

    it('de un borrador: 200 para el propietario y para un ADMIN con Entradas', async () => {
      for (const s of [as('ADMIN', null), as('ADMIN', ['entradas'])]) {
        session = s;
        const res = await call(draft.slug);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('application/pdf');
      }
    });

    it('de un evento publicado sigue siendo público', async () => {
      session = null;
      expect((await call(published.slug)).status).toBe(200);
    });
  });
});
