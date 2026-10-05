import pg from 'pg';
import { HttpError } from './util.js';

// Las fechas (tipo date) quedan como texto "AAAA-MM-DD", sin conversiones de zona horaria.
// Los numeric y bigint ya vienen como texto: así no se pierde precisión.
pg.types.setTypeParser(1082, (v) => v);

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 20 });

/**
 * Ejecuta fn dentro de una transacción con el usuario fijado en la sesión de PostgreSQL.
 * La seguridad por fila (RLS) usa app.usuario_id para decidir qué empresas puede ver
 * y modificar. Los triggers diferidos (partida doble) se validan en el COMMIT.
 */
export async function tx(usuarioId, fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.usuario_id', $1, true)", [String(usuarioId)]);
    const resultado = await fn(c);
    await c.query('COMMIT');
    return resultado;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    c.release();
  }
}

// ----- Roles por empresa -----

const NIVEL = { lectura: 1, auxiliar: 2, contador: 3, supervisor: 4 };
export const ROLES = Object.keys(NIVEL);

export function alcanza(rol, minimo) {
  return (NIVEL[rol] ?? 0) >= NIVEL[minimo];
}

export function exigirAdmin(usuario) {
  if (!usuario.esAdmin) throw new HttpError(403, 'Solo un administrador del estudio puede hacer esto.');
}

export async function exigirRol(c, usuario, empresaId, minimo) {
  if (usuario.esAdmin) return 'supervisor';
  const { rows } = await c.query(
    'SELECT rol::text AS rol FROM usuario_empresa WHERE usuario_id = $1 AND empresa_id = $2',
    [usuario.id, empresaId],
  );
  const rol = rows[0]?.rol;
  // Sin asignación respondemos 404: no revelamos que la empresa existe.
  if (!rol) throw new HttpError(404, 'Empresa no encontrada.');
  if (!alcanza(rol, minimo)) {
    throw new HttpError(403, `Tu rol en esta empresa (${rol}) no permite esta acción; se necesita ${minimo}.`);
  }
  return rol;
}

/** Transacción con el usuario fijado y un rol mínimo exigido en la empresa. */
export function enEmpresa(usuario, empresaId, minimo, fn) {
  return tx(usuario.id, async (c) => {
    await exigirRol(c, usuario, empresaId, minimo);
    return fn(c);
  });
}
