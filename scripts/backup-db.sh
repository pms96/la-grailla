#!/usr/bin/env bash
# Copia de seguridad (pg_dump) de la BD de un cliente, en tu Mac. SOLO LEE la BD: no modifica nada.
#
#   export LAGRAILLA_DB_DIRECT='postgresql://…'          # URL DIRECTA (sin «-pooler»); pégala en tu terminal, no en un fichero del repo
#   scripts/backup-db.sh LAGRAILLA_DB_DIRECT [carpeta]
#
# Deja en la carpeta (por defecto ~/grailla-produccion/backups, fuera del repo, permisos 700) dos ficheros:
#   lagrailla-AAAAMMDD-HHMMSS.dump         formato «custom» de pg_dump (se restaura con pg_restore)
#   lagrailla-AAAAMMDD-HHMMSS.dump.sha256  huella para comprobar que no se ha corrompido al copiarlo
#
# La URL nunca va como argumento (se vería en `ps`): se lee de la variable de entorno y se pasa a pg_dump con las variables PG*.
# El volcado lleva datos personales de compradores: guárdalo en un disco cifrado (FileVault) y no lo subas a ningún sitio sin cifrar.
set -euo pipefail
# `shasum` es un script de perl y se queja si el idioma de la terminal no existe en el Mac (p. ej. en_ES.UTF-8). Es solo un aviso.
export LC_ALL=C

VAR="${1:-}"
OUT="${2:-$HOME/grailla-produccion/backups}"
[ -n "$VAR" ] || { echo "Uso: $0 NOMBRE_DE_LA_VARIABLE_CON_LA_URL_DIRECTA [carpeta]" >&2; exit 2; }
URL="${!VAR:-}"
[ -n "$URL" ] || { echo "La variable $VAR está vacía o no existe. Expórtala antes: export $VAR='postgresql://…'" >&2; exit 2; }
case "$URL" in
  postgres://*|postgresql://*) ;;
  *) echo "La variable $VAR no parece una URL de Postgres." >&2; exit 2 ;;
esac
case "$URL" in
  *-pooler*) echo "Esa es la URL «pooled» (lleva -pooler). pg_dump necesita la URL DIRECTA: en Neon, desactiva «Connection pooling» al copiarla." >&2; exit 2 ;;
esac

# Homebrew instala libpq sin ponerlo en el PATH.
for d in /opt/homebrew/opt/libpq/bin /usr/local/opt/libpq/bin; do [ -d "$d" ] && PATH="$d:$PATH"; done
command -v pg_dump >/dev/null || { echo "Falta pg_dump. Instálalo con: brew install libpq" >&2; exit 2; }
command -v pg_restore >/dev/null || { echo "Falta pg_restore (viene con libpq)." >&2; exit 2; }
command -v node >/dev/null || { echo "Falta node (se usa para leer la URL sin mostrarla)." >&2; exit 2; }

# La URL se descompone en variables PG* dentro de este proceso (sin imprimirla).
eval "$(URL_TO_PARSE="$URL" node -e '
  const u = new URL(process.env.URL_TO_PARSE);
  const q = (v) => "\x27" + String(v).replace(/\x27/g, "\x27\\\x27\x27") + "\x27";
  const out = {
    PGHOST: u.hostname,
    PGPORT: u.port || "5432",
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: decodeURIComponent(u.pathname.replace(/^\//, "")),
    PGSSLMODE: u.searchParams.get("sslmode") || "require",
  };
  for (const [k, v] of Object.entries(out)) console.log("export " + k + "=" + q(v));
')"

umask 077
mkdir -p "$OUT"
chmod 700 "$OUT"
STAMP="$(date +%Y%m%d-%H%M%S)"
FILE="$OUT/lagrailla-$STAMP.dump"

echo "Volcando $PGDATABASE de $PGHOST …"
pg_dump --format=custom --no-owner --no-acl --file="$FILE"
chmod 600 "$FILE"

# Comprobaciones: el fichero se puede leer entero y lista sus tablas.
pg_restore --list "$FILE" > /dev/null
TABLES="$(pg_restore --list "$FILE" | grep -c ' TABLE DATA ' || true)"
(cd "$OUT" && shasum -a 256 "$(basename "$FILE")" > "$(basename "$FILE").sha256")
chmod 600 "$FILE.sha256"

echo "Hecho: $FILE"
echo "  tamaño:  $(du -h "$FILE" | cut -f1)"
echo "  tablas con datos: $TABLES"
echo "  huella:  $(cut -d' ' -f1 "$FILE.sha256")"
echo "Siguiente paso recomendado: probar que se restaura (docs/platform/m9-primer-despliegue.md, «Copias de seguridad»)."
