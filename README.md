# Partida: sistema contable multiempresa

Aplicación web en Node.js con Express, páginas generadas en el servidor con EJS y base de datos PostgreSQL.
Los contadores la usan desde el navegador; no se instala nada en sus computadoras.

Esta es la **etapa 1**: usuarios con roles por empresa, alta de empresas con plan de cuentas base,
ejercicios y cierre mensual, libro diario y reportes (sumas y saldos, libro mayor, estado de resultados
y balance general).

## Instalación

La forma recomendada es con los instaladores de la carpeta `instalacion/`, que instalan lo que falte
(Node.js y PostgreSQL), crean la base `contable`, el archivo `.env`, las tablas y el usuario administrador:

| Sistema | Cómo |
|---|---|
| Windows 10 y 11 | Doble clic en `instalacion\instalar.bat` |
| Linux (Ubuntu, Debian, Fedora, Rocky, Arch…) y macOS | `bash instalacion/instalar.sh` (sin sudo) |

Al terminar: `http://localhost:3000`, usuario `nelson`, clave `hola012026` (cambiala el primer día).

Si Node.js y PostgreSQL ya están instalados, alcanza con:

```bash
npm install --omit=dev
npm run configurar
npm start
```

El detalle de cada paso, la configuración, las copias de seguridad y la solución de problemas están en el
**manual técnico**; el uso diario, en el **manual del usuario**.

### Comandos útiles

| Comando | Para qué |
|---|---|
| `npm start` | Iniciar el sistema |
| `npm run dev` | Iniciar en modo desarrollo (se reinicia al cambiar un archivo) |
| `npm run configurar` | Crear la base, el `.env`, las tablas y el administrador |
| `npm run migrar` | Aplicar los cambios de la base después de actualizar |
| `npm run respaldo` | Copia de seguridad en `respaldos/` |
| `npm test` | Pruebas automáticas |

## Primeros pasos en el sistema

1. En **Estudio → Empresas clientes**, dar de alta una empresa. Se copia el plan de cuentas base y se abre el
   ejercicio del año con sus 12 meses.
2. En **Estudio → Usuarios**, crear a los contadores y auxiliares.
3. En **Accesos** de cada empresa, asignar quién trabaja en ella y con qué rol.
4. Cargar asientos en el **Libro diario** y consultar los **Reportes**.
5. En **Comprobantes → Importar XML de SIFEN**, subir los XML de facturación electrónica (sueltos o en un ZIP)
   para registrar compras y ventas con su asiento automático.

## Carga rápida de facturas en papel

Para los comprobantes que no tienen XML: **Comprobantes → Cargar compra (o venta) en papel**. Se escribe lo que dice
la factura (RUC, timbrado, número, montos gravados 10% y 5% con IVA incluido y exentas) y se elige una **plantilla**.
La plantilla define la cuenta del asiento, en qué columna suele ir el importe y a qué impuestos se imputa (IVA, IRE, IRP).

- El IVA se calcula solo (10%: monto ÷ 11; 5%: monto ÷ 21). Si la factura dice otro importe por redondeo, se escribe
  el de la factura; el sistema rechaza diferencias grandes.
- Al escribir un RUC ya cargado, se completan la razón social y la última plantilla usada con ese cliente o proveedor.
- Después de guardar, el formulario queda listo para la siguiente factura con la misma fecha y condición.
- Se controla que no se cargue dos veces el mismo comprobante (RUC, timbrado y número).

Cada empresa tiene sus plantillas en **Plantillas**. Al crear una empresa se copian las del estudio (combustible,
alquiler, mercaderías, honorarios, etc.), definidas en la migración `007_carga_rapida.sql`.

## Importación de facturación electrónica

El sistema lee los XML de SIFEN (manual técnico v150) y, para cada documento:

- Decide si es **venta** (la empresa es la emisora) o **compra** (la empresa es la receptora). Las autofacturas
  emitidas por la empresa se registran como compras.
- Arma el asiento: IVA 10% y 5% separados, parte exenta, y contra caja/banco si es al contado o contra
  Deudores por ventas / Proveedores si es a crédito. Las **notas de crédito** invierten el asiento y las
  **notas de remisión** se ignoran. Los documentos en moneda extranjera se convierten con su tipo de cambio.
- Registra al cliente o proveedor y guarda el comprobante en el libro de compras o de ventas.
- En las compras, recuerda la cuenta elegida para cada proveedor y la propone sola la próxima vez.

Antes de registrar se muestra una vista previa. No se importan documentos repetidos (mismo CDC), de otra empresa,
de meses cerrados o cuyos importes no cuadran (por ejemplo, con descuentos globales o anticipos: esos se cargan a mano).

Para probar, la carpeta `test/xml` tiene tres documentos de ejemplo de una empresa con RUC `80045123`.

Las cuentas que usa la importación son las del plan base (4.1.01 Ventas gravadas 10%, 2.1.02 IVA débito fiscal 10%,
1.1.04 IVA crédito fiscal 10%, etc.). Están listadas en `src/sifen.js`, en la constante `CUENTAS`.

## Roles por empresa

| Rol | Puede |
|---|---|
| Lectura | Ver el diario, el plan de cuentas y los reportes |
| Auxiliar | Además, cargar, editar y eliminar borradores |
| Contador | Además, confirmar y anular asientos, agregar cuentas, crear ejercicios y cerrar meses |
| Supervisor | Además, reabrir meses y ver quién tiene acceso a la empresa |

Los **administradores del estudio** ven todas las empresas, crean empresas y usuarios, y asignan accesos.

## Cómo está organizado

```
contable/
  src/          Código del servidor
    app.js        Arranque: configura Express, sesiones y rutas
    sesion.js     Inicio de sesión, protección de formularios, empresa activa y rol
    db.js         Conexión a PostgreSQL y control de roles
    util.js       RUC, importes, partida doble y formatos (sin dependencias)
    diario.js     Libro diario
    plan.js       Plan de cuentas
    periodos.js   Ejercicios y cierre mensual
    reportes.js   Reportes contables
    admin.js      Empresas, usuarios y accesos
    comprobantes.js  Libros de compras y ventas, e importación de XML
    sifen.js      Lectura de los XML de SIFEN y armado del asiento (sin dependencias de la web)
    carga.js      Carga rápida de facturas en papel
    plantillas.js Plantillas de asiento de cada empresa
    migrar.js     Crea y actualiza las tablas
  vistas/       Páginas HTML (EJS). Las que empiezan con _ son partes compartidas.
  publico/      Estilos y el script de totales del formulario de asiento
  migraciones/  Esquema de la base de datos, en orden
  instalacion/  Instaladores, configurador, copia de seguridad e iniciar.bat
  manuales/     Manual del usuario en PDF y en Word
  test/         Pruebas
```

Cada archivo de `src/` tiene las consultas SQL de su tema y las rutas que atienden al navegador.
Nunca se modifica una migración ya aplicada: los cambios van en una nueva (`005_...sql`).

## Decisiones de diseño

**Las reglas contables viven en PostgreSQL.** La partida doble al confirmar, los meses cerrados, las cuentas
imputables, la inmutabilidad de los asientos confirmados, la numeración correlativa y la auditoría están en
triggers. Ni un error de programación ni una consulta manual pueden romper la contabilidad.

**El aislamiento entre empresas lo hace la base.** Cada operación abre una transacción y fija
`app.usuario_id`; la seguridad por fila (RLS) solo deja ver las empresas asignadas a ese usuario. Por eso la
aplicación se conecta con el rol `contable_app`, que no es dueño de las tablas.

**El dinero nunca pasa por números de coma flotante.** Los importes viajan como texto y se suman en centavos
con `BigInt`. Se escriben como en las facturas paraguayas: `1.500.000` o `1.250,50`.

**Ciclo de un asiento:** borrador (se edita y se elimina libremente) → confirmado (la base exige que balancee
y ya no se modifica) → anulado (queda como constancia; la corrección se registra en un asiento nuevo).
Un mes con borradores pendientes no se puede cerrar.

## Pendiente para próximas etapas

- Exportación del libro de compras y ventas para la RG 90 de Marangatu
- Autocompletar nombres con el listado de RUC que publica la SET
- Cierre de ejercicio con asiento de refundición
- Límite de intentos de inicio de sesión y cambio de clave por el propio usuario
