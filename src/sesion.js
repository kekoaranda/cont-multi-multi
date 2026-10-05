// Inicio de sesión, protección CSRF, mensajes entre páginas y contexto de cada página.
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { alcanza, pool, tx } from './db.js';
import { HttpError, esId, traducirError } from './util.js';

// ----- CSRF: cada formulario lleva un token que tiene que coincidir con el de la sesión -----
export function csrf(req, res, next) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  res.locals.csrf = req.session.csrf;
  // Los formularios con archivos (multipart) llegan sin leer todavía: su ruta llama a verificarCsrf.
  if (req.method === 'POST' && !req.is('multipart/form-data')) verificarCsrf(req);
  next();
}

export function verificarCsrf(req) {
  const enviado = Buffer.from(String(req.body?._csrf ?? ''));
  const esperado = Buffer.from(String(req.session.csrf ?? ''));
  if (!esperado.length || enviado.length !== esperado.length || !crypto.timingSafeEqual(enviado, esperado)) {
    throw new HttpError(403, 'El formulario venció. Volvé a cargar la página e intentá de nuevo.');
  }
}

// ----- Mensajes que sobreviven a una redirección (resultado de la última acción) -----
export function mensajes(req, res, next) {
  const f = req.session.mensaje;
  if (f) {
    Object.assign(res.locals, f);
    delete req.session.mensaje;
  }
  next();
}

export function avisar(req, datos) {
  req.session.mensaje = { ...(req.session.mensaje ?? {}), ...datos };
}

/**
 * Patrón de las acciones de formulario (POST): ejecutar, avisar el resultado y volver a una página.
 * Los errores conocidos se muestran como mensaje; los desconocidos siguen al manejador general.
 */
export async function accion(req, res, destino, exito, fn, datosFormulario) {
  try {
    await fn();
    if (exito) avisar(req, { ok: exito });
  } catch (err) {
    const p = traducirError(err);
    if (!p) throw err;
    avisar(req, { error: p.mensaje, detalles: p.detalles, form: datosFormulario });
  }
  res.redirect(destino);
}

// ----- Usuario actual -----

/** Exige sesión iniciada y relee el usuario: si lo desactivan, pierde el acceso al instante. */
export async function requiereSesion(req, res, next) {
  if (!req.session.usuarioId) return res.redirect('/login');
  const { rows } = await pool.query(
    'SELECT id, nombre, usuario, email, es_admin FROM usuarios WHERE id = $1 AND activo',
    [req.session.usuarioId],
  );
  if (!rows[0]) {
    req.session.destroy(() => res.redirect('/login?desactivado'));
    return;
  }
  const u = rows[0];
  req.usuario = { id: u.id, nombre: u.nombre, usuario: u.usuario, email: u.email, esAdmin: u.es_admin };
  next();
}

// ----- Contexto de página: empresas accesibles, empresa activa y rol -----

export async function empresasDe(usuario) {
  const { rows } = await tx(usuario.id, (c) => c.query(
    `SELECT e.id, e.ruc, e.dv, e.razon_social, e.regimen::text AS regimen,
            COALESCE(ue.rol::text, 'supervisor') AS rol
       FROM empresas e
       LEFT JOIN usuario_empresa ue ON ue.empresa_id = e.id AND ue.usuario_id = $1
      WHERE e.activa
      ORDER BY e.razon_social`,
    [usuario.id],
  ));
  return rows;
}

function armarContexto(usuario, empresa, empresas) {
  return {
    usuario,
    empresa,
    rol: empresa?.rol ?? null,
    empresas,
    puede: (minimo) => !!empresa && alcanza(empresa.rol, minimo),
  };
}

/** Para las rutas /empresas/:empresaId/...: verifica el acceso y recuerda la empresa. */
export async function contextoEmpresa(req, res, next) {
  const id = req.params.empresaId;
  if (!esId(id)) throw new HttpError(404, 'Empresa no encontrada.');
  const empresas = await empresasDe(req.usuario);
  const empresa = empresas.find((e) => String(e.id) === id);
  if (!empresa) throw new HttpError(404, 'Empresa no encontrada o sin acceso.');
  req.session.empresaId = id;
  req.empresaId = id;
  res.locals.ctx = armarContexto(req.usuario, empresa, empresas);
  next();
}

/** Para las páginas de administración, sin empresa activa. */
export async function contextoGeneral(req, res, next) {
  res.locals.ctx = armarContexto(req.usuario, null, await empresasDe(req.usuario));
  next();
}

// ----- Rutas de inicio y cierre de sesión -----

// Se compara contra este hash cuando el email no existe, para no revelar qué emails están registrados.
const HASH_FALSO = bcrypt.hashSync('clave-inexistente', 12);

export const rutasSesion = Router();

rutasSesion.get('/login', (req, res) => {
  if (req.session.usuarioId) return res.redirect('/');
  res.render('login', {
    usuario: '',
    error: 'error' in req.query,
    salio: 'salio' in req.query,
    desactivado: 'desactivado' in req.query,
  });
});

rutasSesion.post('/login', async (req, res) => {
  // Se puede entrar con el nombre de usuario o con el email.
  const usuario = String(req.body.usuario ?? '').trim().toLowerCase();
  const clave = String(req.body.clave ?? '');
  const { rows } = await pool.query(
    'SELECT id, hash_clave, activo FROM usuarios WHERE usuario = $1 OR email = $1',
    [usuario],
  );
  const u = rows[0];
  const ok = await bcrypt.compare(clave, u ? u.hash_clave : HASH_FALSO);
  if (!u || !u.activo || !ok) {
    return res.status(401).render('login', { usuario, error: true, salio: false, desactivado: false });
  }
  // Sesión nueva al iniciar: evita que alguien fije de antemano el identificador de sesión.
  await new Promise((resolve, reject) => req.session.regenerate((e) => (e ? reject(e) : resolve())));
  req.session.usuarioId = String(u.id);
  res.redirect('/');
});

rutasSesion.post('/salir', (req, res) => {
  req.session.destroy(() => res.redirect('/login?salio'));
});
