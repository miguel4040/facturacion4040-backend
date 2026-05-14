'use strict';

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const config = require('./config/config');
const initDb = require('./db/initDb');

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve frontend static files
app.use(express.static(path.join(__dirname, '../frontend')));

// API routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/empresas', require('./routes/empresas'));
app.use('/api/clientes', require('./routes/clientes'));
app.use('/api/productos', require('./routes/productos'));
app.use('/api/facturas', require('./routes/facturas'));
app.use('/api/ventas', require('./routes/ventas'));
app.use('/api/config', require('./routes/config'));
app.use('/api/webhook', require('./routes/webhook'));

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    env: config.cfdi.env,
    timbradoUrl: config.cfdi.timbradoUrl,
    csd: {
      rfc: config.cfdi.csd.rfc,
      cerPath: config.cfdi.csd.cerPath,
      mockMode: config.cfdi.env === 'test' && !!config.cfdi.csd.cerPath,
    },
  });
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

async function start() {
  await initDb();

  app.listen(config.port, () => {
    console.log(`\n🚀 Facturación CFDI 4.0`);
    console.log(`   Puerto: ${config.port}`);
    console.log(`   Modo: ${config.cfdi.env === 'test' ? '🧪 PRUEBA' : '🏭 PRODUCCIÓN'}`);
    console.log(`   Timbrado: ${config.cfdi.timbradoUrl}`);
    console.log(`   DB: ${config.db.host}:${config.db.port}/${config.db.database}`);
    console.log(`\n   Accede en: http://localhost:${config.port}\n`);
  });
}

start().catch(err => {
  console.error('Error al iniciar:', err.message);
  process.exit(1);
});
