-- =====================================================================
-- Sistema contable multiempresa para estudio contable (Paraguay)
-- Motor: PostgreSQL 15+
-- Regla central: toda tabla contable lleva empresa_id, y la seguridad
-- por fila (RLS) impide que un usuario vea empresas no asignadas.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS citext;

-- ---------------------------------------------------------------------
-- 1. Usuarios del estudio y acceso por empresa
-- ---------------------------------------------------------------------
CREATE TABLE usuarios (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email         citext NOT NULL UNIQUE,
    nombre        text   NOT NULL,
    hash_clave    text   NOT NULL,
    es_admin      boolean NOT NULL DEFAULT false,   -- administra todo el estudio
    activo        boolean NOT NULL DEFAULT true,
    creado_en     timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE regimen_tributario AS ENUM ('IRE_GENERAL', 'IRE_SIMPLE', 'IRE_RESIMPLE', 'IRP', 'OTRO');

CREATE TABLE empresas (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ruc             varchar(15) NOT NULL,
    dv              smallint    NOT NULL,
    razon_social    text        NOT NULL,
    nombre_fantasia text,
    regimen         regimen_tributario NOT NULL DEFAULT 'IRE_GENERAL',
    moneda_funcional char(3)    NOT NULL DEFAULT 'PYG',
    contador_resp   bigint REFERENCES usuarios(id),
    activa          boolean     NOT NULL DEFAULT true,
    creado_en       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (ruc)
);

CREATE TYPE rol_empresa AS ENUM ('lectura', 'auxiliar', 'contador', 'supervisor');

CREATE TABLE usuario_empresa (
    usuario_id  bigint NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    empresa_id  bigint NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
    rol         rol_empresa NOT NULL DEFAULT 'auxiliar',
    PRIMARY KEY (usuario_id, empresa_id)
);

-- ---------------------------------------------------------------------
-- 2. Ejercicios y periodos (cierre mensual)
-- ---------------------------------------------------------------------
CREATE TABLE ejercicios (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    empresa_id  bigint NOT NULL REFERENCES empresas(id),
    anio        smallint NOT NULL,
    fecha_desde date NOT NULL,
    fecha_hasta date NOT NULL,
    cerrado     boolean NOT NULL DEFAULT false,
    UNIQUE (empresa_id, anio),
    UNIQUE (empresa_id, id),
    CHECK (fecha_hasta > fecha_desde)
);

CREATE TABLE periodos (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    empresa_id    bigint NOT NULL REFERENCES empresas(id),
    ejercicio_id  bigint NOT NULL,
    mes           date   NOT NULL,          -- primer día del mes
    cerrado       boolean NOT NULL DEFAULT false,
    cerrado_por   bigint REFERENCES usuarios(id),
    cerrado_en    timestamptz,
    UNIQUE (empresa_id, mes),
    FOREIGN KEY (empresa_id, ejercicio_id) REFERENCES ejercicios(empresa_id, id),
    CHECK (mes = date_trunc('month', mes)::date)
);

-- ---------------------------------------------------------------------
-- 3. Plan de cuentas (plantilla del estudio + copia por empresa)
-- ---------------------------------------------------------------------
CREATE TYPE tipo_cuenta AS ENUM ('ACTIVO', 'PASIVO', 'PATRIMONIO', 'INGRESO', 'GASTO');

CREATE TABLE plantilla_cuentas (
    codigo      varchar(20) PRIMARY KEY,     -- ej. 1.1.01
    nombre      text        NOT NULL,
    tipo        tipo_cuenta NOT NULL,
    imputable   boolean     NOT NULL,
    codigo_padre varchar(20) REFERENCES plantilla_cuentas(codigo)
);

CREATE TABLE cuentas (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    empresa_id  bigint NOT NULL REFERENCES empresas(id),
    codigo      varchar(20) NOT NULL,
    nombre      text        NOT NULL,
    tipo        tipo_cuenta NOT NULL,
    imputable   boolean     NOT NULL DEFAULT true,
    padre_id    bigint,
    activa      boolean     NOT NULL DEFAULT true,
    UNIQUE (empresa_id, codigo),
    UNIQUE (empresa_id, id),
    FOREIGN KEY (empresa_id, padre_id) REFERENCES cuentas(empresa_id, id)
);

CREATE TABLE centros_costo (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    empresa_id  bigint NOT NULL REFERENCES empresas(id),
    codigo      varchar(20) NOT NULL,
    nombre      text NOT NULL,
    UNIQUE (empresa_id, codigo),
    UNIQUE (empresa_id, id)
);

-- ---------------------------------------------------------------------
-- 4. Monedas y tipos de cambio
-- ---------------------------------------------------------------------
CREATE TABLE tipos_cambio (
    moneda      char(3) NOT NULL,            -- USD, BRL, ARS...
    fecha       date    NOT NULL,
    compra      numeric(14,4) NOT NULL,
    venta       numeric(14,4) NOT NULL,
    PRIMARY KEY (moneda, fecha)
);

-- ---------------------------------------------------------------------
-- 5. Asientos contables (libro diario)
-- ---------------------------------------------------------------------
CREATE TYPE estado_asiento AS ENUM ('borrador', 'confirmado', 'anulado');
CREATE TYPE origen_asiento AS ENUM ('manual', 'venta', 'compra', 'apertura', 'cierre', 'ajuste');

CREATE TABLE asientos (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    empresa_id    bigint NOT NULL REFERENCES empresas(id),
    ejercicio_id  bigint NOT NULL,
    numero        integer NOT NULL,          -- correlativo por ejercicio
    fecha         date    NOT NULL,
    concepto      text    NOT NULL,
    origen        origen_asiento NOT NULL DEFAULT 'manual',
    estado        estado_asiento NOT NULL DEFAULT 'borrador',
    moneda        char(3) NOT NULL DEFAULT 'PYG',
    tipo_cambio   numeric(14,4) NOT NULL DEFAULT 1,
    creado_por    bigint REFERENCES usuarios(id),
    creado_en     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (empresa_id, ejercicio_id, numero),
    UNIQUE (empresa_id, id),
    FOREIGN KEY (empresa_id, ejercicio_id) REFERENCES ejercicios(empresa_id, id)
);

CREATE TABLE asiento_lineas (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    empresa_id    bigint NOT NULL,
    asiento_id    bigint NOT NULL,
    cuenta_id     bigint NOT NULL,
    centro_costo_id bigint,
    debe          numeric(18,2) NOT NULL DEFAULT 0 CHECK (debe  >= 0),
    haber         numeric(18,2) NOT NULL DEFAULT 0 CHECK (haber >= 0),
    detalle       text,
    CHECK ((debe = 0) <> (haber = 0)),       -- exactamente uno de los dos
    -- Las FK compuestas garantizan que la línea, el asiento y la cuenta
    -- pertenezcan a la MISMA empresa.
    FOREIGN KEY (empresa_id, asiento_id) REFERENCES asientos(empresa_id, id) ON DELETE CASCADE,
    FOREIGN KEY (empresa_id, cuenta_id)  REFERENCES cuentas(empresa_id, id),
    FOREIGN KEY (empresa_id, centro_costo_id) REFERENCES centros_costo(empresa_id, id)
);

CREATE INDEX ix_lineas_cuenta  ON asiento_lineas (empresa_id, cuenta_id);
CREATE INDEX ix_lineas_asiento ON asiento_lineas (asiento_id);
CREATE INDEX ix_asientos_fecha ON asientos (empresa_id, fecha);

-- ---------------------------------------------------------------------
-- 6. Terceros y comprobantes (libros de compras y ventas)
-- ---------------------------------------------------------------------
CREATE TABLE terceros (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    empresa_id    bigint NOT NULL REFERENCES empresas(id),
    ruc           varchar(15) NOT NULL,
    dv            smallint,
    razon_social  text NOT NULL,
    es_cliente    boolean NOT NULL DEFAULT false,
    es_proveedor  boolean NOT NULL DEFAULT false,
    UNIQUE (empresa_id, ruc),
    UNIQUE (empresa_id, id)
);

CREATE TYPE tipo_libro AS ENUM ('VENTA', 'COMPRA');
CREATE TYPE condicion_pago AS ENUM ('CONTADO', 'CREDITO');

CREATE TABLE comprobantes (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    empresa_id      bigint NOT NULL REFERENCES empresas(id),
    libro           tipo_libro NOT NULL,
    tipo_comprobante smallint NOT NULL DEFAULT 1,     -- 1 factura, 2 nota de crédito, etc. (según RG 90)
    tercero_id      bigint NOT NULL,
    fecha           date NOT NULL,
    timbrado        varchar(8) NOT NULL,
    numero          varchar(15) NOT NULL,             -- 001-001-0000001
    cdc             varchar(44),                      -- código de control SIFEN (factura electrónica)
    condicion       condicion_pago NOT NULL DEFAULT 'CONTADO',
    moneda          char(3) NOT NULL DEFAULT 'PYG',
    tipo_cambio     numeric(14,4) NOT NULL DEFAULT 1,
    total_grav_10   numeric(18,2) NOT NULL DEFAULT 0, -- montos IVA incluido
    total_grav_5    numeric(18,2) NOT NULL DEFAULT 0,
    total_exenta    numeric(18,2) NOT NULL DEFAULT 0,
    iva_10          numeric(18,2) GENERATED ALWAYS AS (round(total_grav_10 / 11, 0)) STORED,
    iva_5           numeric(18,2) GENERATED ALWAYS AS (round(total_grav_5 / 21, 0)) STORED,
    total           numeric(18,2) GENERATED ALWAYS AS (total_grav_10 + total_grav_5 + total_exenta) STORED,
    imputa_iva      boolean NOT NULL DEFAULT true,
    imputa_ire      boolean NOT NULL DEFAULT true,
    imputa_irp      boolean NOT NULL DEFAULT false,
    asiento_id      bigint,
    creado_por      bigint REFERENCES usuarios(id),
    creado_en       timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (empresa_id, tercero_id) REFERENCES terceros(empresa_id, id),
    FOREIGN KEY (empresa_id, asiento_id) REFERENCES asientos(empresa_id, id),
    UNIQUE (empresa_id, libro, tercero_id, timbrado, numero)   -- evita cargar dos veces
);

CREATE INDEX ix_comprobantes_fecha ON comprobantes (empresa_id, libro, fecha);

-- ---------------------------------------------------------------------
-- 7. Auditoría
-- ---------------------------------------------------------------------
CREATE TABLE auditoria (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    empresa_id  bigint,
    usuario_id  bigint,
    tabla       text NOT NULL,
    registro_id bigint,
    accion      text NOT NULL,              -- INSERT / UPDATE / DELETE
    antes       jsonb,
    despues     jsonb,
    fecha       timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION fn_auditar() RETURNS trigger AS $$
DECLARE
    fila jsonb;
BEGIN
    IF TG_OP = 'DELETE' THEN fila := to_jsonb(OLD); ELSE fila := to_jsonb(NEW); END IF;
    INSERT INTO auditoria (empresa_id, usuario_id, tabla, registro_id, accion, antes, despues)
    VALUES (
        (fila->>'empresa_id')::bigint,
        NULLIF(current_setting('app.usuario_id', true), '')::bigint,
        TG_TABLE_NAME,
        (fila->>'id')::bigint,
        TG_OP,
        CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) END,
        CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) END
    );
    RETURN NULL;   -- trigger AFTER: el valor de retorno se ignora
END $$ LANGUAGE plpgsql;

CREATE TRIGGER aud_asientos     AFTER INSERT OR UPDATE OR DELETE ON asientos       FOR EACH ROW EXECUTE FUNCTION fn_auditar();
CREATE TRIGGER aud_lineas       AFTER INSERT OR UPDATE OR DELETE ON asiento_lineas FOR EACH ROW EXECUTE FUNCTION fn_auditar();
CREATE TRIGGER aud_comprobantes AFTER INSERT OR UPDATE OR DELETE ON comprobantes   FOR EACH ROW EXECUTE FUNCTION fn_auditar();

-- ---------------------------------------------------------------------
-- 8. Reglas de negocio en la base
-- ---------------------------------------------------------------------

-- 8.1 Dígito verificador del RUC (módulo 11, algoritmo de la SET)
CREATE OR REPLACE FUNCTION fn_dv_ruc(p_ruc text) RETURNS smallint AS $$
DECLARE
    total int := 0;
    k     int := 2;
    i     int;
    resto int;
BEGIN
    FOR i IN REVERSE length(p_ruc)..1 LOOP
        IF k > 11 THEN k := 2; END IF;
        total := total + substr(p_ruc, i, 1)::int * k;
        k := k + 1;
    END LOOP;
    resto := total % 11;
    RETURN CASE WHEN resto > 1 THEN 11 - resto ELSE 0 END;
END $$ LANGUAGE plpgsql IMMUTABLE;

ALTER TABLE empresas ADD CONSTRAINT ck_empresas_dv CHECK (dv = fn_dv_ruc(ruc));

-- 8.2 No se modifica nada en un periodo cerrado
CREATE OR REPLACE FUNCTION fn_mes_cerrado(p_empresa bigint, p_fecha date) RETURNS boolean AS $$
    SELECT EXISTS (SELECT 1 FROM periodos p
                    WHERE p.empresa_id = p_empresa
                      AND p.mes = date_trunc('month', p_fecha)::date
                      AND p.cerrado)
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION fn_validar_periodo_abierto() RETURNS trigger AS $$
DECLARE
    v_empresa bigint;
    v_fecha   date;
BEGIN
    -- Fecha "vieja" (UPDATE/DELETE) y "nueva" (INSERT/UPDATE): ambas deben estar en meses abiertos.
    IF TG_TABLE_NAME = 'asientos' THEN
        IF TG_OP IN ('UPDATE', 'DELETE') AND fn_mes_cerrado(OLD.empresa_id, OLD.fecha) THEN
            RAISE EXCEPTION 'El periodo % está cerrado', to_char(OLD.fecha, 'MM/YYYY');
        END IF;
        IF TG_OP IN ('INSERT', 'UPDATE') AND fn_mes_cerrado(NEW.empresa_id, NEW.fecha) THEN
            RAISE EXCEPTION 'El periodo % está cerrado', to_char(NEW.fecha, 'MM/YYYY');
        END IF;
    ELSE
        IF TG_OP = 'DELETE' THEN
            SELECT a.empresa_id, a.fecha INTO v_empresa, v_fecha FROM asientos a WHERE a.id = OLD.asiento_id;
        ELSE
            SELECT a.empresa_id, a.fecha INTO v_empresa, v_fecha FROM asientos a WHERE a.id = NEW.asiento_id;
        END IF;
        -- Si el asiento ya no existe (borrado en cascada) su propio trigger ya validó el periodo.
        IF v_empresa IS NOT NULL AND fn_mes_cerrado(v_empresa, v_fecha) THEN
            RAISE EXCEPTION 'El periodo % está cerrado', to_char(v_fecha, 'MM/YYYY');
        END IF;
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_periodo_asientos BEFORE INSERT OR UPDATE OR DELETE ON asientos
    FOR EACH ROW EXECUTE FUNCTION fn_validar_periodo_abierto();
CREATE TRIGGER trg_periodo_lineas BEFORE INSERT OR UPDATE OR DELETE ON asiento_lineas
    FOR EACH ROW EXECUTE FUNCTION fn_validar_periodo_abierto();

-- 8.3 Solo cuentas imputables reciben movimientos
CREATE OR REPLACE FUNCTION fn_validar_cuenta_imputable() RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM cuentas c WHERE c.id = NEW.cuenta_id AND c.imputable AND c.activa) THEN
        RAISE EXCEPTION 'La cuenta % no es imputable o está inactiva', NEW.cuenta_id;
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_cuenta_imputable BEFORE INSERT OR UPDATE ON asiento_lineas
    FOR EACH ROW EXECUTE FUNCTION fn_validar_cuenta_imputable();

-- Un asiento confirmado o anulado es inmutable: sus líneas no se tocan
-- (se corrige anulándolo y registrando otro). El borrado en cascada de un
-- borrador sigue permitido porque el asiento ya no existe.
CREATE OR REPLACE FUNCTION fn_lineas_inmutables() RETURNS trigger AS $$
DECLARE
    v_estado estado_asiento;
BEGIN
    IF TG_OP = 'DELETE' THEN
        SELECT estado INTO v_estado FROM asientos WHERE id = OLD.asiento_id;
    ELSE
        SELECT estado INTO v_estado FROM asientos WHERE id = NEW.asiento_id;
    END IF;
    -- En un INSERT dentro de la misma transacción que crea y confirma, el asiento aún está en borrador.
    IF v_estado IN ('confirmado', 'anulado') THEN
        RAISE EXCEPTION 'El asiento está %; no se pueden modificar sus líneas', v_estado;
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_lineas_inmutables BEFORE INSERT OR UPDATE OR DELETE ON asiento_lineas
    FOR EACH ROW EXECUTE FUNCTION fn_lineas_inmutables();

-- Solo los borradores se eliminan; un asiento confirmado se anula.
-- Tampoco se reabre a borrador un asiento confirmado o anulado.
CREATE OR REPLACE FUNCTION fn_proteger_asiento() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.estado <> 'borrador' THEN
            RAISE EXCEPTION 'Solo se eliminan asientos en borrador; este está %', OLD.estado;
        END IF;
        RETURN OLD;
    END IF;
    IF OLD.estado = 'anulado' THEN
        RAISE EXCEPTION 'Un asiento anulado no se modifica';
    END IF;
    IF OLD.estado = 'confirmado' AND (NEW.estado <> 'anulado'
         OR NEW.fecha <> OLD.fecha OR NEW.concepto <> OLD.concepto) THEN
        RAISE EXCEPTION 'Un asiento confirmado solo puede anularse';
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_proteger_asiento BEFORE UPDATE OR DELETE ON asientos
    FOR EACH ROW EXECUTE FUNCTION fn_proteger_asiento();

-- 8.4 Partida doble: un asiento confirmado debe balancear (se valida al COMMIT)
CREATE OR REPLACE FUNCTION fn_validar_balanceo() RETURNS trigger AS $$
DECLARE
    v_asiento bigint;
    v_estado  estado_asiento;
    v_debe    numeric;
    v_haber   numeric;
    v_lineas  int;
BEGIN
    IF TG_TABLE_NAME = 'asientos' THEN
        v_asiento := NEW.id;
    ELSIF TG_OP = 'DELETE' THEN
        v_asiento := OLD.asiento_id;
    ELSE
        v_asiento := NEW.asiento_id;
    END IF;

    SELECT estado INTO v_estado FROM asientos WHERE id = v_asiento;
    IF v_estado IS DISTINCT FROM 'confirmado' THEN
        RETURN NULL;
    END IF;

    SELECT COALESCE(sum(debe), 0), COALESCE(sum(haber), 0), count(*)
      INTO v_debe, v_haber, v_lineas
      FROM asiento_lineas WHERE asiento_id = v_asiento;

    IF v_lineas < 2 OR v_debe <> v_haber THEN
        RAISE EXCEPTION 'Asiento % desbalanceado: debe %, haber %', v_asiento, v_debe, v_haber;
    END IF;
    RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_balanceo_lineas
    AFTER INSERT OR UPDATE OR DELETE ON asiento_lineas
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION fn_validar_balanceo();

CREATE CONSTRAINT TRIGGER trg_balanceo_asientos
    AFTER INSERT OR UPDATE OF estado ON asientos
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION fn_validar_balanceo();

-- 8.5 Número correlativo de asiento por empresa y ejercicio
CREATE OR REPLACE FUNCTION fn_numerar_asiento() RETURNS trigger AS $$
BEGIN
    IF NEW.numero IS NULL OR NEW.numero = 0 THEN
        -- bloqueo por empresa+ejercicio para evitar números duplicados en concurrencia
        PERFORM pg_advisory_xact_lock(NEW.empresa_id::int, NEW.ejercicio_id::int);
        SELECT COALESCE(max(numero), 0) + 1 INTO NEW.numero
          FROM asientos
         WHERE empresa_id = NEW.empresa_id AND ejercicio_id = NEW.ejercicio_id;
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;

ALTER TABLE asientos ALTER COLUMN numero SET DEFAULT 0;
CREATE TRIGGER trg_numerar_asiento BEFORE INSERT ON asientos
    FOR EACH ROW EXECUTE FUNCTION fn_numerar_asiento();

-- 8.6 Copiar la plantilla del estudio al crear una empresa
CREATE OR REPLACE FUNCTION fn_copiar_plantilla(p_empresa bigint) RETURNS void AS $$
BEGIN
    INSERT INTO cuentas (empresa_id, codigo, nombre, tipo, imputable)
    SELECT p_empresa, codigo, nombre, tipo, imputable FROM plantilla_cuentas;

    UPDATE cuentas c
       SET padre_id = p.id
      FROM plantilla_cuentas t
      JOIN cuentas p ON p.empresa_id = p_empresa AND p.codigo = t.codigo_padre
     WHERE c.empresa_id = p_empresa
       AND c.codigo = t.codigo;
END $$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------
-- 9. Seguridad por fila: cada usuario ve solo sus empresas asignadas.
--    La aplicación ejecuta al inicio de cada request:
--      SET LOCAL app.usuario_id = '<id>';
--    y se conecta con un rol SIN privilegio BYPASSRLS.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_usuario_actual() RETURNS bigint AS $$
    SELECT NULLIF(current_setting('app.usuario_id', true), '')::bigint
$$ LANGUAGE sql STABLE;

-- Los administradores del estudio ven todas las empresas. Esta condición no
-- consulta la tabla empresas, así también vale para una empresa recién insertada.
CREATE OR REPLACE FUNCTION fn_es_admin() RETURNS boolean AS $$
    SELECT COALESCE((SELECT u.es_admin AND u.activo FROM usuarios u WHERE u.id = fn_usuario_actual()), false)
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION fn_empresas_permitidas() RETURNS SETOF bigint AS $$
    SELECT ue.empresa_id FROM usuario_empresa ue WHERE ue.usuario_id = fn_usuario_actual()
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['ejercicios','periodos','cuentas','centros_costo','asientos',
                             'asiento_lineas','terceros','comprobantes']
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format(
            'CREATE POLICY pol_empresa ON %I '
            'USING (fn_es_admin() OR empresa_id IN (SELECT fn_empresas_permitidas())) '
            'WITH CHECK (fn_es_admin() OR empresa_id IN (SELECT fn_empresas_permitidas()))', t);
    END LOOP;
END $$;

ALTER TABLE empresas ENABLE ROW LEVEL SECURITY;
ALTER TABLE empresas FORCE ROW LEVEL SECURITY;
CREATE POLICY pol_empresa ON empresas
    USING (fn_es_admin() OR id IN (SELECT fn_empresas_permitidas()))
    WITH CHECK (fn_es_admin() OR id IN (SELECT fn_empresas_permitidas()));

-- ---------------------------------------------------------------------
-- 10. Vistas de reportes
-- ---------------------------------------------------------------------
-- Balance de sumas y saldos (filtrar por empresa y rango de fechas en el WHERE)
CREATE OR REPLACE VIEW v_movimientos WITH (security_invoker = true) AS
SELECT a.empresa_id, a.fecha, a.numero, a.concepto,
       c.codigo, c.nombre AS cuenta, c.tipo,
       l.debe, l.haber
  FROM asiento_lineas l
  JOIN asientos a ON a.id = l.asiento_id AND a.estado = 'confirmado'
  JOIN cuentas  c ON c.id = l.cuenta_id;

-- Ejemplo de uso:
-- SELECT codigo, cuenta, sum(debe) debe, sum(haber) haber,
--        greatest(sum(debe)-sum(haber),0) saldo_deudor,
--        greatest(sum(haber)-sum(debe),0) saldo_acreedor
--   FROM v_movimientos
--  WHERE empresa_id = 1 AND fecha BETWEEN '2026-01-01' AND '2026-12-31'
--  GROUP BY codigo, cuenta ORDER BY codigo;

-- Liquidación de IVA mensual
CREATE OR REPLACE VIEW v_liquidacion_iva WITH (security_invoker = true) AS
SELECT empresa_id,
       date_trunc('month', fecha)::date AS mes,
       sum(CASE WHEN libro = 'VENTA'  THEN iva_10 + iva_5 ELSE 0 END) AS debito_fiscal,
       sum(CASE WHEN libro = 'COMPRA' AND imputa_iva THEN iva_10 + iva_5 ELSE 0 END) AS credito_fiscal,
       sum(CASE WHEN libro = 'VENTA'  THEN iva_10 + iva_5 ELSE 0 END)
     - sum(CASE WHEN libro = 'COMPRA' AND imputa_iva THEN iva_10 + iva_5 ELSE 0 END) AS saldo
  FROM comprobantes
 GROUP BY empresa_id, date_trunc('month', fecha);

-- ---------------------------------------------------------------------
-- 11. Plantilla base de plan de cuentas (ajustable por el estudio)
-- ---------------------------------------------------------------------
INSERT INTO plantilla_cuentas (codigo, nombre, tipo, imputable, codigo_padre) VALUES
('1',      'Activo',                         'ACTIVO',     false, NULL),
('1.1',    'Activo corriente',               'ACTIVO',     false, '1'),
('1.1.01', 'Caja',                           'ACTIVO',     true,  '1.1'),
('1.1.02', 'Bancos',                         'ACTIVO',     true,  '1.1'),
('1.1.03', 'Deudores por ventas',            'ACTIVO',     true,  '1.1'),
('1.1.04', 'IVA crédito fiscal 10%',         'ACTIVO',     true,  '1.1'),
('1.1.05', 'IVA crédito fiscal 5%',          'ACTIVO',     true,  '1.1'),
('1.1.06', 'Mercaderías',                    'ACTIVO',     true,  '1.1'),
('1.2',    'Activo no corriente',            'ACTIVO',     false, '1'),
('1.2.01', 'Muebles y útiles',               'ACTIVO',     true,  '1.2'),
('1.2.02', 'Rodados',                        'ACTIVO',     true,  '1.2'),
('1.2.03', 'Depreciación acumulada',         'ACTIVO',     true,  '1.2'),
('2',      'Pasivo',                         'PASIVO',     false, NULL),
('2.1',    'Pasivo corriente',               'PASIVO',     false, '2'),
('2.1.01', 'Proveedores',                    'PASIVO',     true,  '2.1'),
('2.1.02', 'IVA débito fiscal 10%',          'PASIVO',     true,  '2.1'),
('2.1.03', 'IVA débito fiscal 5%',           'PASIVO',     true,  '2.1'),
('2.1.04', 'Sueldos a pagar',                'PASIVO',     true,  '2.1'),
('2.1.05', 'IPS a pagar',                    'PASIVO',     true,  '2.1'),
('2.1.06', 'IRE a pagar',                    'PASIVO',     true,  '2.1'),
('2.2',    'Pasivo no corriente',            'PASIVO',     false, '2'),
('2.2.01', 'Préstamos bancarios a largo plazo','PASIVO',   true,  '2.2'),
('3',      'Patrimonio neto',                'PATRIMONIO', false, NULL),
('3.1.01', 'Capital',                        'PATRIMONIO', true,  '3'),
('3.1.02', 'Reserva legal',                  'PATRIMONIO', true,  '3'),
('3.1.03', 'Resultados acumulados',          'PATRIMONIO', true,  '3'),
('3.1.04', 'Resultado del ejercicio',        'PATRIMONIO', true,  '3'),
('4',      'Ingresos',                       'INGRESO',    false, NULL),
('4.1.01', 'Ventas gravadas 10%',            'INGRESO',    true,  '4'),
('4.1.02', 'Ventas gravadas 5%',             'INGRESO',    true,  '4'),
('4.1.03', 'Ventas exentas',                 'INGRESO',    true,  '4'),
('4.1.04', 'Otros ingresos',                 'INGRESO',    true,  '4'),
('5',      'Costos y gastos',                'GASTO',      false, NULL),
('5.1.01', 'Costo de mercaderías vendidas',  'GASTO',      true,  '5'),
('5.2.01', 'Sueldos y jornales',             'GASTO',      true,  '5'),
('5.2.02', 'Aporte patronal IPS',            'GASTO',      true,  '5'),
('5.2.03', 'Alquileres',                     'GASTO',      true,  '5'),
('5.2.04', 'Servicios básicos',              'GASTO',      true,  '5'),
('5.2.05', 'Honorarios profesionales',       'GASTO',      true,  '5'),
('5.2.06', 'Gastos bancarios',               'GASTO',      true,  '5'),
('5.2.07', 'Depreciaciones',                 'GASTO',      true,  '5'),
('5.2.08', 'Compras y gastos varios',        'GASTO',      true,  '5');
