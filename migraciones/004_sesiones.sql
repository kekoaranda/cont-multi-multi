-- Sesiones de los usuarios conectados (las usa connect-pg-simple).
-- Guardarlas en la base permite reiniciar el servidor sin cerrar la sesión de nadie.
CREATE TABLE sesiones (
    sid    varchar PRIMARY KEY,
    sess   json NOT NULL,
    expire timestamp(6) NOT NULL
);
CREATE INDEX ix_sesiones_expire ON sesiones (expire);
GRANT SELECT, INSERT, UPDATE, DELETE ON sesiones TO contable_app;
