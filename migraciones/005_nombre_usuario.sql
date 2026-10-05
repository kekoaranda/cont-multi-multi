-- Inicio de sesión con nombre de usuario (por ejemplo "nelson") además del email.
ALTER TABLE usuarios ADD COLUMN usuario citext;

-- A los usuarios existentes se les asigna la parte del email antes de la @,
-- con un número al final si se repite. Después se puede cambiar.
UPDATE usuarios u
   SET usuario = sub.nuevo
  FROM (
    SELECT id,
           CASE WHEN length(base) < 3 THEN 'usuario' || id
                WHEN row_number() OVER (PARTITION BY base ORDER BY id) > 1
                     THEN base || row_number() OVER (PARTITION BY base ORDER BY id)
                ELSE base END AS nuevo
      FROM (SELECT id, left(lower(regexp_replace(split_part(email::text, '@', 1), '[^a-zA-Z0-9._-]', '', 'g')), 27) AS base
              FROM usuarios) t
  ) sub
 WHERE u.id = sub.id;

ALTER TABLE usuarios ALTER COLUMN usuario SET NOT NULL;
ALTER TABLE usuarios ADD CONSTRAINT uq_usuarios_usuario UNIQUE (usuario);
-- Minúsculas, números, punto, guion y guion bajo; entre 3 y 30 caracteres.
ALTER TABLE usuarios ADD CONSTRAINT ck_usuarios_usuario CHECK (usuario::text ~ '^[a-z0-9._-]{3,30}$');
