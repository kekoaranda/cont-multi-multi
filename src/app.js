// Punto de entrada: configura Express, las sesiones y las rutas, y arranca el servidor.
import path from 'node:path';
import bcrypt from 'bcryptjs';
import connectPgSimple from 'connect-pg-simple';
import express from 'express';
import session from 'express-session';
import { pool } from './db.js';
import { capitalizar, fecha, gs, gsSinCero, mes, sumaIva, traducirError } from './util.js';
import { MULTI_ESTUDIO, contextoEmpresa, csrf, empresasDe, mensajes, requiereSesion, rutasSesion } from './sesion.js';
import rutasDiario from './diario.js';
import rutasPlan from './plan.js';
import rutasPeriodos from './periodos.js';
import rutasReportes from './reportes.js';
import rutasComprobantes from './comprobantes.js';
import rutasCarga from './carga.js';
import rutasPlantillas from './plantillas.js';
import { rutasAdmin, rutasAccesos } from './admin.js';
import rutasPlataforma from './estudios.js';

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  console.error('Falta SESSION_SECRET en el .env (al menos 32 caracteres). Mirá .env.example.');
  process.exit(1);
}

const raiz = path.resolve(import.meta.dirname, '..');
const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(raiz, 'vistas'));
app.set('trust proxy', 1);
app.disable('x-powered-by');

// Funciones de formato disponibles en todas las páginas
Object.assign(app.locals, { gs, gsSinCero, fecha, mes, capitalizar, sumaIva });

app.use(express.static(path.join(raiz, 'publico')));
// extended: permite campos como lineas[0][cuenta]; parameterLimit alcanza para asientos largos
app.use(express.urlencoded({ extended: true, parameterLimit: 5000 }));

const PgStore = connectPgSimple(session);
app.use(session({
  store: new PgStore({ pool, tableName: 'sesiones' }),
  secret: process.env.SESSION_SECRET,
  name: 'contable.sid',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SEGURA === 'true',
    maxAge: 8 * 60 * 60 * 1000,
  },
}));
app.use(csrf);
app.use(mensajes);

app.use(rutasSesion);

// Inicio: la última empresa usada, o la primera disponible
app.get('/', requiereSesion, async (req, res) => {
  const empresas = await empresasDe(req.usuario);
  const ultima = empresas.find((e) => String(e.id) === req.session.empresaId);
  const destino = ultima ?? empresas[0];
  if (destino) return res.redirect(`/empresas/${destino.id}/diario`);
  if (req.usuario.esAdmin) return res.redirect('/admin/empresas');
  if (req.usuario.esSuperadmin) return res.redirect('/plataforma/estudios');
  res.render('sin-empresas', { ctx: { usuario: req.usuario, empresa: null, empresas: [], puede: () => false } });
});

app.get('/cambiar-empresa', requiereSesion, (req, res) => {
  const id = String(req.query.empresaId ?? '');
  res.redirect(/^\d+$/.test(id) ? `/empresas/${id}/diario` : '/');
});

app.use('/admin', requiereSesion, rutasAdmin);
// Alta de estudios: solo existe cuando la instalación atiende a varios estudios (MULTI_ESTUDIO=true)
if (MULTI_ESTUDIO) app.use('/plataforma', requiereSesion, rutasPlataforma);
app.use('/empresas/:empresaId', requiereSesion, contextoEmpresa);
app.use('/empresas/:empresaId/diario', rutasDiario);
app.use('/empresas/:empresaId/plan', rutasPlan);
app.use('/empresas/:empresaId/periodos', rutasPeriodos);
app.use('/empresas/:empresaId/reportes', rutasReportes);
app.use('/empresas/:empresaId/comprobantes', rutasComprobantes);
app.use('/empresas/:empresaId/carga', rutasCarga);
app.use('/empresas/:empresaId/plantillas', rutasPlantillas);
app.use('/empresas/:empresaId/accesos', rutasAccesos);

// Página inexistente
app.use((req, res) => {
  res.status(404).render('error', { mensaje: 'La página que buscás no existe.', detalles: null });
});

// Errores: los conocidos se muestran con su mensaje; los demás se registran en la consola
app.use((err, req, res, next) => {
  const p = traducirError(err);
  if (!p) console.error(err);
  if (res.headersSent) return next(err);
  res.status(p?.status ?? 500).render('error', {
    mensaje: p?.mensaje ?? 'Ocurrió un error interno. Quedó registrado en la consola del servidor.',
    detalles: p?.detalles ?? null,
  });
});

// Primer administrador: solo si la tabla de usuarios está vacía
async function crearAdminInicial() {
  const { rows } = await pool.query('SELECT fn_hay_usuarios() AS hay');
  if (rows[0].hay) return;
  const { ADMIN_EMAIL: email, ADMIN_CLAVE: clave, ADMIN_NOMBRE: nombre = 'Administrador', ESTUDIO_NOMBRE: estudio = '' } = process.env;
  const usuario = String(process.env.ADMIN_USUARIO || 'admin').trim().toLowerCase();
  if (!email || !clave || clave.length < 10) {
    console.warn('No hay usuarios. Completá ADMIN_USUARIO, ADMIN_EMAIL y ADMIN_CLAVE (mínimo 10 caracteres) en el .env y reiniciá.');
    return;
  }
  // La base vuelve a controlar que no haya usuarios, por si arrancan dos servidores a la vez.
  const { rows: r } = await pool.query(
    'SELECT fn_crear_admin_inicial($1, $2, $3, $4, $5) AS creado',
    [usuario, email, nombre, await bcrypt.hash(clave, 12), estudio],
  );
  if (r[0].creado) console.log(`Administrador inicial creado: usuario "${usuario}". Ya podés borrar ADMIN_CLAVE del .env.`);
}

try {
  await crearAdminInicial();
} catch (err) {
  console.error('No se pudo conectar a la base de datos. ¿Corriste "npm run migrar" y revisaste DATABASE_URL?');
  console.error(err.message);
  process.exit(1);
}

const puerto = Number(process.env.PORT || 3000);
const servidor = app.listen(puerto, (err) => {
  if (err) return; // lo informa el manejador de 'error' de abajo
  console.log(`Sistema contable funcionando en http://localhost:${puerto}${MULTI_ESTUDIO ? ' (varios estudios)' : ''}`);
});
servidor.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`El puerto ${puerto} ya está en uso por otro programa. Cerralo o cambiá PORT en el .env (por ejemplo PORT=3001).`);
  } else {
    console.error('No se pudo iniciar el servidor:', err.message);
  }
  process.exit(1);
});
