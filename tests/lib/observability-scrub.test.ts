import { describe, expect, it } from 'vitest';
import { scrubBreadcrumb, scrubEvent, scrubString, truncateId } from '@/lib/observability/scrub';

/* P0-07: lo que sale hacia Sentry no puede llevar datos personales. Los «secretos» de estos tests son inventados y se arman por partes. */

const SK = ['sk', 'live', 'FAKEFAKEFAKEFAKE1234'].join('_');
const RK = ['rk', 'test', 'FAKEFAKEFAKE9876'].join('_');
const WHSEC = ['whsec', 'FAKEFAKEFAKEFAKEFAKE1234'].join('_');
const SESSION = ['cs', 'test', 'a1B2c3D4e5F6g7H8i9J0kLmN'].join('_');
const PI = ['pi', '3QabcDEFghiJKLmnoPQRstu'].join('_');
const JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'abcDEFghi123_-xyz'].join('.');
const DB = ['postgresql', '://usuario:contrasena@ep-demo-123.eu-central-1.aws.neon.tech/neondb?sslmode=require'].join('');

describe('scrubString: redacción de texto libre', () => {
  it.each([
    ['email', 'Fallo al enviar a ana.garcia+pedidos@correo-ejemplo.es por SMTP', 'ana.garcia+pedidos@correo-ejemplo.es', '[email]'],
    ['email con guion y subdominio', 'buyer: juan_perez-9@mail.sub.dominio.com.', 'juan_perez-9@mail.sub.dominio.com', '[email]'],
    ['teléfono móvil español sin prefijo', 'contacto 612345678 no válido', '612345678', '[telefono]'],
    ['teléfono con espacios', 'tel 612 34 56 78 y 91 234 56 78', '612 34 56 78', '[telefono]'],
    ['teléfono fijo', 'llamar al 912 345 678', '912 345 678', '[telefono]'],
    ['teléfono internacional', 'WhatsApp +34 612 345 678 ok', '+34 612 345 678', '[telefono]'],
    ['teléfono con 0034', 'tel 0034612345678', '0034612345678', '[telefono]'],
    ['Bearer', 'Authorization: Bearer abc123.def456-ghi_789=', 'abc123.def456-ghi_789=', 'Bearer [token]'],
    ['bearer en minúsculas', 'header bearer ABCdef123456', 'ABCdef123456', 'Bearer [token]'],
    ['clave secreta de Stripe', `usando ${SK} en la petición`, SK, '[clave]'],
    ['clave restringida de Stripe', `clave ${RK}`, RK, '[clave]'],
    ['secreto de webhook', `firma con ${WHSEC}`, WHSEC, '[clave]'],
    ['id de sesión de pago', `checkout ${SESSION} no encontrado`, SESSION, '[id-pago]'],
    ['id de pago', `payment ${PI} falló`, PI, '[id-pago]'],
    ['JWT', `token ${JWT} caducado`, JWT, '[jwt]'],
    ['URL de BD', `P1001: no se alcanza ${DB}`, DB, '[url-bd]'],
    ['URL de Redis', 'conexión rediss://default:secreto123@redis.ejemplo.io:6379 rechazada', 'secreto123', '[url-bd]'],
  ])('%s', (_name, input, leaked, replacement) => {
    const out = scrubString(input);
    expect(out).not.toContain(leaked);
    expect(out).toContain(replacement);
  });

  it('elimina la query string y el fragmento de las URLs (llevan `t=`, tokens y firmas)', () => {
    const out = scrubString('GET https://cliente.es/confirmacion/abc?t=SECRETO123&x=1#frag falló y http://localhost:3000/api/x?token=zzz');
    expect(out).not.toMatch(/SECRETO123|frag|zzz|\?/);
    expect(out).toContain('https://[dominio]/confirmacion/abc'); // el dominio del cliente tampoco sale
  });

  it('elimina credenciales incrustadas en URLs', () => {
    const out = scrubString('fetch https://usuario:clave-super@api.ejemplo.com/v1 falló');
    expect(out).not.toMatch(/usuario|clave-super/);
  });

  it('tapa parámetros sueltos t=, token=, signature=, password=', () => {
    const out = scrubString('t=ABCDEF123456 token=xyz signature=abcd1234 password=hunter2 code=998877');
    expect(out).not.toMatch(/ABCDEF123456|xyz|abcd1234|hunter2|998877/);
    expect(out).toContain('t=[token]');
  });

  it('trunca los UUID y cuid de pedido/pago a 8 caracteres', () => {
    const out = scrubString('Order 3f2504e0-4f89-11d3-9a0c-0305e82c3301 y cmgxyz0123456789abcdefghi no encontrados');
    expect(out).toContain('3f2504e0…');
    expect(out).toContain('cmgxyz01…');
    expect(out).not.toMatch(/4f89|0305e82c3301|23456789abcdefghi/);
  });

  it('tapa cadenas opacas largas con letras y cifras, pero respeta nombres largos de función', () => {
    expect(scrubString('clave A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8')).toContain('[token]');
    expect(scrubString('en handleProviderWebhookCheckoutSessionCompletedAsync falló')).toContain('handleProviderWebhookCheckoutSessionCompletedAsync');
  });

  it('un error de Prisma (lleva la consulta con sus valores) se reduce a la operación y la última línea', () => {
    const msg = [
      '',
      'Invalid `prisma.order.create()` invocation:',
      '{',
      '  data: {',
      '    buyerName: "Ana García",',
      '    buyerEmail: "ana@correo.es",',
      '    buyerPhone: "612345678"',
      '  }',
      '}',
      '',
      'Unique constraint failed on the fields: (`buyerEmail`)',
    ].join('\n');
    const out = scrubString(msg);
    expect(out).toBe('Prisma prisma.order.create(): Unique constraint failed on the fields: (`buyerEmail`)');
    expect(out).not.toMatch(/Ana|ana@|612345678/);
  });

  it('recorta los textos largos y no se rompe con una entrada enorme', () => {
    expect(scrubString('x'.repeat(50_000)).length).toBeLessThanOrEqual(1001);
  });

  it('no estropea un mensaje normal ni palabras con guiones bajos', () => {
    const msg = 'TenantContextError: No hay un cliente (tenant) asociado a esta petición (in_progress, order_not_found)';
    expect(scrubString(msg)).toBe(msg);
  });
});

describe('truncateId', () => {
  it('deja 8 caracteres; lo que no es texto, vacío', () => {
    expect(truncateId('cm9abcdef0123456789')).toBe('cm9abcde');
    expect(truncateId('corto')).toBe('corto');
    expect(truncateId(undefined)).toBe('');
    expect(truncateId(12345678901)).toBe('');
  });
});

describe('scrubEvent: el evento entero', () => {
  const dirty = () => ({
    event_id: 'abc',
    message: 'Fallo con ana@correo.es',
    server_name: 'ip-10-0-0-1.lambda.internal',
    modules: { next: '15.5.28' },
    sdkProcessingMetadata: { normalizedRequest: { headers: { cookie: 'next-auth.session-token=SESION123', authorization: 'Bearer ZZZ' } } },
    request: {
      url: 'https://peña-ejemplo.es/api/orders?t=TOKEN123',
      method: 'POST',
      headers: { cookie: 'sesion=SESION123', authorization: 'Bearer ZZZ', host: 'peña-ejemplo.es' },
      cookies: { a: 'b' },
      data: { buyerEmail: 'ana@correo.es', buyerPhone: '612345678' },
      query_string: 't=TOKEN123',
    },
    user: { id: '1', email: 'ana@correo.es', ip_address: '1.2.3.4', username: 'ana' },
    tags: { runtime: 'node', host: 'peña-ejemplo.es', url: 'https://peña-ejemplo.es/x', business: 'Peña Ejemplo', route: 'POST /api/orders', order: '3f2504e0', tenant: 'peña-ejemplo.es' },
    contexts: {
      runtime: { name: 'node', version: 'v22.0.0' },
      trace: { trace_id: '0123456789abcdef0123456789abcdef', span_id: '0123456789abcdef', data: { 'url.full': 'https://peña-ejemplo.es/?t=1' } },
      nextjs: { request_path: '/confirmacion/ABCDEF?t=1', router_path: '/confirmacion/[orderId]', router_kind: 'App Router', route_type: 'render' },
      device: { name: 'ip-10-0-0-1' },
      os: { name: 'Linux' },
      cloud_resource: { 'cloud.provider': 'vercel' },
    },
    extra: { orderId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301', buyerEmail: 'ana@correo.es', body: '{"name":"Ana"}', nota: 'tel 612345678', anidado: { token: 'abc', ok: 'sí' } },
    breadcrumbs: [
      { type: 'http', category: 'fetch', level: 'info', timestamp: 1, message: 'POST https://api.stripe.com/v1/x?key=1 ana@correo.es', data: { url: 'https://api.stripe.com/v1/x', body: 'ana@correo.es' } },
    ],
    exception: {
      values: [
        {
          type: 'Error',
          value: `Falló el pedido de ana@correo.es con ${SK}`,
          mechanism: { type: 'generic', handled: false, data: { x: 'ana@correo.es' } },
          stacktrace: {
            frames: [
              {
                filename: '/var/task/.next/server/app/api/orders/route.js',
                abs_path: '/Users/pablo/proyecto/.next/server/app/api/orders/route.js',
                function: 'POST',
                lineno: 10,
                colno: 5,
                in_app: true,
                vars: { email: 'ana@correo.es' },
                pre_context: ['const email = "ana@correo.es";'],
                context_line: 'throw new Error(email)',
                post_context: ['}'],
              },
              { filename: 'file:///Users/pablo/dev/app/lib/x.ts?t=SECRETO', function: 'handle' },
              { abs_path: '/var/task/node_modules/@prisma/client/runtime/library.js', function: 'query' },
            ],
          },
        },
      ],
    },
  });
  const run = (over: Parameters<typeof scrubEvent>[1] = { tenantId: '01JABCDEFGHJKMNPQRSTVWXYZ0' }) => scrubEvent(dirty(), over) as Record<string, any>;

  it('elimina petición, usuario, máquina y metadatos de petición', () => {
    const e = run();
    for (const k of ['request', 'user', 'server_name', 'modules', 'sdkProcessingMetadata']) expect(e).not.toHaveProperty(k);
  });

  it('ninguna cadena del evento final contiene PII, secretos, Host ni nombres', () => {
    const json = JSON.stringify(run());
    for (const leak of ['ana@correo.es', 'ana.garcia', '612345678', 'SESION123', 'TOKEN123', 'ZZZ', 'SECRETO', SK, 'peña-ejemplo', 'Peña', 'lambda.internal', '/Users/pablo', 'Ana"', 'throw new Error']) {
      expect(json, `filtración: ${leak}`).not.toContain(leak);
    }
  });

  it('etiqueta tenant con el id y solo deja las etiquetas de la lista cerrada', () => {
    const e = run();
    expect(e.tags).toEqual({ runtime: 'node', route: 'POST /api/orders', order: '3f2504e0', tenant: '01JABCDEFGHJKMNPQRSTVWXYZ0' });
  });

  it('un `tenant` que parece un Host o un nombre NUNCA sale, y sin id conocido no se inventa', () => {
    expect(run({ tenantId: null }).tags).not.toHaveProperty('tenant'); // el de la etiqueta original era un Host
    expect(run({ tenantId: 'peña-ejemplo.es' }).tags).not.toHaveProperty('tenant');
    expect(run({ tenantId: 'Peña Ejemplo S.L.' }).tags).not.toHaveProperty('tenant');
    expect(run({ tenantId: 'legacy-01' }).tags.tenant).toBe('legacy-01');
  });

  it('marca el tipo de despliegue si se indica', () => {
    expect(run({ tenantId: 'x1', deployment: 'platform' }).tags.deployment).toBe('platform');
  });

  it('contextos: solo los permitidos y solo sus campos seguros (sin `request_path`)', () => {
    const e = run();
    expect(Object.keys(e.contexts).sort()).toEqual(['nextjs', 'runtime', 'trace']);
    expect(e.contexts.nextjs).toEqual({ router_path: '/confirmacion/[orderId]', router_kind: 'App Router', route_type: 'render' });
    expect(e.contexts.trace).toEqual({ trace_id: '0123456789abcdef0123456789abcdef', span_id: '0123456789abcdef' });
    expect(e.contexts.runtime).toEqual({ name: 'node', version: 'v22.0.0' });
  });

  it('extra: las claves con nombre de dato personal o de credencial se descartan por completo y el resto se redacta', () => {
    const e = run();
    expect(e.extra).not.toHaveProperty('buyerEmail');
    expect(e.extra).not.toHaveProperty('body');
    expect(e.extra.orderId).toBe('3f2504e0…');
    expect(e.extra.anidado).toEqual({ ok: 'sí' });
    expect(e.extra.nota).toContain('[telefono]');
  });

  it('breadcrumbs: sin `data` y con el mensaje redactado', () => {
    const e = run();
    expect(e.breadcrumbs).toHaveLength(1);
    expect(e.breadcrumbs[0]).not.toHaveProperty('data');
    expect(e.breadcrumbs[0].message).not.toMatch(/ana@|key=1/);
    expect(e.breadcrumbs[0]).toMatchObject({ type: 'http', category: 'fetch', level: 'info', timestamp: 1 });
  });

  it('excepción: mensaje redactado y pila con solo rutas relativas, nombres de función y líneas', () => {
    const e = run();
    const v = e.exception.values[0];
    expect(v.value).toBe('Falló el pedido de [email] con [clave]');
    expect(v.mechanism).not.toHaveProperty('data');
    const [f0, f1, f2] = v.stacktrace.frames;
    expect(f0).toEqual({ filename: '.next/server/app/api/orders/route.js', function: 'POST', lineno: 10, colno: 5, in_app: true });
    expect(f1.filename).toBe('app/lib/x.ts'); // tres últimos tramos, sin query
    expect(f2.filename).toBe('node_modules/@prisma/client/runtime/library.js');
    for (const f of v.stacktrace.frames) for (const k of ['vars', 'pre_context', 'context_line', 'post_context', 'abs_path']) expect(f).not.toHaveProperty(k);
  });

  it('un evento mínimo o con formas raras no revienta', () => {
    expect(() => scrubEvent({}, {})).not.toThrow();
    expect(() => scrubEvent({ exception: { values: [null, 3, { value: 5 }] }, breadcrumbs: [null, 'x'], contexts: { nextjs: 'raro' }, tags: { a: { b: 1 } }, extra: null } as never, {})).not.toThrow();
  });

  it('es idempotente (volver a depurar no cambia nada)', () => {
    const once = run();
    expect(scrubEvent(structuredClone(once), { tenantId: '01JABCDEFGHJKMNPQRSTVWXYZ0' })).toEqual(once);
  });
});

describe('scrubBreadcrumb', () => {
  it('conserva solo categoría, nivel, tipo, hora y un mensaje corto redactado', () => {
    const out = scrubBreadcrumb({ category: 'console', level: 'error', type: 'default', timestamp: 5, message: 'x'.repeat(500) + ' ana@correo.es', data: { arguments: ['ana@correo.es'] } }) as Record<string, unknown>;
    expect(Object.keys(out).sort()).toEqual(['category', 'level', 'message', 'timestamp', 'type']);
    expect((out.message as string).length).toBeLessThanOrEqual(201);
  });
  it('un valor que no es un objeto se descarta', () => {
    expect(scrubBreadcrumb('texto' as never)).toBeNull();
  });
});
