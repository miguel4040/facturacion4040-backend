'use strict';

/**
 * Webhook público para solicitudes de facturación desde terceros.
 * Compatible con WhatsApp Business API (Meta/360dialog/Twilio),
 * n8n, Make (Integromat), Zapier, o cualquier HTTP POST.
 *
 * Autenticación: token en header X-Webhook-Token, query ?token=, o body.token
 * El webhook debe estar habilitado en Configuración antes de usarse.
 */

const express = require('express');
const db = require('../db');
const { buildCFDI40 } = require('../services/xmlBuilder');
const { timbrarCFDI } = require('../services/cfdiService');

const router = express.Router();

// ── Helper: validar token y estado del webhook ─────────────────────────────
async function resolveWebhook(req) {
  const token =
    req.headers['x-webhook-token'] ||
    req.query.token ||
    req.body?.token ||
    null;

  if (!token) return { error: 'Token requerido (header X-Webhook-Token, query ?token= o body.token)', status: 401 };

  const { rows } = await db.query(
    `SELECT c1.valor as enabled, c2.valor as stored_token, e.id as empresa_id, e.rfc, e.nombre,
            e.regimen_fiscal, e.codigo_postal
     FROM configuracion c1
     JOIN configuracion c2 ON c1.empresa_id = c2.empresa_id AND c2.clave = 'webhook_token'
     JOIN empresas e ON e.id = c1.empresa_id
     WHERE c1.clave = 'webhook_enabled' AND c2.valor = $1`,
    [token]
  );

  if (!rows[0]) return { error: 'Token inválido', status: 401 };
  if (rows[0].enabled !== 'true') return { error: 'Webhook deshabilitado. Actívalo en Configuración.', status: 403 };

  return { empresa: rows[0] };
}

// ── Helper: crear factura desde datos de venta ─────────────────────────────
async function facturarVenta(venta, receptor, empresa) {
  const litros = parseFloat(venta.litros);
  const precioUnit = parseFloat(venta.precio_unitario);
  const subtotal = parseFloat(venta.subtotal);
  const ivaImporte = parseFloat(venta.iva);
  const total = parseFloat(venta.total);

  const { xml } = buildCFDI40({
    empresa: {
      rfc: empresa.rfc,
      nombre: empresa.nombre,
      regimenFiscal: empresa.regimen_fiscal,
      codigoPostal: empresa.codigo_postal,
    },
    cliente: {
      rfc: receptor.rfc,
      nombre: receptor.nombre,
      regimenFiscal: receptor.regimen_fiscal,
      codigoPostal: receptor.codigo_postal,
      usoCfdiDefault: receptor.uso_cfdi || 'G03',
    },
    conceptos: [{
      claveProdServ: '15101514',
      cantidad: litros,
      claveUnidad: 'LTR',
      unidad: 'Litro',
      descripcion: `${venta.tipo_combustible} - Folio ${venta.folio_venta}`,
      valorUnitario: precioUnit,
      descuento: 0,
      objetoImp: '02',
      tasaIva: 0.16,
    }],
    opciones: {
      serie: 'W',
      fecha: venta.fecha_venta,
      formaPago: receptor.forma_pago || '01',
      metodoPago: 'PUE',
      usoCfdi: receptor.uso_cfdi || 'G03',
      tipoComprobante: 'I',
      exportacion: '01',
      moneda: 'MXN',
    },
  });

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // Buscar o crear cliente
    const { rows: found } = await client.query(
      'SELECT id FROM clientes WHERE empresa_id=$1 AND rfc=$2',
      [empresa.empresa_id, receptor.rfc]
    );
    let clienteId = found[0]?.id;
    if (!clienteId) {
      const { rows: nc } = await client.query(
        `INSERT INTO clientes (empresa_id, rfc, nombre, regimen_fiscal, codigo_postal, email, uso_cfdi_default)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [empresa.empresa_id, receptor.rfc, receptor.nombre, receptor.regimen_fiscal,
         receptor.codigo_postal, receptor.email || '', receptor.uso_cfdi || 'G03']
      );
      clienteId = nc[0].id;
    }

    // Serie W para webhook
    const { rows: series } = await client.query(
      `SELECT * FROM series WHERE empresa_id=$1 AND serie='W' AND tipo_comprobante='I' FOR UPDATE`,
      [empresa.empresa_id]
    );
    let folio = '1';
    if (series.length) {
      folio = String(series[0].folio_actual);
      await client.query('UPDATE series SET folio_actual=folio_actual+1 WHERE id=$1', [series[0].id]);
    } else {
      await client.query(
        `INSERT INTO series (empresa_id, serie, tipo_comprobante, folio_actual) VALUES ($1,'W','I',2)`,
        [empresa.empresa_id]
      );
    }

    const { rows: factRows } = await client.query(
      `INSERT INTO facturas
         (empresa_id, cliente_id, serie, folio, fecha, subtotal, total_impuestos_trasladados,
          total, moneda, tipo_cambio, tipo_comprobante, metodo_pago, forma_pago, uso_cfdi,
          exportacion, lugar_expedicion, xml_cfdi, estado)
       VALUES ($1,$2,'W',$3,$4,$5,$6,$7,'MXN',1,'I','PUE',$8,$9,'01',$10,$11,'PENDIENTE')
       RETURNING *`,
      [empresa.empresa_id, clienteId, folio, venta.fecha_venta,
       subtotal, ivaImporte, total,
       receptor.forma_pago || '01', receptor.uso_cfdi || 'G03',
       empresa.codigo_postal, xml]
    );
    const factura = factRows[0];

    await client.query(
      `INSERT INTO conceptos_factura
         (factura_id, clave_prod_serv, cantidad, clave_unidad, unidad, descripcion,
          valor_unitario, importe, descuento, objeto_imp, iva_tasa, iva_importe)
       VALUES ($1,'15101514',$2,'LTR','Litro',$3,$4,$5,0,'02',0.16,$6)`,
      [factura.id, litros, `${venta.tipo_combustible} - Folio ${venta.folio_venta}`,
       precioUnit, subtotal, ivaImporte]
    );

    await client.query('COMMIT');

    const timbrado = await timbrarCFDI(xml);

    await db.query(
      `UPDATE facturas SET estado='TIMBRADO', xml_timbrado=$1, uuid=$2, fecha_timbrado=NOW() WHERE id=$3`,
      [timbrado.xmlTimbrado, timbrado.uuid, factura.id]
    );
    await db.query(
      `UPDATE ventas SET estado='FACTURADO', factura_id=$1 WHERE id=$2`,
      [factura.id, venta.id]
    );

    return { factura_id: factura.id, uuid: timbrado.uuid, xml_timbrado: timbrado.xmlTimbrado };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── POST /api/webhook/facturar ─────────────────────────────────────────────
//
// Body esperado:
// {
//   "folio_venta": "T-2026-005",   ← folio del ticket (o venta_id numérico)
//   "venta_id": 5,                 ← alternativa al folio
//   "rfc": "XAXX010101000",
//   "nombre": "PUBLICO EN GENERAL",
//   "regimen_fiscal": "616",
//   "codigo_postal": "01030",
//   "uso_cfdi": "S01",
//   "forma_pago": "01",            ← opcional
//   "email": "cliente@email.com",  ← opcional
//   "token": "abc..."              ← alternativa al header
// }
router.post('/facturar', async (req, res) => {
  try {
    const auth = await resolveWebhook(req);
    if (auth.error) return res.status(auth.status).json({ error: auth.error });
    const { empresa } = auth;

    const {
      folio_venta, venta_id,
      rfc, nombre, regimen_fiscal, codigo_postal,
      uso_cfdi = 'G03', forma_pago = '01', email = '',
    } = req.body;

    if (!rfc || !nombre || !regimen_fiscal || !codigo_postal) {
      return res.status(400).json({
        error: 'Campos requeridos: rfc, nombre, regimen_fiscal, codigo_postal',
        ejemplo: {
          folio_venta: 'T-2026-005',
          rfc: 'XAXX010101000',
          nombre: 'PUBLICO EN GENERAL',
          regimen_fiscal: '616',
          codigo_postal: '06600',
          uso_cfdi: 'S01',
        },
      });
    }
    if (!folio_venta && !venta_id) {
      return res.status(400).json({ error: 'Se requiere folio_venta o venta_id' });
    }

    // Buscar la venta
    let ventaQuery, ventaParams;
    if (venta_id) {
      ventaQuery = 'SELECT * FROM ventas WHERE id=$1 AND empresa_id=$2';
      ventaParams = [venta_id, empresa.empresa_id];
    } else {
      ventaQuery = 'SELECT * FROM ventas WHERE folio_venta=$1 AND empresa_id=$2';
      ventaParams = [folio_venta, empresa.empresa_id];
    }
    const { rows: ventas } = await db.query(ventaQuery, ventaParams);
    if (!ventas[0]) {
      return res.status(404).json({
        error: 'Venta no encontrada',
        folio_buscado: folio_venta || null,
        id_buscado: venta_id || null,
      });
    }
    const venta = ventas[0];

    if (venta.estado !== 'PENDIENTE') {
      return res.status(409).json({
        error: `No se puede facturar: la venta está en estado ${venta.estado}`,
        estado: venta.estado,
        folio_venta: venta.folio_venta,
        factura_uuid: venta.factura_id ? 'ver /api/facturas/' + venta.factura_id : null,
      });
    }

    const receptor = {
      rfc: rfc.trim().toUpperCase(),
      nombre: nombre.trim(),
      regimen_fiscal: regimen_fiscal.trim(),
      codigo_postal: codigo_postal.trim(),
      uso_cfdi, forma_pago, email,
    };

    const result = await facturarVenta(venta, receptor, empresa);

    res.status(201).json({
      ok: true,
      folio_venta: venta.folio_venta,
      factura_id: result.factura_id,
      uuid: result.uuid,
      total: parseFloat(venta.total),
      xml_timbrado: result.xml_timbrado,
      mensaje: `Factura generada correctamente. UUID: ${result.uuid}`,
    });

  } catch (err) {
    console.error('[WEBHOOK]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/webhook/cfdi/buscar — localiza un CFDI ya timbrado por folio o UUID
router.post('/cfdi/buscar', async (req, res) => {
  try {
    const auth = await resolveWebhook(req);
    if (auth.error) return res.status(auth.status).json({ error: auth.error });

    const { folio_venta, uuid, rfc } = req.body;
    if (!folio_venta && !uuid) {
      return res.status(400).json({ error: 'Se requiere folio_venta o uuid' });
    }

    let query, params;
    if (uuid) {
      query = `SELECT f.id, f.uuid, f.serie, f.folio, f.fecha, f.total,
                      v.folio_venta, cl.rfc, cl.nombre
               FROM facturas f
               LEFT JOIN ventas v ON v.factura_id = f.id
               LEFT JOIN clientes cl ON cl.id = f.cliente_id
               WHERE f.uuid = $1 AND f.empresa_id = $2 AND f.estado = 'TIMBRADO'`;
      params = [uuid.trim().toUpperCase(), auth.empresa.empresa_id];
    } else {
      query = `SELECT f.id, f.uuid, f.serie, f.folio, f.fecha, f.total,
                      v.folio_venta, cl.rfc, cl.nombre
               FROM facturas f
               LEFT JOIN ventas v ON v.factura_id = f.id
               LEFT JOIN clientes cl ON cl.id = f.cliente_id
               WHERE v.folio_venta = $1 AND f.empresa_id = $2 AND f.estado = 'TIMBRADO'`;
      params = [folio_venta.trim(), auth.empresa.empresa_id];
    }

    const { rows } = await db.query(query, params);
    if (!rows[0]) {
      return res.status(404).json({ error: 'No se encontró ningún CFDI timbrado para ese folio' });
    }

    const f = rows[0];

    if (rfc && f.rfc && f.rfc.toUpperCase() !== rfc.trim().toUpperCase()) {
      return res.status(403).json({ error: 'El RFC no coincide con el receptor de la factura' });
    }

    return res.json({
      ok: true,
      uuid: f.uuid,
      folio_cfdi: `${f.serie || ''}${f.folio || ''}`,
      folio_venta: f.folio_venta,
      fecha: f.fecha,
      total: parseFloat(f.total),
      rfc: f.rfc,
      nombre: f.nombre,
      download_url: `https://facturas.empresasinteligentes.ai/api/webhook/cfdi/${f.uuid}`,
    });
  } catch (err) {
    console.error('[WEBHOOK buscar]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/webhook/ping — verificar que el webhook está activo
router.get('/ping', async (req, res) => {
  try {
    const auth = await resolveWebhook(req);
    if (auth.error) return res.status(auth.status).json({ error: auth.error });
    res.json({
      ok: true,
      mensaje: 'Webhook activo',
      empresa: auth.empresa.nombre,
      rfc: auth.empresa.rfc,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/webhook/cfdi/:uuid — descarga pública del XML timbrado (UUID como auth implícita)
router.get('/cfdi/:uuid', async (req, res) => {
  try {
    const { uuid } = req.params;
    if (!uuid || uuid.length < 30) return res.status(400).json({ error: 'UUID inválido' });

    const { rows } = await db.query(
      `SELECT xml_timbrado, uuid, serie, folio FROM facturas WHERE uuid=$1 AND estado='TIMBRADO'`,
      [uuid]
    );
    if (!rows[0]) return res.status(404).json({ error: 'CFDI no encontrado' });

    const filename = `CFDI_${rows[0].serie || ''}${rows[0].folio}_${uuid}.xml`;
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(rows[0].xml_timbrado);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
