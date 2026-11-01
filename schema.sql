-- Retoque · Base de datos PERSISTENTE (PostgreSQL)
CREATE TYPE area_negocio AS ENUM ('Salón', 'Barbería');
CREATE TYPE estado_cita  AS ENUM ('Programada', 'Completada', 'Cancelada');

CREATE TABLE clientes (
    id_cliente     INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    nombre         VARCHAR(60)  NOT NULL,
    apellido       VARCHAR(60)  NOT NULL,
    telefono       VARCHAR(15)  NOT NULL UNIQUE,
    email          VARCHAR(100) NOT NULL UNIQUE,
    password_hash  TEXT NOT NULL,
    preferencias   VARCHAR(255),
    es_admin       BOOLEAN NOT NULL DEFAULT FALSE,
    fecha_registro DATE NOT NULL DEFAULT CURRENT_DATE
);
CREATE TABLE empleados (
    id_empleado  INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    nombre       VARCHAR(60) NOT NULL,
    apellido     VARCHAR(60) NOT NULL,
    telefono     VARCHAR(15),
    area         area_negocio NOT NULL,
    especialidad VARCHAR(80),
    activo       BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE TABLE servicios (
    id_servicio  INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    nombre       VARCHAR(80) NOT NULL UNIQUE,
    area         area_negocio NOT NULL,
    precio       NUMERIC(10,2) NOT NULL CHECK (precio > 0),
    duracion_min SMALLINT NOT NULL CHECK (duracion_min > 0)
);
CREATE TABLE productos (
    id_producto INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    nombre      VARCHAR(80) NOT NULL UNIQUE,
    precio      NUMERIC(10,2) NOT NULL CHECK (precio > 0),
    stock       INT NOT NULL DEFAULT 0 CHECK (stock >= 0)
);
CREATE TABLE citas (
    id_cita     INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    id_cliente  INT NOT NULL REFERENCES clientes(id_cliente)   ON UPDATE CASCADE,
    id_empleado INT NOT NULL REFERENCES empleados(id_empleado) ON UPDATE CASCADE,
    fecha       DATE NOT NULL,
    hora        TIME NOT NULL,
    estado      estado_cita NOT NULL DEFAULT 'Programada'
);
-- Evita citas duplicadas por empleado/fecha/hora (las canceladas liberan el horario)
CREATE UNIQUE INDEX ux_cita_activa ON citas (id_empleado, fecha, hora) WHERE estado <> 'Cancelada';
CREATE TABLE detalle_cita (
    id_cita        INT NOT NULL REFERENCES citas(id_cita) ON DELETE CASCADE,
    id_servicio    INT NOT NULL REFERENCES servicios(id_servicio),
    precio_cobrado NUMERIC(10,2) NOT NULL,
    PRIMARY KEY (id_cita, id_servicio)
);
CREATE TABLE ventas_producto (
    id_venta    INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    id_cliente  INT REFERENCES clientes(id_cliente) ON DELETE SET NULL,
    id_producto INT NOT NULL REFERENCES productos(id_producto),
    cantidad    INT NOT NULL CHECK (cantidad > 0),
    fecha       DATE NOT NULL DEFAULT CURRENT_DATE
);
CREATE VIEW v_ingresos AS
SELECT c.fecha, 'Servicio' AS tipo, SUM(d.precio_cobrado) AS monto
FROM citas c JOIN detalle_cita d ON d.id_cita = c.id_cita WHERE c.estado = 'Completada' GROUP BY c.fecha
UNION ALL
SELECT v.fecha, 'Producto', SUM(v.cantidad * p.precio)
FROM ventas_producto v JOIN productos p ON p.id_producto = v.id_producto GROUP BY v.fecha;

INSERT INTO empleados (nombre, apellido, telefono, area, especialidad) VALUES
('Rosa','Díaz','809-555-0201','Salón','Colorimetría'),
('Elena','Cruz','809-555-0202','Salón','Manicura y uñas'),
('Pedro','Almonte','809-555-0203','Barbería','Degradados'),
('Miguel','Santana','809-555-0204','Barbería','Barba y afeitado');
INSERT INTO servicios (nombre, area, precio, duracion_min) VALUES
('Corte de dama','Salón',600,45),('Tinte','Salón',1800,120),('Manicura','Salón',500,40),
('Corte de caballero','Barbería',350,30),('Arreglo de barba','Barbería',250,30),('Afeitado clásico','Barbería',300,30);
INSERT INTO productos (nombre, precio, stock) VALUES
('Shampoo reparador',450,20),('Cera para cabello',300,15),('Aceite para barba',380,10);
