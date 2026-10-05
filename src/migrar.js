// Aplica en orden las migraciones de la carpeta migraciones/ que todavía no se ejecutaron,
// y deja lista la clave del rol contable_app.
// Se conecta con DATABASE_URL_ADMIN (dueño de la base), no con el rol de la aplicación.
import fs from 'node:fs/promises';
import pg from 'pg';

const url = process.env.DATABASE_URL_ADMIN;
if (!url) {
  console.error('Falta DATABASE_URL_ADMIN en el archivo .env');
  process.exit(1);
}

const dir = new URL('../migraciones/', import.meta.url);
const c = new pg.Client({ connectionString: url });
await c.connect();

try {
  await c.query(`CREATE TABLE IF NOT EXISTS migraciones (
    nombre text PRIMARY KEY, aplicada_en timestamptz NOT NULL DEFAULT now())`);
  const { rows } = await c.query('SELECT nombre FROM migraciones');
  const aplicadas = new Set(rows.map((r) => r.nombre));
  const archivos = (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

  for (const archivo of archivos) {
    if (aplicadas.has(archivo)) continue;
    process.stdout.write(`Aplicando ${archivo}... `);
    const sql = await fs.readFile(new URL(archivo, dir), 'utf8');
    try {
      await c.query('BEGIN');
      await c.query(sql);
      await c.query('INSERT INTO migraciones (nombre) VALUES ($1)', [archivo]);
      await c.query('COMMIT');
      console.log('listo');
    } catch (err) {
      await c.query('ROLLBACK');
      console.log('ERROR');
      console.error(err.message);
      process.exit(1);
    }
  }

  const clave = process.env.DB_APP_PASSWORD;
  if (clave) {
    // format(%L) escapa la clave correctamente para usarla dentro del comando.
    const { rows: r } = await c.query("SELECT format('ALTER ROLE contable_app LOGIN PASSWORD %L', $1::text) AS sql", [clave]);
    await c.query(r[0].sql);
    console.log('Clave del rol contable_app actualizada.');
  } else {
    console.log('Aviso: falta DB_APP_PASSWORD; el rol contable_app no puede iniciar sesión todavía.');
  }
  console.log('Base de datos al día.');
} finally {
  await c.end();
}
