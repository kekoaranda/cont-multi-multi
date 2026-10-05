-- Rol con el que se conecta la aplicación: no es dueño de las tablas
-- y no puede saltarse la seguridad por fila (RLS).
-- La clave la asigna src/migrar.js con el valor de DB_APP_PASSWORD.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'contable_app') THEN
        CREATE ROLE contable_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
    END IF;
END $$;

GRANT USAGE ON SCHEMA public TO contable_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO contable_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO contable_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO contable_app;

-- La auditoría es de solo agregado.
REVOKE UPDATE, DELETE ON auditoria FROM contable_app;
-- La plantilla del plan de cuentas la mantiene el administrador.
REVOKE INSERT, UPDATE, DELETE ON plantilla_cuentas FROM contable_app;
-- El historial de migraciones no es asunto de la aplicación.
REVOKE ALL ON migraciones FROM contable_app;
