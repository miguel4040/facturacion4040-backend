'use strict';

/**
 * Servicio de timbrado CFDI usando Forsedi.
 * Firma el XML localmente con el CSD antes de enviarlo (TimbrarCFDI con sello).
 *
 * Estructura real del WSDL (xsd=2):
 *   TimbrarCFDIV2 / TimbrarCFDI:
 *     - accesos: { password, usuario }
 *     - comprobante: string (XML)
 *   Respuesta (acuseCFDI):
 *     - codigoError, error, xmlTimbrado, pathXML
 */

const https = require('https');
const http = require('http');
const { randomUUID } = require('crypto');
const config = require('../config/config');
const { signCFDI } = require('./xmlSigner');

const WS_NAMESPACE = 'http://wservicios/';

function buildEnvelope(method, usuario, password, comprobante) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope
  xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:wser="${WS_NAMESPACE}">
  <soapenv:Header/>
  <soapenv:Body>
    <wser:${method}>
      <accesos>
        <password>${escXml(password)}</password>
        <usuario>${escXml(usuario)}</usuario>
      </accesos>
      <comprobante><![CDATA[${comprobante}]]></comprobante>
    </wser:${method}>
  </soapenv:Body>
</soapenv:Envelope>`;
}

function escXml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function soapPost(endpointUrl, soapAction, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpointUrl);
    const isHttps = url.protocol === 'https:';
    const bodyBytes = Buffer.from(body, 'utf-8');

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + (url.search || ''),
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': '""',
        'Content-Length': bodyBytes.length,
      },
      rejectUnauthorized: false,
    };

    const transport = isHttps ? https : http;
    const req = transport.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString('utf-8') }));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout conectando al servicio de timbrado')); });
    req.write(bodyBytes);
    req.end();
  });
}

function extractTag(xml, ...tags) {
  for (const tag of tags) {
    const re = new RegExp(`<(?:[^:>]+:)?${tag}>([\\s\\S]*?)<\\/(?:[^:>]+:)?${tag}>`, 'i');
    const m = xml.match(re);
    if (m) return m[1].trim();
  }
  return null;
}

function parseResponse(xml) {
  const xmlTimbrado = extractTag(xml, 'xmlTimbrado', 'XMLTimbrado');
  const codigoError = extractTag(xml, 'codigoError', 'CodigoError', 'Codigo', 'codigo');
  const error = extractTag(xml, 'error', 'Error', 'Mensaje', 'mensaje', 'faultstring');

  let uuid = null;
  if (xmlTimbrado) {
    const m = xmlTimbrado.match(/UUID="([^"]+)"/i);
    if (m) uuid = m[1];
  }

  return { xmlTimbrado, uuid, codigoError, error };
}

function mockTimbrado(signedXml, noCertificado, sello) {
  const uuid = randomUUID().toUpperCase();
  const now = new Date();
  const offsetMs = -6 * 60 * 60 * 1000;
  const mx = new Date(now.getTime() + offsetMs);
  const fechaTimbrado = mx.toISOString().slice(0, 19);

  const tfd = `<tfd:TimbreFiscalDigital `
    + `xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" `
    + `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" `
    + `xsi:schemaLocation="http://www.sat.gob.mx/TimbreFiscalDigital http://www.sat.gob.mx/sitio_internet/cfd/TimbreFiscalDigital/TimbreFiscalDigitalv11.xsd" `
    + `Version="1.1" `
    + `UUID="${uuid}" `
    + `FechaTimbrado="${fechaTimbrado}" `
    + `RfcProvCertif="SAT970701NN3" `
    + `NoCertificadoSAT="00001000000504465028" `
    + `SelloCFD="${sello}" `
    + `SelloSAT="MOCK_SELLO_SAT_PRUEBA" `
    + `NoCertificado="${noCertificado}"/>`;

  const xmlTimbrado = signedXml.replace(
    '</cfdi:Comprobante>',
    `  <cfdi:Complemento>\n    ${tfd}\n  </cfdi:Complemento>\n</cfdi:Comprobante>`
  );

  console.log(`[MOCK] Timbrado simulado UUID=${uuid}`);
  return { xmlTimbrado, uuid, codigoError: null, error: null };
}

async function timbrarCFDI(xmlCFDI) {
  const wsdlUrl = config.cfdi.timbradoUrl;
  const endpoint = wsdlUrl.replace('?wsdl', '');
  const usuario = config.cfdi.username;
  const password = config.cfdi.password;
  const csd = config.cfdi.csd;

  // Firmar el XML localmente si tenemos CSD configurado
  let xmlToSend = xmlCFDI;
  let selloResult = '';
  let noCertificadoResult = '';
  if (csd.cerPath && csd.keyPath) {
    try {
      console.log(`[CFDI] Firmando XML con CSD: ${csd.rfc}`);
      const result = signCFDI(xmlCFDI, csd.cerPath, csd.keyPath, csd.password);
      xmlToSend = result.signedXml;
      selloResult = result.sello;
      noCertificadoResult = result.noCertificado;
      console.log('[CFDI] XML firmado correctamente');
    } catch (signErr) {
      throw new Error(`Error al firmar el CFDI: ${signErr.message}`);
    }
  }

  // En modo de prueba con CSD firmado, usar mock timbrado (el servicio Forsedi test
  // no acepta los CSD de prueba del SAT contra el registro real de RFCs)
  if (config.cfdi.env === 'test' && csd.cerPath && selloResult) {
    return mockTimbrado(xmlToSend, noCertificadoResult, selloResult);
  }

  // TimbrarCFDI = con sello (XML ya firmado)
  // TimbrarCFDIV2 = sin sello (requiere CSD registrado en Admin Digital)
  const methods = csd.cerPath ? ['TimbrarCFDI', 'TimbrarCFDIV2'] : ['TimbrarCFDIV2', 'TimbrarCFDI'];

  let lastRaw = '';
  let lastError;

  for (const method of methods) {
    const action = `${WS_NAMESPACE}${method}`;
    console.log(`[CFDI] ${method} → ${endpoint}`);

    try {
      const envelope = buildEnvelope(method, usuario, password, xmlToSend);
      const { statusCode, body } = await soapPost(endpoint, action, envelope);
      lastRaw = body;
      console.log(`[CFDI] HTTP ${statusCode}`);

      if (statusCode >= 400) {
        lastError = new Error(`HTTP ${statusCode}`);
        continue;
      }

      const parsed = parseResponse(body);

      // Éxito: tenemos XML timbrado
      if (parsed.xmlTimbrado) return parsed;

      // Error del SAT/servicio
      const errMsg = parsed.error || parsed.codigoError || 'Sin respuesta de timbrado';
      lastError = new Error(`${parsed.codigoError ? `[${parsed.codigoError}] ` : ''}${errMsg}`);
      console.warn(`[CFDI] ${method} rechazado:`, lastError.message);

      // Si es un error de contenido (no de método), no intentar el siguiente
      if (parsed.codigoError && parsed.codigoError !== '') break;

    } catch (err) {
      lastError = err;
      console.warn(`[CFDI] Error con ${method}:`, err.message);
    }
  }

  throw new Error(
    lastError?.message || 'Error desconocido al timbrar' +
    (lastRaw ? `\n\nRespuesta:\n${lastRaw.substring(0, 400)}` : '')
  );
}

async function listarMetodos() {
  const wsdlUrl = config.cfdi.timbradoUrl;
  const url = new URL(wsdlUrl);
  const isHttps = url.protocol === 'https:';

  const wsdl = await new Promise((resolve, reject) => {
    const transport = isHttps ? https : http;
    const req = transport.get({
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + '?wsdl',
      rejectUnauthorized: false,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
  });

  const ops = [...wsdl.matchAll(/<(?:wsdl:)?operation\s+name="([^"]+)"/gi)].map(m => m[1]);
  return [...new Set(ops)];
}

module.exports = { timbrarCFDI, listarMetodos };
