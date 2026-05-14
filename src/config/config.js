require('dotenv').config();

module.exports = {
  port: process.env.PORT || 3000,
  jwtSecret: process.env.JWT_SECRET || 'facturacion_secret',
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME || 'facturacion',
    user: process.env.DB_USER || 'facturacion',
    password: process.env.DB_PASSWORD || 'facturacion123',
  },
  cfdi: {
    env: process.env.CFDI_ENV || 'test',
    timbradoUrlTest: process.env.CFDI_TIMBRADO_URL_TEST || 'https://dev33.facturacfdi.mx/WSTimbradoCFDIService?wsdl',
    timbradoUrlProd: process.env.CFDI_TIMBRADO_URL_PROD || 'https://v33.facturacfdi.mx/WSTimbradoCFDIService?wsdl',
    cancelacionUrlTest: process.env.CFDI_CANCELACION_URL_TEST || 'https://dev-cancelacion.facturacfdi.mx/WSCancelacion40Service?wsdl',
    cancelacionUrlProd: process.env.CFDI_CANCELACION_URL_PROD || 'https://cancelacion.facturacfdi.mx/WSCancelacion40Service?wsdl',
    username: process.env.CFDI_USERNAME || 'pruebasWS',
    password: process.env.CFDI_PASSWORD || 'pruebasWS',
    csd: {
      rfc: process.env.CSD_RFC || null,
      cerPath: process.env.CSD_CER_PATH || null,
      keyPath: process.env.CSD_KEY_PATH || null,
      password: process.env.CSD_PASSWORD || '12345678a',
    },
    get timbradoUrl() {
      return this.env === 'prod' ? this.timbradoUrlProd : this.timbradoUrlTest;
    },
    get cancelacionUrl() {
      return this.env === 'prod' ? this.cancelacionUrlProd : this.cancelacionUrlTest;
    },
  },
};
