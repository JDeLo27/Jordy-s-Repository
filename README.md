# Retoque · Prototipo de Salón & Barbería

Prototipo funcional: perfiles, reserva / reprogramación / cancelación de citas, disponibilidad en tiempo real y panel de administración.

## Arquitectura de datos (2 bases de datos)
| Base de datos | Rol | Qué guarda |
|---|---|---|
| **PostgreSQL** | Datos **persistentes** | clientes, empleados, servicios, productos, citas, detalle_cita, ventas, vista de ingresos |
| **Redis** | Datos **temporales** (con expiración automática) | sesiones de login (24 h), bloqueo del horario mientras se confirma la reserva (5 min), límite de intentos de login (1 min) |

## Cómo ejecutarlo
Requisitos: Node.js 18+ y Docker.
```
docker compose up -d      # levanta PostgreSQL (con schema.sql) y Redis
npm install
npm start                 # http://localhost:3000
```
Sin Docker: instala PostgreSQL y Redis, crea la base `retoque`, ejecuta `schema.sql` y define `DATABASE_URL` / `REDIS_URL` si no usas los valores por defecto.

## Cuentas de prueba
- Administración: `admin@retoque.do` / `admin123`
- Clientes: se crean desde "Entrar → Registrarme".

## Flujo de reserva
1. Elegir profesional → servicios → fecha. Se muestran solo los horarios libres (según citas en PostgreSQL y reservas en curso de otras personas en Redis).
2. Al elegir hora se crea un bloqueo temporal de 5 min en Redis (nadie más puede tomar ese horario).
3. Al confirmar, la cita se guarda en PostgreSQL; un índice único impide duplicados aunque haya concurrencia.

## Fuera de alcance de este prototipo
Pagos, notificaciones (correo/SMS), recuperación de contraseña, horarios y días libres por empleado, y CRUD completo de empleados/servicios/productos desde el panel.
