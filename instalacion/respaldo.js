// Copia de seguridad de la base de Partida, igual en Windows, Linux y macOS.
//
//   npm run respaldo                  → crea respaldos/contable-AAAA-MM-DD-HHMM.dump
//   node instalacion/respaldo.js 60   → además borra las copias de más de 60 días (por defecto 30)
//
// Usa pg_dump en formato comprimido. Para restaurar, ver el manual técnico (pg_restore).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const RAIZ = path.resolve(import.meta.dirname, '..');
const CARPETA = process.env.RESPALDO_CARPETA || path.join(RAIZ, 'respaldos');
const DIAS = Number(process.argv[2] || process.env.RESPALDO_DIAS || 30);

function leerEnv() {
  const archivo = path.join(RAIZ, '.env');
  if (!fs.existsSync(archivo)) throw new Error(`No existe ${archivo}`);
  const valores = {};
  for (const linea of fs.readFileSync(archivo, 'utf8').split(/\r?\n/)) {
    const m = linea.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) valores[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return valores;
}

/** Busca pg_dump en el PATH y, si no está, en las carpetas habituales de cada sistema. */
function buscarPgDump() {
  const nombre = process.platform === 'win32' ? 'pg_dump.exe' : 'pg_dump';
  const prueba = spawnSync(nombre, ['--version'], { encoding: 'utf8' });
  if (prueba.status === 0) return nombre;
  const bases = process.platform === 'win32'
    ? ['C:\\Program Files\\PostgreSQL']
    : ['/usr/lib/postgresql', '/opt/homebrew/opt', '/usr/local/opt', '/usr/pgsql-17', '/usr/pgsql-16'];
  const candidatos = [];
  for (const base of bases) {
    if (!fs.existsSync(base)) continue;
    for (const sub of fs.readdirSync(base)) {
      const ruta = path.join(base, sub, 'bin', nombre);
      if (fs.existsSync(ruta)) candidatos.push(ruta);
    }
    const directa = path.join(base, 'bin', nombre);
    if (fs.existsSync(directa)) candidatos.push(directa);
  }
  // La versión más nueva primero: pg_dump tiene que ser igual o más nuevo que el servidor
  candidatos.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  if (!candidatos.length) throw new Error('No se encontró pg_dump. Instalá las herramientas de PostgreSQL o agregalas al PATH.');
  return candidatos[0];
}

const ahora = new Date();
const marca = `${ahora.getFullYear()}-${String(ahora.getMonth() + 1).padStart(2, '0')}-${String(ahora.getDate()).padStart(2, '0')}-${String(ahora.getHours()).padStart(2, '0')}${String(ahora.getMinutes()).padStart(2, '0')}`;

try {
  const env = leerEnv();
  if (!env.DATABASE_URL_ADMIN) throw new Error('Falta DATABASE_URL_ADMIN en el .env');
  const url = new URL(env.DATABASE_URL_ADMIN);
  const base = url.pathname.replace(/^\//, '') || 'contable';
  fs.mkdirSync(CARPETA, { recursive: true });
  const archivo = path.join(CARPETA, `${base}-${marca}.dump`);

  const r = spawnSync(buscarPgDump(), [
    '-h', url.hostname, '-p', url.port || '5432', '-U', decodeURIComponent(url.username),
    '-d', base, '-Fc', '-f', archivo,
  ], { env: { ...process.env, PGPASSWORD: decodeURIComponent(url.password) }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`pg_dump falló: ${(r.stderr || r.error?.message || '').trim()}`);

  const kb = Math.round(fs.statSync(archivo).size / 1024);
  console.log(`${ahora.toISOString()} Copia creada: ${archivo} (${kb} KB)`);

  // Borrar copias viejas
  if (DIAS > 0) {
    const limite = Date.now() - DIAS * 864e5;
    for (const f of fs.readdirSync(CARPETA)) {
      if (!f.endsWith('.dump')) continue;
      const ruta = path.join(CARPETA, f);
      if (fs.statSync(ruta).mtimeMs < limite) {
        fs.unlinkSync(ruta);
        console.log(`Copia vieja borrada: ${f}`);
      }
    }
  }
} catch (err) {
  console.error(`${ahora.toISOString()} ERROR en la copia de seguridad: ${err.message}`);
  process.exit(1);
}
