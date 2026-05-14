'use strict';

const express = require('express');
const db = require('../db');
const auth = require('../middleware/auth');
const { buildCFDI40 } = require('../services/xmlBuilder');
const { timbrarCFDI, listarMetodos } = require('../services/cfdiService');

const router = express.Router();
router.use(auth);

// Listar facturas
router.get('/', async (req, res) => {
  const { empresa_id, estado, desde, hasta, limit = 50, offset = 0 } = req.query;
  try {
    let sql = `
      SELECT f.id, f.empresa_id, f.cliente_id, f.uuid, f.serie, f.folio,
             f.fecha, f.subtotal, f.total, f.moneda, f.tipo_comprobante,
             f.metodo_pago, f.forma_pago, f.uso_cfdi, f.estado,
             f.error_mensaje, f.fecha_timbrado, f.created_at,
             f.total_impuestos_trasladados,
             c.nombre as cliente_nombre, c.rfc as cliente_rfc
      FROM facturas f
      LEFT JOIN clientes c ON f.cliente_id = c.id
      WHERE 1=1
    `;
    const params = [];
    if (empresa_id) { params.push(empresa_id); sql += ` AND f.empresa_id = $${params.length}`; }
    if (estado) { params.push(estado); sql += ` AND f.estado = $${params.length}`; }
    if (desde) { params.push(desde); sql += ` AND f.fecha >= $${params.length}`; }
    if (hasta) { params.push(hasta); sql += ` AND f.fecha <= $${params.length}`; }
    sql += ` ORDER BY f.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const { rows } = await db.query(sql, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Estadísticas para dashboard
router.get('/stats', async (req, res) => {
  const { empresa_id } = req.query;
  try {
    const whereEmpresa = empresa_id ? `AND empresa_id = ${parseInt(empresa_id)}` : '';
    const { rows } = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE estado = 'TIMBRADO') as timbradas,
        COUNT(*) FILTER (WHERE estado = 'CANCELADO') as canceladas,
        COUNT(*) FILTER (WHERE estado = 'ERROR') as con_error,
        COUNT(*) FILTER (WHERE estado = 'TIMBRADO' AND fecha >= NOW() - INTERVAL '30 days') as mes_actual,
        COALESCE(SUM(total) FILTER (WHERE estado = 'TIMBRADO' AND fecha >= NOW() - INTERVAL '30 days'), 0) as monto_mes,
        COALESCE(SUM(total) FILTER (WHERE estado = 'TIMBRADO'), 0) as monto_total
      FROM facturas
      WHERE 1=1 ${whereEmpresa}
    `);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Obtener factura individual
router.get('/:id', async (req, res) => {
  try {
    const { rows: facturas } = await db.query(
      `SELECT f.*, c.nombre as cliente_nombre, c.rfc as cliente_rfc,
              e.nombre as empresa_nombre, e.rfc as empresa_rfc
       FROM facturas f
       LEFT JOIN clientes c ON f.cliente_id = c.id
       LEFT JOIN empresas e ON f.empresa_id = e.id
       WHERE f.id = $1`,
      [req.params.id]
    );
    if (!facturas[0]) return res.status(404).json({ error: 'Factura no encontrada' });

    const { rows: conceptos } = await db.query(
      'SELECT * FROM conceptos_factura WHERE factura_id = $1 ORDER BY id',
      [req.params.id]
    );

    res.json({ ...facturas[0], conceptos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Descargar XML
router.get('/:id/xml', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT uuid, xml_timbrado, xml_cfdi FROM facturas WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Factura no encontrada' });
    const xml = rows[0].xml_timbrado || rows[0].xml_cfdi;
    if (!xml) return res.status(404).json({ error: 'XML no disponible' });
    res.setHeader('Content-Type', 'application/xml');
    res.setHeader('Content-Disposition', `attachment; filename="${rows[0].uuid || 'cfdi'}.xml"`);
    res.send(xml);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Crear y timbrar factura
router.post('/', async (req, res) => {
  const {
    empresa_id, cliente_id, conceptos,
    serie, folio, fecha, forma_pago, metodo_pago, uso_cfdi,
    tipo_comprobante, exportacion, moneda, tipo_cambio,
    condiciones_pago,
  } = req.body;

  if (!empresa_id || !cliente_id || !conceptos?.length) {
    return res.status(400).json({ error: 'empresa_id, cliente_id y al menos un concepto son requeridos' });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // Obtener empresa y cliente
    const { rows: empresas } = await client.query('SELECT * FROM empresas WHERE id = $1', [empresa_id]);
    if (!empresas[0]) return res.status(400).json({ error: 'Empresa no encontrada' });
    const empresa = empresas[0];

    const { rows: clientes } = await client.query('SELECT * FROM clientes WHERE id = $1', [cliente_id]);
    if (!clientes[0]) return res.status(400).json({ error: 'Cliente no encontrado' });
    const cliente = clientes[0];

    // Obtener siguiente folio
    let folioFinal = folio;
    let serieFinal = serie;
    if (!folioFinal) {
      const { rows: serieRows } = await client.query(
        'SELECT * FROM series WHERE empresa_id = $1 AND serie = $2 AND tipo_comprobante = $3 AND activo = true FOR UPDATE',
        [empresa_id, serie || 'A', tipo_comprobante || 'I']
      );
      if (serieRows[0]) {
        folioFinal = String(serieRows[0].folio_actual);
        serieFinal = serieRows[0].serie;
        await client.query(
          'UPDATE series SET folio_actual = folio_actual + 1 WHERE id = $1',
          [serieRows[0].id]
        );
      }
    }

    // Construir XML CFDI 4.0
    const { xml, subtotal, totalIva, total } = buildCFDI40({
      empresa: {
        rfc: empresa.rfc,
        nombre: empresa.nombre,
        regimenFiscal: empresa.regimen_fiscal,
        codigoPostal: empresa.codigo_postal,
      },
      cliente: {
        rfc: cliente.rfc,
        nombre: cliente.nombre,
        regimenFiscal: cliente.regimen_fiscal,
        codigoPostal: cliente.codigo_postal,
        usoCfdiDefault: cliente.uso_cfdi_default,
      },
      conceptos: conceptos.map(c => ({
        claveProdServ: c.clave_prod_serv || '01010101',
        noIdentificacion: c.no_identificacion || null,
        cantidad: parseFloat(c.cantidad),
        claveUnidad: c.clave_unidad || 'E48',
        unidad: c.unidad || null,
        descripcion: c.descripcion,
        valorUnitario: parseFloat(c.valor_unitario),
        descuento: parseFloat(c.descuento || 0),
        objetoImp: c.objeto_imp || '02',
        tasaIva: c.tasa_iva !== undefined ? parseFloat(c.tasa_iva) : 0.16,
      })),
      opciones: {
        serie: serieFinal,
        folio: folioFinal,
        fecha,
        formaPago: forma_pago || '01',
        metodoPago: metodo_pago || 'PUE',
        usoCfdi: uso_cfdi || cliente.uso_cfdi_default || 'G03',
        tipoComprobante: tipo_comprobante || 'I',
        exportacion: exportacion || '01',
        moneda: moneda || 'MXN',
        tipoCambio: tipo_cambio || 1,
        condicionesDePago: condiciones_pago || null,
      },
    });

    // Insertar factura en estado PENDIENTE
    const { rows: facturaRows } = await client.query(
      `INSERT INTO facturas
         (empresa_id, cliente_id, serie, folio, fecha, subtotal, total_impuestos_trasladados,
          total, moneda, tipo_cambio, tipo_comprobante, metodo_pago, forma_pago, uso_cfdi,
          exportacion, lugar_expedicion, condiciones_pago, xml_cfdi, estado)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'PENDIENTE')
       RETURNING *`,
      [empresa_id, cliente_id, serieFinal, folioFinal, fecha || new Date(),
       subtotal, totalIva, total, moneda || 'MXN', tipo_cambio || 1,
       tipo_comprobante || 'I', metodo_pago || 'PUE', forma_pago || '01',
       uso_cfdi || cliente.uso_cfdi_default || 'G03', exportacion || '01',
       empresa.codigo_postal, condiciones_pago || null, xml]
    );
    const factura = facturaRows[0];

    // Insertar conceptos
    for (const c of conceptos) {
      const importe = parseFloat((parseFloat(c.cantidad) * parseFloat(c.valor_unitario)).toFixed(2));
      const tasaIva = c.tasa_iva !== undefined ? parseFloat(c.tasa_iva) : 0.16;
      const ivaImporte = c.objeto_imp === '02' ? parseFloat((importe * tasaIva).toFixed(2)) : 0;

      await client.query(
        `INSERT INTO conceptos_factura
           (factura_id, clave_prod_serv, no_identificacion, cantidad, clave_unidad, unidad,
            descripcion, valor_unitario, importe, descuento, objeto_imp, iva_tasa, iva_importe)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [factura.id, c.clave_prod_serv || '01010101', c.no_identificacion || null,
         c.cantidad, c.clave_unidad || 'E48', c.unidad || null, c.descripcion,
         c.valor_unitario, importe, c.descuento || 0, c.objeto_imp || '02',
         tasaIva, ivaImporte]
      );
    }

    await client.query('COMMIT');

    // Timbrar CFDI
    let timbraResult;
    try {
      timbraResult = await timbrarCFDI(xml);
    } catch (timbraErr) {
      await db.query(
        `UPDATE facturas SET estado = 'ERROR', error_mensaje = $1 WHERE id = $2`,
        [timbraErr.message, factura.id]
      );
      return res.status(422).json({
        error: 'Error al timbrar el CFDI',
        detalle: timbraErr.message,
        factura_id: factura.id,
        xml_generado: xml,
      });
    }

    if (!timbraResult.xmlTimbrado) {
      const errMsg = `Código ${timbraResult.codigo}: ${timbraResult.mensaje}`;
      await db.query(
        `UPDATE facturas SET estado = 'ERROR', error_mensaje = $1 WHERE id = $2`,
        [errMsg, factura.id]
      );
      return res.status(422).json({
        error: 'El servicio de timbrado rechazó el CFDI',
        codigo: timbraResult.codigo,
        mensaje: timbraResult.mensaje,
        factura_id: factura.id,
      });
    }

    // Guardar XML timbrado
    await db.query(
      `UPDATE facturas SET
         estado = 'TIMBRADO', xml_timbrado = $1, uuid = $2,
         fecha_timbrado = NOW()
       WHERE id = $3`,
      [timbraResult.xmlTimbrado, timbraResult.uuid, factura.id]
    );

    res.status(201).json({
      id: factura.id,
      uuid: timbraResult.uuid,
      estado: 'TIMBRADO',
      total,
      xml: timbraResult.xmlTimbrado,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Métodos SOAP disponibles (debug)
router.get('/debug/metodos', async (req, res) => {
  try {
    const metodos = await listarMetodos();
    res.json({ metodos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
