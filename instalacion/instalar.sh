#!/usr/bin/env bash
# Instalador de Partida para Linux y macOS.
#
#   bash instalacion/instalar.sh
#
# Instala lo que falte (Node.js y PostgreSQL), crea la base "contable", el archivo .env,
# las tablas y el usuario administrador, y opcionalmente deja el sistema como servicio.
# Ejecutalo con tu usuario normal, sin sudo: pide la clave de administrador cuando la necesita.
set -euo pipefail

PG_MINIMO=15          # versión mínima de PostgreSQL que necesita el sistema
PG_A_INSTALAR=17      # versión que se instala si no hay una adecuada
NODE_MINIMO="20.11"

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$RAIZ"

# ---------- utilidades ----------
if [[ -t 1 ]]; then C_T=$'\e[1;36m'; C_OK=$'\e[32m'; C_AV=$'\e[33m'; C_ER=$'\e[31m'; C_B=$'\e[1m'; C_0=$'\e[0m'
else C_T=""; C_OK=""; C_AV=""; C_ER=""; C_B=""; C_0=""; fi
titulo() { echo; echo "${C_T}== $* ==${C_0}"; }
ok()     { echo "  ${C_OK}OK${C_0}  $*"; }
aviso()  { echo "  ${C_AV}!${C_0}   $*"; }
fallar() { echo "  ${C_ER}X${C_0}   $*" >&2; exit 1; }

# preguntar_sn "texto" S|N  → devuelve 0 si la respuesta es sí
preguntar_sn() {
  local defecto="$2" opciones r
  [[ "$defecto" == "S" ]] && opciones="S/n" || opciones="s/N"
  read -r -p "$1 [$opciones]: " r || true
  r="${r:-$defecto}"
  [[ "$r" =~ ^[sSyY] ]]
}

# Ejecuta un comando como root (con sudo si hace falta)
como_root() { if [[ $EUID -eq 0 ]]; then "$@"; else sudo "$@"; fi; }
# Ejecuta un comando como el usuario "postgres" (Linux), desde una carpeta que pueda leer
como_postgres() {
  if [[ $EUID -eq 0 ]]; then (cd /tmp && runuser -u postgres -- "$@"); else (cd /tmp && sudo -u postgres "$@"); fi
}

version_mayor_igual() { # version_mayor_igual 22.3.0 20.11  → 0 si la primera es >= la segunda
  [[ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" == "$2" ]]
}

if [[ $EUID -eq 0 && -n "${SUDO_USER:-}" ]]; then
  aviso "Estás ejecutando el instalador con sudo. Conviene ejecutarlo con tu usuario normal: bash instalacion/instalar.sh"
  preguntar_sn "¿Continuar igual como root?" N || exit 1
fi
if [[ $EUID -ne 0 ]] && [[ "$(uname -s)" == "Linux" ]] && ! command -v sudo >/dev/null; then
  fallar "No se encontró sudo. Ejecutá el instalador como root o instalá sudo."
fi

echo "${C_B}Partida: instalador para Linux y macOS${C_0}"
echo "Carpeta del sistema: $RAIZ"

# ---------- 1. Sistema operativo ----------
titulo "1. Sistema operativo"
SO="desconocido"; DESCRIPCION="$(uname -s)"; DISTRO_ID=""
case "$(uname -s)" in
  Darwin)
    SO="macos"; DESCRIPCION="macOS $(sw_vers -productVersion 2>/dev/null || true)" ;;
  Linux)
    if [[ -r /etc/os-release ]]; then
      # shellcheck disable=SC1091
      . /etc/os-release
      DISTRO_ID="${ID:-}"; DESCRIPCION="${PRETTY_NAME:-Linux}"
      familia=" ${ID:-} ${ID_LIKE:-} "
      if   [[ "$familia" =~ \ (debian|ubuntu)\  ]]; then SO="debian"
      elif [[ "$familia" =~ \ (fedora|rhel|centos|rocky|almalinux)\  ]]; then SO="fedora"
      elif [[ "$familia" =~ \ (arch|manjaro)\  ]]; then SO="arch"
      fi
    fi ;;
esac

echo "Sistema detectado: $DESCRIPCION"
if [[ "$SO" == "desconocido" ]] || ! preguntar_sn "¿Es correcto?" S; then
  echo
  echo "Elegí tu sistema:"
  echo "  1) Ubuntu, Debian, Linux Mint u otro derivado"
  echo "  2) Fedora, Red Hat, Rocky, AlmaLinux o CentOS"
  echo "  3) Arch o Manjaro"
  echo "  4) macOS"
  echo "  5) Windows"
  echo "  6) Salir"
  read -r -p "Opción: " op
  case "$op" in
    1) SO="debian" ;; 2) SO="fedora" ;; 3) SO="arch" ;; 4) SO="macos" ;;
    5) echo "En Windows usá el instalador para Windows: doble clic en instalacion\\instalar.bat"; exit 0 ;;
    *) exit 0 ;;
  esac
fi
ok "Instalación para: $SO"

if [[ "$SO" == "macos" ]] && ! command -v brew >/dev/null; then
  aviso "macOS necesita Homebrew (https://brew.sh) para instalar Node.js y PostgreSQL."
  if preguntar_sn "¿Instalar Homebrew ahora?" S; then
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    [[ -x /opt/homebrew/bin/brew ]] && eval "$(/opt/homebrew/bin/brew shellenv)"
    [[ -x /usr/local/bin/brew ]] && eval "$(/usr/local/bin/brew shellenv)"
  else
    fallar "Instalá Homebrew y volvé a ejecutar el instalador."
  fi
fi

# ---------- 2. Node.js ----------
titulo "2. Node.js"
node_actual() { command -v node >/dev/null && node -p 'process.versions.node' 2>/dev/null || true; }
VN="$(node_actual)"
if [[ -n "$VN" ]] && version_mayor_igual "$VN" "$NODE_MINIMO"; then
  ok "Node.js $VN ya está instalado"
else
  [[ -n "$VN" ]] && aviso "Node.js $VN es anterior a $NODE_MINIMO: se instala la versión LTS"
  case "$SO" in
    debian)
      como_root apt-get update -q
      como_root apt-get install -y -q curl ca-certificates
      curl -fsSL https://deb.nodesource.com/setup_lts.x | como_root bash -
      como_root apt-get install -y -q nodejs ;;
    fedora)
      curl -fsSL https://rpm.nodesource.com/setup_lts.x | como_root bash -
      como_root dnf install -y -q nodejs ;;
    arch)
      como_root pacman -Sy --needed --noconfirm nodejs npm ;;
    macos)
      brew install node ;;
  esac
  hash -r
  VN="$(node_actual)"
  [[ -n "$VN" ]] && version_mayor_igual "$VN" "$NODE_MINIMO" || fallar "No se pudo instalar Node.js $NODE_MINIMO o superior."
  ok "Node.js $VN instalado"
fi

# ---------- 3. PostgreSQL ----------
titulo "3. PostgreSQL"
PG_BIN=""
if [[ "$SO" == "macos" ]]; then
  for v in 18 17 16 15; do
    if [[ -x "$(brew --prefix)/opt/postgresql@$v/bin/psql" ]]; then PG_BIN="$(brew --prefix)/opt/postgresql@$v/bin"; break; fi
  done
  [[ -n "$PG_BIN" ]] && export PATH="$PG_BIN:$PATH"
fi

pg_cliente_mayor() { command -v psql >/dev/null && psql --version | grep -oE '[0-9]+' | head -n1 || true; }
PG_EXISTENTE="no"
MAYOR="$(pg_cliente_mayor)"
if [[ -n "$MAYOR" && "$MAYOR" -ge $PG_MINIMO ]]; then
  PG_EXISTENTE="si"
  ok "PostgreSQL $MAYOR ya está instalado"
else
  [[ -n "$MAYOR" ]] && aviso "PostgreSQL $MAYOR es anterior a $PG_MINIMO: se instala PostgreSQL $PG_A_INSTALAR"
  case "$SO" in
    debian)
      como_root apt-get update -q
      candidato="$(apt-cache policy postgresql 2>/dev/null | awk '/Candidate:/ {print $2}')"
      mayor_candidato="${candidato%%[^0-9]*}"
      if [[ -n "$mayor_candidato" && "$mayor_candidato" -ge $PG_MINIMO ]]; then
        como_root apt-get install -y -q postgresql
      else
        aviso "El repositorio del sistema trae una versión vieja: se agrega el repositorio oficial de PostgreSQL"
        como_root apt-get install -y -q postgresql-common
        como_root /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
        como_root apt-get install -y -q "postgresql-$PG_A_INSTALAR"
      fi
      como_root systemctl enable --now postgresql ;;
    fedora)
      if [[ "$DISTRO_ID" != "fedora" ]]; then
        como_root dnf module reset -y -q postgresql || true
        como_root dnf module enable -y -q postgresql:16 || aviso "No se pudo elegir la versión 16; se usa la del sistema"
      fi
      como_root dnf install -y -q postgresql-server postgresql
      if ! como_root test -f /var/lib/pgsql/data/PG_VERSION; then como_root postgresql-setup --initdb; fi
      # En esta familia la conexión local por red viene con "ident": se cambia a clave (scram-sha-256)
      como_root sed -i -E 's/^(host[[:space:]]+all[[:space:]]+all[[:space:]]+(127\.0\.0\.1\/32|::1\/128)[[:space:]]+)ident/\1scram-sha-256/' /var/lib/pgsql/data/pg_hba.conf
      como_root systemctl enable postgresql
      como_root systemctl restart postgresql ;;
    arch)
      como_root pacman -S --needed --noconfirm postgresql
      if ! como_root test -f /var/lib/postgres/data/PG_VERSION; then
        como_postgres initdb -D /var/lib/postgres/data --locale=C.UTF-8 --encoding=UTF8 --auth-local=peer --auth-host=scram-sha-256
      fi
      como_root systemctl enable --now postgresql ;;
    macos)
      brew install "postgresql@$PG_A_INSTALAR"
      PG_BIN="$(brew --prefix)/opt/postgresql@$PG_A_INSTALAR/bin"
      export PATH="$PG_BIN:$PATH"
      brew services start "postgresql@$PG_A_INSTALAR" ;;
  esac
  hash -r
  ok "PostgreSQL instalado"
fi

# Asegurar que el servidor esté en marcha y esperar a que acepte conexiones
if [[ "$SO" == "macos" ]]; then
  if [[ -n "$PG_BIN" ]] && ! pg_isready -h localhost -q 2>/dev/null; then
    brew services start "$(basename "$(dirname "$PG_BIN")")" || true
  fi
else
  como_root systemctl start postgresql 2>/dev/null || true
fi
for _ in $(seq 1 30); do
  if pg_isready -h localhost -q 2>/dev/null; then break; fi
  sleep 1
done
pg_isready -h localhost -q 2>/dev/null || fallar "PostgreSQL no responde en localhost:5432. Revisá: systemctl status postgresql"
ok "El servidor responde en localhost:5432"

# ---------- 4. Clave del usuario postgres ----------
titulo "4. Clave del administrador de la base (usuario postgres)"
PG_CLAVE=""
definir_clave=1
if [[ "$PG_EXISTENTE" == "si" ]] && preguntar_sn "PostgreSQL ya estaba instalado. ¿Conocés la clave actual del usuario postgres?" N; then
  read -r -s -p "Clave actual del usuario postgres: " PG_CLAVE; echo
  definir_clave=0
fi
if [[ $definir_clave -eq 1 ]]; then
  [[ "$PG_EXISTENTE" == "si" ]] && aviso "Se le asigna una clave nueva. Si otras aplicaciones usan el usuario postgres, actualizá su configuración."
  read -r -s -p "Clave nueva para el usuario postgres (vacío = generar una al azar): " PG_CLAVE; echo
  if [[ -z "$PG_CLAVE" ]]; then
    PG_CLAVE="$(node -e "console.log(require('crypto').randomBytes(18).toString('base64url'))")"
    CLAVE_GENERADA=1
  fi
  if [[ "$SO" == "macos" ]]; then
    # En Homebrew el superusuario es tu usuario de macOS; se crea también el usuario postgres
    psql -d postgres -v ON_ERROR_STOP=1 -v pw="$PG_CLAVE" -q <<'SQL'
SELECT 'CREATE ROLE postgres SUPERUSER LOGIN' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') \gexec
ALTER ROLE postgres WITH SUPERUSER LOGIN PASSWORD :'pw';
SQL
  else
    como_postgres psql -d postgres -v ON_ERROR_STOP=1 -v pw="$PG_CLAVE" -q <<'SQL'
ALTER ROLE postgres WITH PASSWORD :'pw';
SQL
  fi
  ok "Clave asignada al usuario postgres"
fi
if PGPASSWORD="$PG_CLAVE" psql -h localhost -U postgres -d postgres -tAc 'SELECT 1' >/dev/null 2>&1; then
  ok "Conexión con clave verificada"
else
  aviso "No se pudo verificar la conexión con clave; el configurador lo va a volver a intentar."
fi

# ---------- 5. Dependencias ----------
titulo "5. Dependencias de Node.js"
npm install --omit=dev --no-fund --no-audit
ok "Dependencias instaladas"

# ---------- 6. Base, .env, tablas y usuario ----------
titulo "6. Configuración de Partida"
PG_SUPERUSUARIO=postgres PG_SUPERCLAVE="$PG_CLAVE" node instalacion/configurar.js

# ---------- 7. Inicio automático y red ----------
titulo "7. Inicio automático"
USUARIO_SERVICIO="${SUDO_USER:-$(id -un)}"
NODE_RUTA="$(command -v node)"
if [[ "$SO" != "macos" && -d /run/systemd/system ]]; then
  if preguntar_sn "¿Instalar Partida como servicio, para que arranque solo al prender la computadora?" S; then
    como_root tee /etc/systemd/system/partida.service >/dev/null <<UNIDAD
[Unit]
Description=Partida - sistema contable
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
User=$USUARIO_SERVICIO
WorkingDirectory=$RAIZ
ExecStart=$NODE_RUTA "--env-file=$RAIZ/.env" "$RAIZ/src/app.js"
Environment=NODE_ENV=production
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIDAD
    como_root systemctl daemon-reload
    como_root systemctl enable --now partida
    ok "Servicio 'partida' instalado y en ejecución (systemctl status partida)"
    SERVICIO=1
  fi
  if command -v ufw >/dev/null && como_root ufw status 2>/dev/null | grep -q "Status: active"; then
    if preguntar_sn "El firewall está activo. ¿Permitir que otras computadoras de la red usen el sistema (puerto 3000)?" N; then
      como_root ufw allow 3000/tcp
      ok "Puerto 3000 habilitado en el firewall"
    fi
  fi
else
  aviso "Sin servicio automático en este sistema. Para iniciar: cd \"$RAIZ\" && npm start"
fi

# ---------- 8. Copia de seguridad diaria ----------
titulo "8. Copia de seguridad diaria"
if command -v crontab >/dev/null; then
  if preguntar_sn "¿Programar una copia de seguridad todos los días a las 21:00 (se guardan 30 días)?" S; then
    LINEA="0 21 * * * cd \"$RAIZ\" && \"$NODE_RUTA\" instalacion/respaldo.js >> \"$RAIZ/respaldos/respaldo.log\" 2>&1"
    mkdir -p "$RAIZ/respaldos"
    ( crontab -l 2>/dev/null | grep -v 'instalacion/respaldo.js' || true; echo "$LINEA" ) | crontab -
    ok "Copia diaria programada. Las copias quedan en $RAIZ/respaldos"
    aviso "Copiá esa carpeta a otro disco o a la nube: una copia en la misma computadora no protege si se rompe el disco."
  fi
else
  aviso "No se encontró cron: programá a mano 'npm run respaldo' (ver el manual técnico)."
fi

# ---------- Resumen ----------
titulo "Instalación terminada"
echo "  Dirección:  http://localhost:3000"
echo "  Usuario:    nelson"
echo "  Clave:      hola012026   (cambiala el primer día)"
if [[ "${CLAVE_GENERADA:-0}" -eq 1 ]]; then
  echo
  echo "  Clave generada para el usuario postgres: ${C_B}$PG_CLAVE${C_0}"
  echo "  Guardala en un lugar seguro. También queda en el archivo .env (DATABASE_URL_ADMIN)."
fi
if [[ "${SERVICIO:-0}" -ne 1 ]]; then
  echo
  echo "  Para iniciar el sistema: cd \"$RAIZ\" && npm start"
fi
if [[ "${SERVICIO:-0}" -eq 1 ]]; then
  sleep 2
  command -v xdg-open >/dev/null && xdg-open http://localhost:3000 >/dev/null 2>&1 || true
fi
