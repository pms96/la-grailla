-- Catálogo inicial del producto La Grailla (datos de referencia). Cambios futuros
-- del catálogo van en migraciones nuevas, no editando esta.
INSERT INTO "Product" ("key", "name") VALUES ('grailla', 'La Grailla') ON CONFLICT DO NOTHING;

INSERT INTO "ModuleDef" ("productKey", "key", "name", "isCore", "monthlyAddon", "sortOrder") VALUES
  ('grailla', 'nucleo',       'Núcleo',            true,  false, 0),
  ('grailla', 'tienda',       'Tienda online',     false, false, 1),
  ('grailla', 'entradas',     'Venta de entradas', false, false, 2),
  ('grailla', 'contabilidad', 'Contabilidad',      false, false, 3),
  ('grailla', 'wallets',      'Wallets',           false, true,  4),
  ('grailla', 'sponsors',     'Sponsors',          false, false, 5)
ON CONFLICT DO NOTHING;
