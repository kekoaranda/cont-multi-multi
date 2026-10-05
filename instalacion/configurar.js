// Configuración inicial de Partida, igual en Windows, Linux y macOS.
// Crea la base de datos, el archivo .env, las tablas y el usuario administrador.
//
// La llaman los instaladores (instalar.sh / instalar.ps1), pero también se puede usar sola:
//   node instalacion/configurar.js
// Sin preguntas (toma todo de variables de entorno): node instalacion/configurar.js --si
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import bcrypt from 'bcryptjs';
import pg from 'pg';

const RAIZ = path.resolve(import.meta.dirname, '..');
const ARCHIVO_ENV = path.join(RAIZ, '.env');
const SIN_PREGUNTAS = process.argv.includes('--si');

// Valores por defecto. Cualquiera se puede cambiar con la variable de entorno indicada.
const CFG = {
  host: process.env.PG_HOST || 'localhost',
  puerto: process.env.PG_PUERTO || '5432',
  superusuario: process.env.PG_SUPERUSUARIO || 'postgres',
  superclave: process.env.PG_SUPERCLAVE || '',
  base: process.env.PG_BASE || 'contable',
  estudioNombre: process.env.ESTUDIO_NOMBRE || '',
  adminUsuario: (process.env.ADMIN_USUARIO || 'nelson').toLowerCase(),
  adminNombre: process.env.ADMIN_NOMBRE || 'Nelson',
  adminEmail: process.env.ADMIN_EMAIL || 'nelson@estudio.local',
  adminClave: process.env.ADMIN_CLAVE || 'hola012026',
  puertoWeb: process.env.PUERTO_WEB || '3000',
  crearEjemplo: process.env.CREAR_EJEMPLO, // "si" / "no"; vacío = preguntar
};

// ----- consola -----
const color = (c, t) => (process.stdout.isTTY ? `\x1b[${c}m${t}\x1b[0m` : t);
const titulo = (t) => console.log(`\n${color('1;36', `== ${t} ==`)}`);
const ok = (t) => console.log(`  ${color('32', 'OK')}  ${t}`);
const aviso = (t) => console.log(`  ${color('33', '!')}   ${t}`);
function fallar(t, detalle) {
  console.error(`  ${color('31', 'X')}   ${t}`);
  if (detalle) console.error(`      ${detalle}`);
  process.exit(1);
}

function preguntar(texto, defecto = '') {
  if (SIN_PREGUNTAS) return Promise.resolve(defecto);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(`${texto}${defecto ? ` [${defecto}]` : ''}: `, (r) => {
    rl.close();
    res(r.trim() || defecto);
  }));
}

function preguntarOculto(texto) {
  if (SIN_PREGUNTAS) return Promise.resolve('');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  let silencio = false;
  rl._writeToOutput = (s) => { if (!silencio) process.stdout.write(s); };
  return new Promise((res) => {
    rl.question(`${texto}: `, (r) => {
      rl.close();
      process.stdout.write('\n');
      res(r);
    });
    silencio = true; // lo que se escribe desde acá no se muestra
  });
}

async function preguntarSiNo(texto, defecto) {
  const r = await preguntar(`${texto} (s/n)`, defecto ? 's' : 'n');
  return /^[sy]/i.test(r);
}

const url = (usuario, clave, base) =>
  `postgres://${encodeURIComponent(usuario)}:${encodeURIComponent(clave)}@${CFG.host}:${CFG.puerto}/${base}`;

function leerEnv() {
  const valores = {};
  for (const linea of fs.readFileSync(ARCHIVO_ENV, 'utf8').split(/\r?\n/)) {
    const m = linea.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) valores[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return valores;
}

// ----- pasos -----

function verificarNode() {
  const [may, men] = process.versions.node.split('.').map(Number);
  if (may < 20 || (may === 20 && men < 11)) {
    fallar(`Se necesita Node.js 20.11 o superior; esta computadora tiene ${process.versions.node}.`);
  }
  ok(`Node.js ${process.versions.node}`);
}

async function conectarServidor() {
  for (let intento = 1; intento <= 3; intento++) {
    if (!CFG.superclave) {
      CFG.superclave = await preguntarOculto(`Clave del usuario "${CFG.superusuario}" de PostgreSQL`);
    }
    const c = new pg.Client({
      host: CFG.host, port: Number(CFG.puerto), user: CFG.superusuario, password: CFG.superclave, database: 'postgres',
    });
    try {
      await c.connect();
      return c;
    } catch (err) {
      if (err.code === '28P01') {
        aviso('La clave no es correcta.');
        CFG.superclave = '';
        if (SIN_PREGUNTAS) break;
        continue;
      }
      if (err.code === 'ECONNREFUSED') {
        fallar(`PostgreSQL no responde en ${CFG.host}:${CFG.puerto}.`, '¿Está instalado y en ejecución? En Linux: sudo systemctl start postgresql');
      }
      fallar('No se pudo conectar a PostgreSQL.', err.message);
    }
  }
  fallar(`No se pudo entrar a PostgreSQL con el usuario "${CFG.superusuario}".`);
}

async function crearBase(c) {
  const { rows: v } = await c.query("SELECT current_setting('server_version_num')::int AS n, current_setting('server_version') AS t");
  if (v[0].n < 150000) fallar(`Se necesita PostgreSQL 15 o superior; el servidor tiene ${v[0].t}.`);
  ok(`PostgreSQL ${v[0].t}`);
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(CFG.base)) fallar(`Nombre de base inválido: "${CFG.base}"`);
  const { rows } = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [CFG.base]);
  if (rows.length) {
    ok(`La base "${CFG.base}" ya existe: se usa la existente`);
  } else {
    await c.query(`CREATE DATABASE "${CFG.base}" ENCODING 'UTF8' TEMPLATE template0`);
    ok(`Base "${CFG.base}" creada`);
  }
}

async function prepararEnv() {
  if (fs.existsSync(ARCHIVO_ENV)) {
    const actual = leerEnv();
    const reemplazar = await preguntarSiNo('Ya existe un archivo .env. ¿Generarlo de nuevo? (se guarda una copia del actual)', false);
    if (!reemplazar) {
      ok('Se conserva el .env actual');
      return actual;
    }
    const copia = `${ARCHIVO_ENV}.copia-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
    fs.copyFileSync(ARCHIVO_ENV, copia);
    ok(`Copia del .env anterior: ${path.basename(copia)}`);
  }
  const claveApp = crypto.randomBytes(24).toString('base64url');
  const valores = {
    DATABASE_URL_ADMIN: url(CFG.superusuario, CFG.superclave, CFG.base),
    DB_APP_PASSWORD: claveApp,
    DATABASE_URL: url('contable_app', claveApp, CFG.base),
    SESSION_SECRET: crypto.randomBytes(48).toString('hex'),
    PORT: CFG.puertoWeb,
    COOKIE_SEGURA: 'false',
  };
  const contenido = `# Generado por instalacion/configurar.js el ${new Date().toLocaleString('es-PY')}.
# Contiene claves: no lo compartas ni lo subas a Git.

# Dueño de la base: lo usa "npm run migrar" para crear y actualizar las tablas
DATABASE_URL_ADMIN=${valores.DATABASE_URL_ADMIN}

# Usuario con el que trabaja la aplicación (sin permisos para saltarse la separación entre empresas)
DB_APP_PASSWORD=${valores.DB_APP_PASSWORD}
DATABASE_URL=${valores.DATABASE_URL}

# Firma de las sesiones de los usuarios
SESSION_SECRET=${valores.SESSION_SECRET}

# Puerto web. COOKIE_SEGURA=true solo cuando el sistema se sirve por HTTPS
PORT=${valores.PORT}
COOKIE_SEGURA=${valores.COOKIE_SEGURA}
`;
  fs.writeFileSync(ARCHIVO_ENV, contenido, { mode: 0o600 });
  ok('Archivo .env creado con claves generadas al azar');
  return valores;
}

function migrar() {
  const r = spawnSync(process.execPath, ['--env-file=.env', 'src/migrar.js'], { cwd: RAIZ, stdio: 'inherit' });
  if (r.status !== 0) fallar('Las migraciones no terminaron bien. Revisá el mensaje de arriba.');
}

async function crearAdmin(env) {
  if (!/^[a-z0-9._-]{3,30}$/.test(CFG.adminUsuario)) fallar(`Nombre de usuario inválido: "${CFG.adminUsuario}"`);
  if (CFG.adminClave.length < 10) fallar('La clave del administrador necesita al menos 10 caracteres.');
  const c = new pg.Client({ connectionString: env.DATABASE_URL_ADMIN });
  await c.connect();
  try {
    const { rows } = await c.query('SELECT id FROM usuarios WHERE usuario = $1', [CFG.adminUsuario]);
    if (rows.length) {
      ok(`El usuario "${CFG.adminUsuario}" ya existe: no se modificó su clave`);
    } else {
      // Va al único estudio de la instalación. El primer administrador también administra la plataforma
      // (solo tiene efecto si después se activa MULTI_ESTUDIO para atender a varios estudios).
      await c.query(
        `INSERT INTO usuarios (usuario, email, nombre, hash_clave, es_admin, es_superadmin)
         VALUES ($1, $2, $3, $4, true, NOT EXISTS (SELECT 1 FROM usuarios WHERE es_superadmin))`,
        [CFG.adminUsuario, CFG.adminEmail, CFG.adminNombre, await bcrypt.hash(CFG.adminClave, 12)],
      );
      ok(`Usuario administrador "${CFG.adminUsuario}" creado`);
    }

    if (CFG.estudioNombre.trim()) {
      await c.query('UPDATE estudios SET nombre = $1 WHERE id = (SELECT min(id) FROM estudios)', [CFG.estudioNombre.trim()]);
      ok(`Nombre del estudio: ${CFG.estudioNombre.trim()}`);
    }

    const ejemplo = CFG.crearEjemplo
      ? /^s/i.test(CFG.crearEjemplo)
      : await preguntarSiNo('¿Crear una empresa de ejemplo para probar el sistema?', true);
    if (ejemplo) {
      const anio = new Date().getFullYear();
      const { rows: e } = await c.query(
        `INSERT INTO empresas (ruc, dv, razon_social, regimen, contador_resp)
         VALUES ('80045123', 6, 'Empresa de ejemplo S.A.', 'IRE_GENERAL', (SELECT id FROM usuarios WHERE usuario = $1))
         ON CONFLICT DO NOTHING RETURNING id`,
        [CFG.adminUsuario],
      );
      if (!e.length) {
        ok('La empresa de ejemplo ya existía');
      } else {
        const id = e[0].id;
        await c.query('SELECT fn_copiar_plantilla($1)', [id]);
        await c.query('SELECT fn_copiar_plantillas($1)', [id]);
        const { rows: ej } = await c.query(
          `INSERT INTO ejercicios (empresa_id, anio, fecha_desde, fecha_hasta)
           VALUES ($1, $2::int, make_date($2::int, 1, 1), make_date($2::int, 12, 31)) RETURNING id`,
          [id, anio],
        );
        await c.query(
          `INSERT INTO periodos (empresa_id, ejercicio_id, mes)
           SELECT $1, $2, gs::date FROM generate_series(make_date($3::int, 1, 1), make_date($3::int, 12, 1), interval '1 month') gs`,
          [id, ej[0].id, anio],
        );
        ok(`Empresa de ejemplo creada (RUC 80045123-6, ejercicio ${anio}). Sirve para probar con los XML de test/xml`);
      }
    }
  } finally {
    await c.end();
  }
}

// ----- programa -----

console.log(color('1', '\nPartida: configuración inicial'));
titulo('1. Requisitos');
verificarNode();
if (!fs.existsSync(path.join(RAIZ, 'node_modules', 'pg'))) {
  fallar('Faltan las dependencias.', `Ejecutá primero "npm install" en ${RAIZ}`);
}

titulo('2. Base de datos');
const servidor = await conectarServidor();
try {
  await crearBase(servidor);
} finally {
  await servidor.end();
}

titulo('3. Configuración (.env)');
const env = await prepararEnv();

titulo('4. Tablas');
migrar();

titulo('5. Usuario administrador');
await crearAdmin(env);

const puerto = env.PORT || CFG.puertoWeb;
console.log(`
${color('1;32', 'Listo. Partida quedó configurado.')}

  Dirección:  http://localhost:${puerto}
  Usuario:    ${CFG.adminUsuario}
  Clave:      ${CFG.adminClave}

  Cambiá la clave el primer día: Estudio → Usuarios → Editar.
  Para iniciar el sistema a mano: npm start (desde ${RAIZ})
`);
