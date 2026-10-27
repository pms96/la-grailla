import { describe, expect, it } from 'vitest';
import { collapsePrismaMessage, scrubEvent, scrubString } from '@/lib/observability/scrub';

/* P0-07 (revisión adversarial, A1/B1): lo que sale hacia Sentry no puede llevar datos de personas aunque el error venga de Prisma (con la consulta y sus
 * valores), de SQL en crudo, de la red o de una librería. Los mensajes de Prisma de abajo son los REALES de Prisma 6.7 (capturados provocando cada fallo),
 * con datos inventados y rutas acortadas. Estos casos se convierten en la regresión permanente de los hallazgos reproducidos. */

const real = {
  raw: '\nInvalid `prisma.$queryRaw()` invocation:\n\n\nRaw query failed. Code: `22P02`. Message: `ERROR: invalid input syntax for type integer: "Juan Perez García"`',
  exec: '\nInvalid `prisma.$executeRaw()` invocation:\n\n\nRaw query failed. Code: `22P02`. Message: `ERROR: invalid input syntax for type integer: "Maria Lopez"`',
  tx:
    '\nInvalid `tx.order.update()` invocation in\n/var/task/.next/server/app/api/orders/route.js:8:61\n\n  5 const a = 1;\n→ 8 try { await tx.order.update(\n' +
    'An operation failed because it depends on one or more records that were required but not found. Record to update not found.',
  create:
    '\nInvalid `p.order.create()` invocation in\n/var/task/.next/server/app/api/orders/route.js:9:23\n\n  8 foo\n→ 9 try { await p.order.create({\n      data: {\n        buyerName: "Maria Lopez Gómez",\n' +
    '        buyerEmail: "maria@x.com",\n        totalAmount: "abc",\n    +   buyerLastName: String\n      }\n    })\n\nArgument `buyerLastName` is missing.',
  wrongValue: '\nInvalid `tx.order.update()` invocation in\n/var/task/x.js:12:3\n\n{ data: { buyerName: 5 } }\n\nArgument `buyerName`: Invalid value provided. Expected String, provided Juan Pérez.',
  neon:
    "\nInvalid `p2.order.findMany()` invocation in\n/var/task/x.js:13:24\n\n→ 13 try { await p2.order.findMany(\nCan't reach database server at `ep-aged-sky-123456-pooler.eu-central-1.aws.neon.tech:5432`\n\n" +
    'Please make sure your database server is running at `ep-aged-sky-123456-pooler.eu-central-1.aws.neon.tech:5432`.',
};

describe('A1: errores de Prisma con cualquier nombre de llamada', () => {
  it('prisma.$queryRaw y $executeRaw: solo la operación y el código SQLSTATE (el valor enlazado no sale)', () => {
    expect(scrubString(real.raw)).toBe('Prisma prisma.$queryRaw(): Raw query failed (código 22P02)');
    expect(scrubString(real.exec)).toBe('Prisma prisma.$executeRaw(): Raw query failed (código 22P02)');
  });

  it('tx.* dentro de $transaction: operación y motivo; ni la ruta del fichero ni el código de contexto', () => {
    const out = scrubString(real.tx);
    expect(out).toBe('Prisma tx.order.update(): An operation failed because it depends on one or more records that were required but not found. Record to update not found.');
    expect(out).not.toMatch(/var\/task|route\.js|const a/);
  });

  it('PrismaClientValidationError con `p.order.create`: ni nombre ni apellidos ni email del comprador; queda el campo que falta', () => {
    const out = scrubString(real.create);
    expect(out).toBe('Prisma p.order.create(): Argument `buyerLastName` is missing.');
    expect(out).not.toMatch(/Maria|Gómez|maria@|abc/);
  });

  it('un valor en la última línea («provided Juan Pérez») tampoco sale', () => {
    const out = scrubString(real.wrongValue);
    expect(out).not.toMatch(/Juan|Pérez/);
    expect(out).toContain('Prisma tx.order.update()');
  });

  it('P1001: la operación, el motivo y el endpoint de Neon NO (ni con puerto, ni en la última línea)', () => {
    const out = scrubString(real.neon);
    expect(out).not.toMatch(/neon\.tech|ep-aged-sky|5432/);
    expect(out).toContain('Prisma p2.order.findMany()');
  });

  it.each([
    ['this.prisma.order.update()', 'Invalid `this.prisma.order.update()` invocation: { buyerName: "Ana Ruiz" } fail'],
    ['prisma.$transaction()', 'Invalid `prisma.$transaction()` invocation: tx value "Pedro Gomez"'],
    ['db.$queryRawUnsafe()', 'Invalid `db.$queryRawUnsafe()` invocation:\n\n{ sql: "SELECT * WHERE n = \'Pedro Gomez\'" }'],
  ])('una sola línea o forma rara (%s): la operación y nada de los valores', (op, msg) => {
    const out = scrubString(msg);
    expect(out.startsWith(`Prisma ${op}`)).toBe(true);
    expect(out).not.toMatch(/Ana|Pedro|Ruiz|Gomez/);
  });

  it('collapsePrismaMessage devuelve null si el mensaje no es de una llamada de Prisma', () => {
    expect(collapsePrismaMessage('Pedido no encontrado')).toBeNull();
  });

  it('por CLASE de error: un PrismaClient*Error sin «invocation» en el mensaje se queda en su primera línea', () => {
    const ev = { exception: { values: [{ type: 'PrismaClientValidationError', value: 'Argument `x` is missing.\nbuyerName: "María Pérez Gómez"\nbuyerEmail: "m@x.com"' }] } };
    const json = JSON.stringify(scrubEvent(ev, {}));
    expect(json).not.toMatch(/María|Pérez|Gómez|m@x/);
    expect(json).toContain('Argument `x` is missing.');
  });

  it('de extremo a extremo con scrubEvent: pila, mensaje y tipo de un error real', () => {
    const ev = { exception: { values: [{ type: 'PrismaClientValidationError', value: real.create, stacktrace: { frames: [{ filename: '/var/task/.next/server/app/api/orders/route.js', function: 'POST', lineno: 1, vars: { buyerName: 'María' } }] } }] } };
    const json = JSON.stringify(scrubEvent(ev, { tenantId: 'T1' }));
    expect(json).not.toMatch(/Maria|María|Gómez|maria@|vars/);
    expect(json).toContain('Argument `buyerLastName` is missing.');
  });
});

describe('B1: más fugas reproducidas', () => {
  const leaks: [string, string, string[]][] = [
    ['host de BD (Neon) con puerto', "Can't reach database server at `ep-cool-123.eu-central-1.aws.neon.tech:5432`", ['neon.tech', 'ep-cool-123']],
    ['host de BD sin puerto', 'getaddrinfo ENOTFOUND ep-cool-123.eu-central-1.aws.neon.tech', ['neon.tech', 'ep-cool-123']],
    ['Supabase y RDS', 'db.abcdefgh.supabase.co timed out; mydb.c9xyz.eu-west-1.rds.amazonaws.com refused', ['supabase.co', 'rds.amazonaws.com', 'abcdefgh']],
    ['host:puerto cualquiera', 'connect ECONNREFUSED bd-interna.cliente-x.net:6543', ['cliente-x', '6543']],
    ['dominio del cliente en un mensaje', 'ENOTFOUND www.cliente-secreto.es', ['cliente-secreto']],
    ['dominio sin ENOTFOUND', 'Host cliente-secreto.es not allowed; smtp.mi-negocio.com rechazó', ['cliente-secreto', 'mi-negocio']],
    ['URL absoluta: dominio y query', 'GET https://www.lagrailla.es/confirmacion/x?t=AbCdEfGhIjKlMnOp&x=1 failed', ['lagrailla', 'AbCdEf', 'x=1']],
    ['query de URL relativa', 'fetch /api/admin/orders?q=juan%40x.com&page=2 falló', ['juan', 'q=', 'page=2']],
    ['email codificado', 'user%40example.com failed', ['user%40', 'example.com']],
    ['email de ancho completo', 'juan＠example.com', ['juan', 'example']],
    ['IBAN', 'IBAN ES9121000418450200051332 rejected', ['ES9121', '0418450200']],
    ['IBAN con espacios', 'cuenta ES91 2100 0418 4502 0005 1332', ['2100 0418', '1332']],
    ['DNI y NIE', 'DNI 12345678Z duplicado; NIE X1234567L', ['12345678Z', 'X1234567L']],
    ['tarjeta', 'card 4242 4242 4242 4242 declined', ['4242 4242']],
    ['IPv4', 'from 203.0.113.7 blocked', ['203.0.113.7']],
    ['IPv6', 'from 2001:db8::1 and fe80::1ff:fe23:4567:890a', ['2001:db8', 'fe80']],
    ['teléfono de 11 dígitos sin +', 'tel 34600112233 inválido', ['34600112233']],
    ['teléfonos con formatos raros', 'tel: (34) 600-11-22-33 / 600 112 233 / +34-600-112-233 / 0034600112233 / 600.11.22.33', ['600-11', '600 112', '600-112', '0034600', '600.11']],
    ['teléfono internacional no español', 'call +1 (415) 555-2671 or +44 20 7946 0958', ['415', '7946']],
    ['cabecera Cookie en un mensaje', 'Cookie: __Secure-next-auth.session-token=eyJhbGciOiJkaXIi; foo=bar', ['eyJhbGci', 'foo=bar']],
    ['Stripe-Signature', 'Stripe-Signature: t=1700000000,v1=abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890', ['abcdef1234567890', '1700000000']],
    ['credenciales en URL', 'https://user:secret@api.example.com/x', ['secret', 'user:']],
  ];
  it.each(leaks)('%s', (_name, input, forbidden) => {
    const out = scrubString(input);
    for (const f of forbidden) expect(out, `filtración de «${f}» en «${out}»`).not.toContain(f);
  });

  it('no sobre-redacta lo corriente: rutas de fichero, nombres de función y números pequeños', () => {
    const msg = 'at POST (.next/server/app/api/orders/route.js:12:34) TenantContextError: sin cliente (3 intentos, HTTP 502, hora 12:30:45)';
    expect(scrubString(msg)).toBe(msg);
  });
});

describe('claves de datos personales en `extra`: se descartan por completo', () => {
  it('buyerName, buyerLastName, holderName, firstName, lastName, email, phone, address, name…', () => {
    const extra = {
      buyerName: 'Juan Pérez', buyerLastName: 'López', holderName: 'Ana', firstName: 'Luis', lastName: 'Garcia', fullName: 'X Y', customer_name: 'Z',
      email: 'a@b.com', buyerEmail: 'a@b.com', phone: '612345678', phoneNumber: '1', address: 'Calle Mayor 3', shippingAddress: 'x', name: 'x', nombre: 'x', zip: '28001',
      password: 'p', apiKey: 'k', authToken: 't', dni: '1', iban: 'x',
      anidado: { buyerName: 'Z', lastName: 'Garcia', ok: 'sí' },
      lista: [{ buyerLastName: 'Lopez', cuenta: 'ES9121000418450200051332' }],
      route: 'POST /x', orderId: 'cm9abcdefghijklmnopqrstuv',
    };
    const out = scrubEvent({ extra }, {}) as { extra: Record<string, any> };
    expect(Object.keys(out.extra).sort()).toEqual(['anidado', 'lista', 'orderId', 'route']);
    expect(out.extra.anidado).toEqual({ ok: 'sí' });
    expect(JSON.stringify(out)).not.toMatch(/Juan|Pérez|López|Luis|Garcia|a@b|612345678|Calle|ES9121/);
  });

  it('threads, debug_meta, spans y fingerprint no se cuelan sin depurar', () => {
    const ev = {
      threads: { values: [{ stacktrace: { frames: [{ filename: '/Users/pablo/x.js', vars: { email: 'a@b.com' } }] } }] },
      debug_meta: { images: [{ code_file: '/Users/pablo/secret.node' }] },
      spans: [{ description: 'SELECT * FROM User WHERE email = ?' }],
      fingerprint: ['a@b.com'],
    };
    const out = scrubEvent(ev, {}) as Record<string, unknown>;
    expect(out).not.toHaveProperty('threads');
    expect(out).not.toHaveProperty('debug_meta');
    expect(out).not.toHaveProperty('spans');
    expect(JSON.stringify(out)).not.toMatch(/a@b|pablo/);
  });
});

describe('sin ReDoS: entradas adversarias en milisegundos', () => {
  const inputs: Record<string, string> = {
    dots: 'a.'.repeat(2000), plus: '+1 '.repeat(1300), digits: '1 '.repeat(2000), mails: 'a@'.repeat(2000), dashes: '-'.repeat(4000),
    hostlike: ('a'.repeat(30) + '.').repeat(130), http: 'http://' + 'a?'.repeat(2000), eq: 't='.repeat(2000), pct: '%40'.repeat(1300),
    mix: '+34 600 11 22 33 '.repeat(250), ids: 'cs_test_'.repeat(500), long: 'A1'.repeat(2000), apos: "'".repeat(4000), at: '@'.repeat(4000), dotat: 'a.@'.repeat(1300),
    emailish: ('a'.repeat(50) + '@' + 'b'.repeat(50) + '.').repeat(40), nearEmail: 'a'.repeat(3900) + '@', nearEmail2: 'a.'.repeat(1900) + '@b',
    colons: ':'.repeat(4000), hexcolons: 'a:'.repeat(2000), ipv4ish: '1.'.repeat(2000), slashq: '/a'.repeat(1000) + '?', digitsep: '1-'.repeat(2000), cards: '4 '.repeat(2000),
    slashnq: '/a'.repeat(2000), hostport: 'a.'.repeat(1500) + ':', dbhost: 'a.'.repeat(1500) + 'neon', nolabel: 'a'.repeat(4000) + '.es', domains: 'ab.cd.'.repeat(700), percent: 'a%40'.repeat(1000),
    prismaLike: '`a.b()` invocation\n'.repeat(200), tlds: 'ab.es '.repeat(600), cookies: 'Cookie:'.repeat(570),
  };
  it.each(Object.entries(inputs))('%s', (_k, v) => {
    // Medida local: ≤ 12 ms en todos. El umbral del test es más holgado para no ser frágil en una CI lenta; un backtracking real tarda segundos.
    scrubString(v); // calentamiento
    const t = performance.now();
    scrubString(v);
    expect(performance.now() - t).toBeLessThan(60);
  });
});
