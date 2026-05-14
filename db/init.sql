-- Plataforma de Facturación CFDI 4.0
-- Schema de base de datos

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Usuarios del sistema
CREATE TABLE usuarios (
  id SERIAL PRIMARY KEY,
  email VARCHAR(100) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  nombre VARCHAR(200) NOT NULL,
  rol VARCHAR(20) DEFAULT 'admin',
  activo BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Empresas emisoras
CREATE TABLE empresas (
  id SERIAL PRIMARY KEY,
  rfc VARCHAR(13) NOT NULL UNIQUE,
  nombre VARCHAR(300) NOT NULL,
  regimen_fiscal VARCHAR(3) NOT NULL DEFAULT '601',
  codigo_postal VARCHAR(5) NOT NULL,
  telefono VARCHAR(20),
  email VARCHAR(100),
  activo BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Series y folios por tipo de comprobante
CREATE TABLE series (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER REFERENCES empresas(id) ON DELETE CASCADE,
  serie VARCHAR(25),
  tipo_comprobante VARCHAR(1) NOT NULL DEFAULT 'I',
  folio_actual INTEGER DEFAULT 1,
  activo BOOLEAN DEFAULT TRUE,
  UNIQUE(empresa_id, serie, tipo_comprobante)
);

-- Clientes (receptores)
CREATE TABLE clientes (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER REFERENCES empresas(id) ON DELETE CASCADE,
  rfc VARCHAR(13) NOT NULL,
  nombre VARCHAR(300) NOT NULL,
  regimen_fiscal VARCHAR(3) NOT NULL DEFAULT '616',
  codigo_postal VARCHAR(5) NOT NULL,
  email VARCHAR(100),
  telefono VARCHAR(20),
  uso_cfdi_default VARCHAR(3) DEFAULT 'G03',
  activo BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(empresa_id, rfc)
);

-- Catálogo de productos/servicios
CREATE TABLE productos (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER REFERENCES empresas(id) ON DELETE CASCADE,
  clave_interna VARCHAR(50),
  clave_prod_serv VARCHAR(8) NOT NULL DEFAULT '01010101',
  clave_unidad VARCHAR(3) NOT NULL DEFAULT 'E48',
  unidad VARCHAR(80) DEFAULT 'Servicio',
  descripcion VARCHAR(1000) NOT NULL,
  precio_unitario DECIMAL(12,6) NOT NULL,
  objeto_imp VARCHAR(2) DEFAULT '02',
  tasa_iva DECIMAL(5,3) DEFAULT 0.160,
  activo BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Facturas (CFDIs)
CREATE TABLE facturas (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER REFERENCES empresas(id),
  cliente_id INTEGER REFERENCES clientes(id),
  uuid VARCHAR(36) UNIQUE,
  serie VARCHAR(25),
  folio VARCHAR(40),
  fecha TIMESTAMP NOT NULL,
  subtotal DECIMAL(12,2) NOT NULL,
  descuento DECIMAL(12,2) DEFAULT 0,
  total_impuestos_trasladados DECIMAL(12,2) DEFAULT 0,
  total_impuestos_retenidos DECIMAL(12,2) DEFAULT 0,
  total DECIMAL(12,2) NOT NULL,
  moneda VARCHAR(3) DEFAULT 'MXN',
  tipo_cambio DECIMAL(10,4) DEFAULT 1,
  tipo_comprobante VARCHAR(1) DEFAULT 'I',
  metodo_pago VARCHAR(3) DEFAULT 'PUE',
  forma_pago VARCHAR(2) DEFAULT '01',
  uso_cfdi VARCHAR(3) DEFAULT 'G03',
  exportacion VARCHAR(2) DEFAULT '01',
  lugar_expedicion VARCHAR(5) NOT NULL,
  condiciones_pago VARCHAR(1000),
  xml_cfdi TEXT,
  xml_timbrado TEXT,
  estado VARCHAR(20) DEFAULT 'PENDIENTE',
  error_mensaje TEXT,
  fecha_timbrado TIMESTAMP,
  no_certificado_sat VARCHAR(40),
  sello_sat TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Conceptos de facturas
CREATE TABLE conceptos_factura (
  id SERIAL PRIMARY KEY,
  factura_id INTEGER REFERENCES facturas(id) ON DELETE CASCADE,
  clave_prod_serv VARCHAR(8) NOT NULL,
  no_identificacion VARCHAR(100),
  cantidad DECIMAL(12,3) NOT NULL,
  clave_unidad VARCHAR(3) NOT NULL,
  unidad VARCHAR(80),
  descripcion VARCHAR(1000) NOT NULL,
  valor_unitario DECIMAL(12,6) NOT NULL,
  importe DECIMAL(12,2) NOT NULL,
  descuento DECIMAL(12,2) DEFAULT 0,
  objeto_imp VARCHAR(2) DEFAULT '02',
  iva_tasa DECIMAL(5,3) DEFAULT 0.160,
  iva_importe DECIMAL(12,2) DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Ventas (multiproducto)
CREATE TABLE ventas (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER REFERENCES empresas(id),
  folio_venta VARCHAR(50) UNIQUE NOT NULL,
  fecha_venta TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  estacion VARCHAR(100),
  bomba VARCHAR(20),
  tipo_combustible VARCHAR(50),
  litros NUMERIC(10,3),
  precio_unitario NUMERIC(10,4),
  subtotal NUMERIC(10,2) NOT NULL,
  iva NUMERIC(10,2) NOT NULL,
  total NUMERIC(10,2) NOT NULL,
  referencia VARCHAR(100),
  placa VARCHAR(20),
  estado VARCHAR(20) DEFAULT 'PENDIENTE',
  factura_id INTEGER REFERENCES facturas(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_ventas_folio ON ventas(folio_venta);
CREATE INDEX idx_ventas_empresa ON ventas(empresa_id);
CREATE INDEX idx_ventas_estado ON ventas(estado);

-- Conceptos de ventas (multiproducto)
CREATE TABLE conceptos_venta (
  id SERIAL PRIMARY KEY,
  venta_id INTEGER NOT NULL REFERENCES ventas(id) ON DELETE CASCADE,
  producto_id INTEGER REFERENCES productos(id) ON DELETE SET NULL,
  clave_prod_serv VARCHAR(8) NOT NULL DEFAULT '01010101',
  clave_unidad VARCHAR(3) NOT NULL DEFAULT 'E48',
  unidad VARCHAR(80) NOT NULL DEFAULT 'Servicio',
  descripcion VARCHAR(1000) NOT NULL,
  cantidad NUMERIC(12,3) NOT NULL,
  precio_unitario NUMERIC(12,6) NOT NULL,
  descuento NUMERIC(12,2) NOT NULL DEFAULT 0,
  subtotal NUMERIC(12,2) NOT NULL,
  objeto_imp VARCHAR(2) NOT NULL DEFAULT '02',
  tasa_iva NUMERIC(5,3) NOT NULL DEFAULT 0.160,
  iva_importe NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_conceptos_venta_venta ON conceptos_venta(venta_id);

-- Índices
CREATE INDEX idx_facturas_empresa ON facturas(empresa_id);
CREATE INDEX idx_facturas_estado ON facturas(estado);
CREATE INDEX idx_facturas_fecha ON facturas(fecha);
CREATE INDEX idx_clientes_empresa ON clientes(empresa_id);
CREATE INDEX idx_productos_empresa ON productos(empresa_id);

-- Usuario admin por defecto (password: Admin123!)
INSERT INTO usuarios (email, password_hash, nombre, rol)
VALUES (
  'admin@facturacion.mx',
  '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi',
  'Administrador',
  'admin'
);

-- Empresa de prueba
INSERT INTO empresas (rfc, nombre, regimen_fiscal, codigo_postal, email)
VALUES (
  'EKU9003173C9',
  'ESCUELA KEMPER URGATE SA DE CV',
  '601',
  '01030',
  'contacto@empresa.mx'
);

-- Serie por defecto
INSERT INTO series (empresa_id, serie, tipo_comprobante, folio_actual)
VALUES (1, 'A', 'I', 1);

-- Clientes de prueba
INSERT INTO clientes (empresa_id, rfc, nombre, regimen_fiscal, codigo_postal, email, uso_cfdi_default)
VALUES
  (1, 'XAXX010101000', 'PUBLICO EN GENERAL', '616', '01030', '', 'S01'),
  (1, 'AAA010101AAA', 'CLIENTE PRUEBA SA DE CV', '601', '06600', 'cliente@prueba.mx', 'G03');

-- Productos de prueba
INSERT INTO productos (empresa_id, clave_interna, clave_prod_serv, clave_unidad, unidad, descripcion, precio_unitario, objeto_imp, tasa_iva)
VALUES
  (1, 'SERV-001', '84101500', 'E48', 'Servicio', 'Servicios de consultoría', 1000.00, '02', 0.160),
  (1, 'PROD-001', '43232401', 'H87', 'Pieza', 'Software de administración', 5000.00, '02', 0.160),
  (1, 'SERV-002', '80141600', 'E48', 'Servicio', 'Desarrollo de software', 2500.00, '02', 0.160);

-- Configuración por empresa (webhook, integraciones)
CREATE TABLE IF NOT EXISTS configuracion (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER REFERENCES empresas(id) ON DELETE CASCADE,
  clave VARCHAR(100) NOT NULL,
  valor TEXT,
  UNIQUE(empresa_id, clave)
);
CREATE INDEX IF NOT EXISTS idx_config_empresa ON configuracion(empresa_id);

INSERT INTO configuracion (empresa_id, clave, valor) VALUES
  (1, 'webhook_enabled', 'false'),
  (1, 'webhook_token', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
ON CONFLICT (empresa_id, clave) DO NOTHING;
