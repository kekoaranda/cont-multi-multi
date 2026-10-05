// Plataforma: alta y baja de estudios contables cuando la instalación atiende a varios (MULTI_ESTUDIO=true).
// La usa solo el administrador de la plataforma. No da acceso a la contabilidad de los estudios:
// solo ve su nombre y cuántas empresas y usuarios tienen.
import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { tx } from './db.js';
import { validarEstudio, validarUsuario } from './admin.js';
import { accion, contextoGeneral } from './sesion.js';
import { HttpError, esId } from './util.js';

const rutas = Router();
export default rutas;

rutas.use((req, res, next) => {
  if (!req.usuario.esSuperadmin) throw new HttpError(403, 'Solo el administrador de la plataforma puede hacer esto.');
  next();
});
rutas.use(contextoGeneral);

const datosEstudio = (body) => ({
  nombre: String(body.nombre ?? '').trim(),
  ruc: String(body.ruc ?? '').trim(),
  adminNombre: String(body.adminNombre ?? '').trim(),
  adminUsuario: String(body.adminUsuario ?? '').trim().toLowerCase(),
  adminEmail: String(body.adminEmail ?? '').trim(),
});

rutas.get('/estudios', async (req, res) => {
  const { rows } = await tx(req.usuario.id, (c) => c.query('SELECT * FROM fn_resumen_estudios()'));
  const form = res.locals.form ?? datosEstudio({});
  res.render('plataforma-estudios', { estudios: rows, form });
});

rutas.post('/estudios', (req, res) => {
  const datos = datosEstudio(req.body);
  const clave = String(req.body.adminClave ?? '');
  return accion(req, res, '/plataforma/estudios',
    `Estudio "${datos.nombre}" creado. Su administrador ya puede entrar con el usuario ${datos.adminUsuario}.`, async () => {
      const { nombre, ruc } = validarEstudio(datos);
      validarUsuario({ nombre: datos.adminNombre, usuario: datos.adminUsuario, email: datos.adminEmail });
      if (clave.length < 10) throw new HttpError(422, 'La clave inicial debe tener al menos 10 caracteres.');
      const hash = await bcrypt.hash(clave, 12);
      await tx(req.usuario.id, (c) => c.query(
        'SELECT fn_crear_estudio($1, $2, $3, $4, $5, $6)',
        [nombre, ruc, datos.adminUsuario, datos.adminEmail, datos.adminNombre, hash],
      ));
    }, datos);
});

rutas.post('/estudios/:id/activo', (req, res) => {
  const activo = req.body.valor === 'true';
  return accion(req, res, '/plataforma/estudios', activo ? 'Estudio reactivado.' : 'Estudio desactivado: sus usuarios ya no pueden entrar.', async () => {
    if (!esId(req.params.id)) throw new HttpError(404, 'Estudio no encontrado.');
    await tx(req.usuario.id, async (c) => {
      const r = await c.query('UPDATE estudios SET activo = $2 WHERE id = $1', [req.params.id, activo]);
      if (!r.rowCount) throw new HttpError(404, 'Estudio no encontrado.');
    });
  });
});
