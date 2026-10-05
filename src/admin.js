// Administración del estudio: empresas clientes, usuarios y accesos por empresa.
import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { ROLES, enEmpresa, exigirAdmin, tx } from './db.js';
import { crearEjercicio } from './periodos.js';
import { accion, contextoGeneral } from './sesion.js';
import { HttpError, dvRuc, esId } from './util.js';

export const REGIMENES = ['IRE_GENERAL', 'IRE_SIMPLE', 'IRE_RESIMPLE', 'IRP', 'OTRO'];

// ----- Empresas -----

/** Valida los datos del formulario de empresa (alta y edición). */
function validarEmpresa(datos) {
  const [base, dvEscrito] = String(datos.ruc ?? '').trim().split('-');
  const ruc = (base ?? '').replace(/\D/g, '');
  if (ruc.length < 3 || ruc.length > 10) throw new HttpError(422, 'Ingresá un RUC válido (entre 3 y 10 dígitos).');
  const dv = dvRuc(ruc);
  if (dvEscrito !== undefined && dvEscrito.trim() !== '' && Number(dvEscrito) !== dv) {
    throw new HttpError(422, `El dígito verificador no coincide: para ${ruc} corresponde ${dv}.`);
  }
  const razon = String(datos.razonSocial ?? '').trim();
  if (!razon) throw new HttpError(422, 'Ingresá la razón social.');
  if (razon.length > 200) throw new HttpError(422, 'La razón social admite hasta 200 caracteres.');
  if (!REGIMENES.includes(datos.regimen)) throw new HttpError(422, 'Elegí un régimen válido.');
  const fantasia = String(datos.nombreFantasia ?? '').trim() || null;
  return { ruc, dv, razon, fantasia, regimen: datos.regimen };
}

const datosEmpresa = (body) => ({
  ruc: body.ruc ?? '', razonSocial: body.razonSocial ?? '', nombreFantasia: body.nombreFantasia ?? '',
  regimen: body.regimen ?? '', anioInicial: body.anioInicial ?? '',
});

/** Alta de empresa: copia el plan de cuentas base y crea el ejercicio con sus 12 meses. */
async function crearEmpresa(c, usuarioId, datos) {
  const { ruc, dv, razon, fantasia } = validarEmpresa(datos);
  const anio = Number(datos.anioInicial);
  const { rows } = await c.query(
    `INSERT INTO empresas (ruc, dv, razon_social, nombre_fantasia, regimen, contador_resp)
     VALUES ($1, $2, $3, $4, $5::regimen_tributario, $6) RETURNING id`,
    [ruc, dv, razon, fantasia, datos.regimen, usuarioId],
  );
  await c.query('SELECT fn_copiar_plantilla($1)', [rows[0].id]);
  await c.query('SELECT fn_copiar_plantillas($1)', [rows[0].id]);
  await crearEjercicio(c, rows[0].id, anio);
}

export const rutasAdmin = Router();
rutasAdmin.use((req, res, next) => {
  exigirAdmin(req.usuario);
  next();
});
rutasAdmin.use(contextoGeneral);

rutasAdmin.get('/empresas', async (req, res) => {
  const { rows } = await tx(req.usuario.id, (c) => c.query(
    'SELECT id, ruc, dv, razon_social, regimen::text AS regimen, activa FROM empresas ORDER BY razon_social',
  ));
  const form = res.locals.form ?? { ruc: '', razonSocial: '', nombreFantasia: '', regimen: 'IRE_GENERAL', anioInicial: new Date().getFullYear() };
  res.render('admin-empresas', { empresas: rows, regimenes: REGIMENES, form });
});

rutasAdmin.post('/empresas', (req, res) => {
  const datos = datosEmpresa(req.body);
  return accion(req, res, '/admin/empresas', 'Empresa agregada con su plan de cuentas base y su ejercicio.',
    () => tx(req.usuario.id, (c) => crearEmpresa(c, req.usuario.id, datos)), datos);
});

rutasAdmin.get('/empresas/:id/editar', async (req, res) => {
  if (!esId(req.params.id)) throw new HttpError(404, 'Empresa no encontrada.');
  const { rows } = await tx(req.usuario.id, (c) => c.query(
    'SELECT id, ruc, dv, razon_social, nombre_fantasia, regimen::text AS regimen, activa FROM empresas WHERE id = $1',
    [req.params.id],
  ));
  const e = rows[0];
  if (!e) throw new HttpError(404, 'Empresa no encontrada.');
  // Si volvemos de un error, el formulario trae lo que se había escrito.
  const form = res.locals.form ?? { ruc: `${e.ruc}-${e.dv}`, razonSocial: e.razon_social, nombreFantasia: e.nombre_fantasia ?? '', regimen: e.regimen };
  res.render('admin-empresa-editar', { empresa: e, form, regimenes: REGIMENES });
});

rutasAdmin.post('/empresas/:id', (req, res) => {
  const datos = datosEmpresa(req.body);
  const id = req.params.id;
  return accion(req, res, `/admin/empresas/${esId(id) ? id + '/editar' : ''}`, 'Datos de la empresa actualizados.', async () => {
    if (!esId(id)) throw new HttpError(404, 'Empresa no encontrada.');
    const { ruc, dv, razon, fantasia, regimen } = validarEmpresa(datos);
    await tx(req.usuario.id, async (c) => {
      const r = await c.query(
        `UPDATE empresas SET ruc = $2, dv = $3, razon_social = $4, nombre_fantasia = $5, regimen = $6::regimen_tributario
          WHERE id = $1`,
        [id, ruc, dv, razon, fantasia, regimen],
      );
      if (!r.rowCount) throw new HttpError(404, 'Empresa no encontrada.');
    });
  }, datos);
});

rutasAdmin.post('/empresas/:id/activa', (req, res) => {
  const activa = req.body.valor === 'true';
  return accion(req, res, '/admin/empresas', activa ? 'Empresa reactivada.' : 'Empresa archivada.', async () => {
    if (!esId(req.params.id)) throw new HttpError(404, 'Empresa no encontrada.');
    await tx(req.usuario.id, (c) => c.query('UPDATE empresas SET activa = $2 WHERE id = $1', [req.params.id, activa]));
  });
});

// ----- Usuarios -----

async function listarUsuarios(usuarioId) {
  const { rows } = await tx(usuarioId, (c) => c.query('SELECT id, usuario, email, nombre, es_admin, activo FROM usuarios ORDER BY nombre'));
  return rows;
}

rutasAdmin.get('/usuarios', async (req, res) => {
  const form = res.locals.form ?? { nombre: '', usuario: '', email: '', esAdmin: '' };
  res.render('admin-usuarios', { usuarios: await listarUsuarios(req.usuario.id), form });
});

const datosUsuario = (body) => ({
  nombre: String(body.nombre ?? '').trim(),
  usuario: String(body.usuario ?? '').trim().toLowerCase(),
  email: String(body.email ?? '').trim(),
  esAdmin: body.esAdmin ?? '',
});

function validarUsuario(datos) {
  if (!/^[a-z0-9._-]{3,30}$/.test(datos.usuario)) {
    throw new HttpError(422, 'El nombre de usuario va en minúsculas, sin espacios ni acentos, entre 3 y 30 caracteres (por ejemplo "nelson" o "maria.lopez").');
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(datos.email)) throw new HttpError(422, 'Ingresá un email válido.');
  if (!datos.nombre) throw new HttpError(422, 'Ingresá el nombre.');
}

rutasAdmin.post('/usuarios', (req, res) => {
  const datos = datosUsuario(req.body);
  const clave = String(req.body.clave ?? '');
  // La clave nunca vuelve al navegador: no se incluye en los datos del formulario.
  return accion(req, res, '/admin/usuarios', 'Usuario creado. Ahora asignale empresas desde Accesos.', async () => {
    validarUsuario(datos);
    if (clave.length < 10) throw new HttpError(422, 'La clave debe tener al menos 10 caracteres.');
    const hash = await bcrypt.hash(clave, 12);
    await tx(req.usuario.id, (c) => c.query(
      'INSERT INTO usuarios (usuario, email, nombre, hash_clave, es_admin) VALUES ($1, $2, $3, $4, $5)',
      [datos.usuario, datos.email, datos.nombre, hash, datos.esAdmin === 'on'],
    ));
  }, datos);
});

rutasAdmin.get('/usuarios/:id/editar', async (req, res) => {
  if (!esId(req.params.id)) throw new HttpError(404, 'Usuario no encontrado.');
  const { rows } = await tx(req.usuario.id, (c) => c.query(
    'SELECT id, usuario, email, nombre, es_admin, activo FROM usuarios WHERE id = $1', [req.params.id],
  ));
  const u = rows[0];
  if (!u) throw new HttpError(404, 'Usuario no encontrado.');
  const form = res.locals.form ?? { nombre: u.nombre, usuario: u.usuario, email: u.email, esAdmin: u.es_admin ? 'on' : '' };
  res.render('admin-usuario-editar', { editado: u, form, esUnoMismo: String(u.id) === String(req.usuario.id) });
});

rutasAdmin.post('/usuarios/:id', (req, res) => {
  const datos = datosUsuario(req.body);
  const clave = String(req.body.clave ?? '');
  const id = req.params.id;
  return accion(req, res, `/admin/usuarios/${esId(id) ? id + '/editar' : ''}`, 'Datos del usuario actualizados.', async () => {
    if (!esId(id)) throw new HttpError(404, 'Usuario no encontrado.');
    validarUsuario(datos);
    const esUnoMismo = String(id) === String(req.usuario.id);
    if (esUnoMismo && datos.esAdmin !== 'on') throw new HttpError(422, 'No podés quitarte a vos mismo el rol de administrador.');
    if (clave && clave.length < 10) throw new HttpError(422, 'La clave nueva debe tener al menos 10 caracteres.');
    const hash = clave ? await bcrypt.hash(clave, 12) : null;
    await tx(req.usuario.id, async (c) => {
      const r = await c.query(
        `UPDATE usuarios SET nombre = $2, usuario = $3, email = $4, es_admin = $5,
                hash_clave = COALESCE($6, hash_clave)
          WHERE id = $1`,
        [id, datos.nombre, datos.usuario, datos.email, datos.esAdmin === 'on', hash],
      );
      if (!r.rowCount) throw new HttpError(404, 'Usuario no encontrado.');
    });
  }, datos);
});

rutasAdmin.post('/usuarios/:id/activo', (req, res) => {
  const activo = req.body.valor === 'true';
  return accion(req, res, '/admin/usuarios', activo ? 'Usuario activado.' : 'Usuario desactivado.', async () => {
    if (!esId(req.params.id)) throw new HttpError(404, 'Usuario no encontrado.');
    if (String(req.params.id) === String(req.usuario.id) && !activo) throw new HttpError(422, 'No podés desactivar tu propio usuario.');
    await tx(req.usuario.id, (c) => c.query('UPDATE usuarios SET activo = $2 WHERE id = $1', [req.params.id, activo]));
  });
});

rutasAdmin.post('/usuarios/:id/clave', (req, res) => accion(req, res, '/admin/usuarios', 'Clave actualizada.', async () => {
  const clave = String(req.body.clave ?? '');
  if (!esId(req.params.id)) throw new HttpError(404, 'Usuario no encontrado.');
  if (clave.length < 10) throw new HttpError(422, 'La clave debe tener al menos 10 caracteres.');
  const hash = await bcrypt.hash(clave, 12);
  await tx(req.usuario.id, (c) => c.query('UPDATE usuarios SET hash_clave = $2 WHERE id = $1', [req.params.id, hash]));
}));

// ----- Accesos por empresa (montado en /empresas/:empresaId/accesos) -----

export const rutasAccesos = Router({ mergeParams: true });

rutasAccesos.get('/', async (req, res) => {
  if (!res.locals.ctx.puede('supervisor')) throw new HttpError(403, 'Solo el supervisor de la empresa ve quién tiene acceso.');
  const accesos = await enEmpresa(req.usuario, req.empresaId, 'supervisor', async (c) => (await c.query(
    `SELECT u.id, u.nombre, u.email, ue.rol::text AS rol
       FROM usuario_empresa ue JOIN usuarios u ON u.id = ue.usuario_id
      WHERE ue.empresa_id = $1 ORDER BY u.nombre`,
    [req.empresaId],
  )).rows);
  const usuarios = req.usuario.esAdmin ? await listarUsuarios(req.usuario.id) : [];
  res.render('accesos', { accesos, usuarios, roles: ROLES });
});

rutasAccesos.post('/', (req, res) => accion(req, res, `/empresas/${req.empresaId}/accesos`, 'Acceso guardado.', async () => {
  exigirAdmin(req.usuario);
  if (!esId(req.body.usuarioId)) throw new HttpError(422, 'Elegí un usuario.');
  if (!ROLES.includes(req.body.rol)) throw new HttpError(422, 'Elegí un rol válido.');
  await tx(req.usuario.id, (c) => c.query(
    `INSERT INTO usuario_empresa (usuario_id, empresa_id, rol) VALUES ($1, $2, $3::rol_empresa)
     ON CONFLICT (usuario_id, empresa_id) DO UPDATE SET rol = EXCLUDED.rol`,
    [req.body.usuarioId, req.empresaId, req.body.rol],
  ));
}));

rutasAccesos.post('/:usuarioId/quitar', (req, res) => accion(req, res, `/empresas/${req.empresaId}/accesos`, 'Acceso quitado.', async () => {
  exigirAdmin(req.usuario);
  if (!esId(req.params.usuarioId)) throw new HttpError(404, 'Usuario no encontrado.');
  await tx(req.usuario.id, (c) => c.query('DELETE FROM usuario_empresa WHERE usuario_id = $1 AND empresa_id = $2', [req.params.usuarioId, req.empresaId]));
}));
