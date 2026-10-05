-- Varios estudios contables en una misma instalación (por ejemplo, en la nube).
--
-- Cada estudio tiene sus propios usuarios y sus empresas clientes, y no ve nada de los demás.
-- Una instalación local sigue funcionando igual: todo queda en el estudio 1, que se crea acá.
--
-- La separación la sigue haciendo la base:
--   * usuarios, empresas y usuario_empresa llevan (directa o indirectamente) el estudio;
--   * las tablas contables ven solo las filas de las empresas visibles para el usuario,
--     y las empresas visibles son, como máximo, las de su propio estudio.

-- ---------------------------------------------------------------------
-- 1. Estudios
-- ---------------------------------------------------------------------
CREATE TABLE estudios (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    nombre     text NOT NULL CHECK (length(trim(nombre)) BETWEEN 1 AND 200),
    ruc        varchar(15),
    activo     boolean NOT NULL DEFAULT true,
    creado_en  timestamptz NOT NULL DEFAULT now()
);

-- El estudio de las instalaciones existentes (y de toda instalación local).
INSERT INTO estudios (nombre) VALUES ('Estudio principal');

-- ---------------------------------------------------------------------
-- 2. Estudio de cada usuario y de cada empresa
-- ---------------------------------------------------------------------
ALTER TABLE usuarios ADD COLUMN estudio_id bigint REFERENCES estudios(id);
ALTER TABLE empresas ADD COLUMN estudio_id bigint REFERENCES estudios(id);
UPDATE usuarios SET estudio_id = (SELECT min(id) FROM estudios);
UPDATE empresas SET estudio_id = (SELECT min(id) FROM estudios);
ALTER TABLE usuarios ALTER COLUMN estudio_id SET NOT NULL;
ALTER TABLE empresas ALTER COLUMN estudio_id SET NOT NULL;
CREATE INDEX ix_usuarios_estudio ON usuarios (estudio_id);
CREATE INDEX ix_empresas_estudio ON empresas (estudio_id);

-- Dos estudios pueden llevar la misma empresa (por ejemplo, si cambió de contador);
-- dentro de un estudio el RUC sigue siendo único.
ALTER TABLE empresas DROP CONSTRAINT empresas_ruc_key;
ALTER TABLE empresas ADD CONSTRAINT uq_empresas_estudio_ruc UNIQUE (estudio_id, ruc);

-- Administrador de la plataforma: da de alta los estudios. No ve la contabilidad de los
-- demás estudios. En una instalación local no tiene ninguna pantalla extra.
ALTER TABLE usuarios ADD COLUMN es_superadmin boolean NOT NULL DEFAULT false;
UPDATE usuarios SET es_superadmin = true
 WHERE id = (SELECT min(id) FROM usuarios WHERE es_admin);

-- ---------------------------------------------------------------------
-- 3. Funciones de seguridad
--    SECURITY DEFINER: leen usuarios y estudios sin pasar por su seguridad por fila
--    (si no, la política de usuarios se consultaría a sí misma).
-- ---------------------------------------------------------------------

-- Estudio del usuario conectado; NULL si el usuario o su estudio están desactivados.
CREATE OR REPLACE FUNCTION fn_estudio_actual() RETURNS bigint AS $$
    SELECT u.estudio_id
      FROM usuarios u JOIN estudios s ON s.id = u.estudio_id
     WHERE u.id = fn_usuario_actual() AND u.activo AND s.activo
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- Para los comandos de instalación (configurar, migraciones), que no tienen usuario conectado:
-- si hay un solo estudio, es ese.
CREATE OR REPLACE FUNCTION fn_estudio_por_defecto() RETURNS bigint AS $$
    SELECT COALESCE(fn_estudio_actual(),
                    (SELECT min(id) FROM estudios HAVING count(*) = 1))
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

ALTER TABLE usuarios ALTER COLUMN estudio_id SET DEFAULT fn_estudio_por_defecto();
ALTER TABLE empresas ALTER COLUMN estudio_id SET DEFAULT fn_estudio_por_defecto();

-- Administrador de SU estudio (activo, y con el estudio activo).
CREATE OR REPLACE FUNCTION fn_es_admin() RETURNS boolean AS $$
    SELECT COALESCE((SELECT u.es_admin FROM usuarios u
                      WHERE u.id = fn_usuario_actual() AND u.estudio_id = fn_estudio_actual()), false)
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION fn_es_superadmin() RETURNS boolean AS $$
    SELECT COALESCE((SELECT u.es_superadmin FROM usuarios u
                      WHERE u.id = fn_usuario_actual() AND u.estudio_id = fn_estudio_actual()), false)
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- Empresas asignadas al usuario (se cruza con el estudio en la política de empresas).
CREATE OR REPLACE FUNCTION fn_empresas_permitidas() RETURNS SETOF bigint AS $$
    SELECT ue.empresa_id FROM usuario_empresa ue
     WHERE ue.usuario_id = fn_usuario_actual() AND fn_estudio_actual() IS NOT NULL
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- ---------------------------------------------------------------------
-- 4. Seguridad por fila
-- ---------------------------------------------------------------------

-- 4.1 Empresas: solo las del propio estudio; el administrador ve todas las de su estudio,
--     los demás solo las asignadas.
DROP POLICY pol_empresa ON empresas;
CREATE POLICY pol_empresa ON empresas
    USING (estudio_id = fn_estudio_actual()
           AND (fn_es_admin() OR id IN (SELECT fn_empresas_permitidas())))
    WITH CHECK (estudio_id = fn_estudio_actual()
           AND (fn_es_admin() OR id IN (SELECT fn_empresas_permitidas())));

-- 4.2 Tablas contables: se ve una fila si se ve su empresa. La subconsulta pasa por la
--     política de empresas de arriba, así que el estudio se controla en un solo lugar.
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['ejercicios','periodos','cuentas','centros_costo','asientos',
                             'asiento_lineas','terceros','comprobantes','reglas_proveedor','plantillas']
    LOOP
        EXECUTE format('DROP POLICY pol_empresa ON %I', t);
        EXECUTE format(
            'CREATE POLICY pol_empresa ON %I '
            'USING (empresa_id IN (SELECT id FROM empresas)) '
            'WITH CHECK (empresa_id IN (SELECT id FROM empresas))', t);
    END LOOP;
END $$;

-- 4.3 Usuarios: cada uno ve a los de su estudio; solo el administrador los modifica.
--     Sin FORCE: las funciones SECURITY DEFINER de arriba (dueñas de la tabla) leen sin filtro.
ALTER TABLE usuarios ENABLE ROW LEVEL SECURITY;
CREATE POLICY pol_usuarios_ver ON usuarios FOR SELECT
    USING (estudio_id = fn_estudio_actual());
CREATE POLICY pol_usuarios_alta ON usuarios FOR INSERT
    WITH CHECK (fn_es_admin() AND estudio_id = fn_estudio_actual());
CREATE POLICY pol_usuarios_cambio ON usuarios FOR UPDATE
    USING (fn_es_admin() AND estudio_id = fn_estudio_actual())
    WITH CHECK (fn_es_admin() AND estudio_id = fn_estudio_actual());
CREATE POLICY pol_usuarios_baja ON usuarios FOR DELETE
    USING (fn_es_admin() AND estudio_id = fn_estudio_actual());

-- La aplicación no puede mover usuarios ni empresas de estudio, ni nombrar
-- administradores de la plataforma: eso solo lo hacen las funciones de abajo.
-- Ojo en migraciones futuras: un GRANT ... ON ALL TABLES devolvería estos permisos.
REVOKE INSERT, UPDATE ON usuarios FROM contable_app;
GRANT INSERT (usuario, email, nombre, hash_clave, es_admin) ON usuarios TO contable_app;
GRANT UPDATE (usuario, email, nombre, hash_clave, es_admin, activo) ON usuarios TO contable_app;
REVOKE INSERT, UPDATE ON empresas FROM contable_app;
GRANT INSERT (ruc, dv, razon_social, nombre_fantasia, regimen, moneda_funcional, contador_resp, activa) ON empresas TO contable_app;
GRANT UPDATE (ruc, dv, razon_social, nombre_fantasia, regimen, moneda_funcional, contador_resp, activa) ON empresas TO contable_app;

-- 4.4 Accesos: se ven los de las empresas visibles y los propios; los asigna el administrador.
ALTER TABLE usuario_empresa ENABLE ROW LEVEL SECURITY;
CREATE POLICY pol_accesos_ver ON usuario_empresa FOR SELECT
    USING (usuario_id = fn_usuario_actual() OR empresa_id IN (SELECT id FROM empresas));
CREATE POLICY pol_accesos_alta ON usuario_empresa FOR INSERT
    WITH CHECK (fn_es_admin() AND empresa_id IN (SELECT id FROM empresas)
                AND usuario_id IN (SELECT id FROM usuarios));
CREATE POLICY pol_accesos_cambio ON usuario_empresa FOR UPDATE
    USING (fn_es_admin() AND empresa_id IN (SELECT id FROM empresas))
    WITH CHECK (fn_es_admin() AND empresa_id IN (SELECT id FROM empresas)
                AND usuario_id IN (SELECT id FROM usuarios));
CREATE POLICY pol_accesos_baja ON usuario_empresa FOR DELETE
    USING (fn_es_admin() AND empresa_id IN (SELECT id FROM empresas));

-- Regla de integridad (vale también para consultas manuales): usuario y empresa del mismo estudio.
CREATE OR REPLACE FUNCTION fn_acceso_mismo_estudio() RETURNS trigger AS $$
BEGIN
    IF (SELECT estudio_id FROM usuarios WHERE id = NEW.usuario_id)
       IS DISTINCT FROM (SELECT estudio_id FROM empresas WHERE id = NEW.empresa_id) THEN
        RAISE EXCEPTION 'El usuario y la empresa pertenecen a estudios distintos';
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER trg_acceso_mismo_estudio BEFORE INSERT OR UPDATE ON usuario_empresa
    FOR EACH ROW EXECUTE FUNCTION fn_acceso_mismo_estudio();

-- Un usuario no cambia de estudio si tiene empresas asignadas (lo mismo para una empresa).
CREATE OR REPLACE FUNCTION fn_estudio_fijo() RETURNS trigger AS $$
BEGIN
    IF NEW.estudio_id IS DISTINCT FROM OLD.estudio_id THEN
        IF TG_TABLE_NAME = 'usuarios' AND EXISTS (SELECT 1 FROM usuario_empresa WHERE usuario_id = OLD.id)
           OR TG_TABLE_NAME = 'empresas' AND EXISTS (SELECT 1 FROM usuario_empresa WHERE empresa_id = OLD.id) THEN
            RAISE EXCEPTION 'No se puede cambiar de estudio mientras tenga accesos asignados';
        END IF;
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER trg_estudio_fijo_usuarios BEFORE UPDATE OF estudio_id ON usuarios
    FOR EACH ROW EXECUTE FUNCTION fn_estudio_fijo();
CREATE TRIGGER trg_estudio_fijo_empresas BEFORE UPDATE OF estudio_id ON empresas
    FOR EACH ROW EXECUTE FUNCTION fn_estudio_fijo();

-- 4.5 Estudios: cada uno ve el suyo; el administrador de la plataforma ve y crea todos.
ALTER TABLE estudios ENABLE ROW LEVEL SECURITY;
CREATE POLICY pol_estudios_ver ON estudios FOR SELECT
    USING (id = fn_estudio_actual() OR fn_es_superadmin());
CREATE POLICY pol_estudios_alta ON estudios FOR INSERT
    WITH CHECK (fn_es_superadmin());
CREATE POLICY pol_estudios_cambio ON estudios FOR UPDATE
    USING (fn_es_superadmin() OR (fn_es_admin() AND id = fn_estudio_actual()))
    WITH CHECK (fn_es_superadmin() OR (fn_es_admin() AND id = fn_estudio_actual()));

GRANT SELECT, INSERT ON estudios TO contable_app;
GRANT UPDATE (nombre, ruc) ON estudios TO contable_app;
-- Activar o desactivar un estudio lo decide solo el administrador de la plataforma.
CREATE OR REPLACE FUNCTION fn_estudio_activo_protegido() RETURNS trigger AS $$
BEGIN
    IF NEW.activo IS DISTINCT FROM OLD.activo AND NOT fn_es_superadmin() THEN
        RAISE EXCEPTION 'Solo el administrador de la plataforma activa o desactiva estudios';
    END IF;
    IF NEW.activo IS DISTINCT FROM OLD.activo AND NEW.id = fn_estudio_actual() THEN
        RAISE EXCEPTION 'No podés desactivar tu propio estudio';
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;
GRANT UPDATE (activo) ON estudios TO contable_app;
CREATE TRIGGER trg_estudio_activo BEFORE UPDATE OF activo ON estudios
    FOR EACH ROW WHEN (current_user = 'contable_app')
    EXECUTE FUNCTION fn_estudio_activo_protegido();

-- ---------------------------------------------------------------------
-- 5. Funciones que la aplicación usa sin usuario conectado, o fuera de su estudio
-- ---------------------------------------------------------------------

-- Inicio de sesión: busca por nombre de usuario o email, en cualquier estudio.
CREATE OR REPLACE FUNCTION fn_buscar_login(p_usuario text)
RETURNS TABLE (id bigint, hash_clave text, activo boolean) AS $$
    SELECT u.id, u.hash_clave, u.activo AND s.activo
      FROM usuarios u JOIN estudios s ON s.id = u.estudio_id
     WHERE u.usuario = p_usuario::citext OR u.email = p_usuario::citext
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- ¿Hay algún usuario? (para avisar al arrancar si falta el primer administrador)
CREATE OR REPLACE FUNCTION fn_hay_usuarios() RETURNS boolean AS $$
    SELECT EXISTS (SELECT 1 FROM usuarios)
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- Primer administrador al arrancar: solo actúa si todavía no hay ningún usuario.
CREATE OR REPLACE FUNCTION fn_crear_admin_inicial(p_usuario text, p_email text, p_nombre text,
                                                  p_hash text, p_estudio text)
RETURNS boolean AS $$
DECLARE v_estudio bigint;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('fn_crear_admin_inicial'));
    IF EXISTS (SELECT 1 FROM usuarios) THEN RETURN false; END IF;
    SELECT min(id) INTO v_estudio FROM estudios;
    IF NULLIF(trim(p_estudio), '') IS NOT NULL THEN
        UPDATE estudios SET nombre = trim(p_estudio) WHERE id = v_estudio;
    END IF;
    INSERT INTO usuarios (estudio_id, usuario, email, nombre, hash_clave, es_admin, es_superadmin)
    VALUES (v_estudio, p_usuario, p_email, p_nombre, p_hash, true, true);
    RETURN true;
END $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Alta de un estudio con su primer administrador (solo el administrador de la plataforma).
CREATE OR REPLACE FUNCTION fn_crear_estudio(p_nombre text, p_ruc text, p_usuario text,
                                            p_email text, p_nombre_admin text, p_hash text)
RETURNS bigint AS $$
DECLARE v_estudio bigint;
BEGIN
    IF NOT fn_es_superadmin() THEN
        RAISE EXCEPTION 'Solo el administrador de la plataforma crea estudios';
    END IF;
    INSERT INTO estudios (nombre, ruc) VALUES (trim(p_nombre), NULLIF(trim(p_ruc), ''))
    RETURNING id INTO v_estudio;
    INSERT INTO usuarios (estudio_id, usuario, email, nombre, hash_clave, es_admin)
    VALUES (v_estudio, p_usuario, p_email, p_nombre_admin, p_hash, true);
    RETURN v_estudio;
END $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Resumen de todos los estudios para el administrador de la plataforma (sin datos contables).
CREATE OR REPLACE FUNCTION fn_resumen_estudios()
RETURNS TABLE (id bigint, nombre text, ruc varchar, activo boolean, creado_en timestamptz,
               empresas bigint, usuarios bigint, administradores text) AS $$
    SELECT s.id, s.nombre, s.ruc, s.activo, s.creado_en,
           (SELECT count(*) FROM empresas e WHERE e.estudio_id = s.id AND e.activa),
           (SELECT count(*) FROM usuarios u WHERE u.estudio_id = s.id AND u.activo),
           (SELECT string_agg(u.usuario::text, ', ' ORDER BY u.usuario) FROM usuarios u
             WHERE u.estudio_id = s.id AND u.es_admin AND u.activo)
      FROM estudios s
     WHERE fn_es_superadmin()
     ORDER BY s.nombre
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE EXECUTE ON FUNCTION fn_crear_admin_inicial(text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO contable_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO contable_app;
