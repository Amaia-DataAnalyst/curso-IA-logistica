/**
 * ============================================================================
 *  S7 · DEMO SEGURA — Recepción y preparación inicial de incidencias
 *  GARAIA LOGISTIKA, S.L. (caso didáctico ficticio)
 * ============================================================================
 *
 *  QUÉ HACE
 *    Busca hilos de Gmail sin procesar, detecta los que parecen incidencias
 *    (asunto + remitente + palabras clave), crea UNA fila por hilo en la hoja
 *    "Incidencias_GARAIA_demo" (columnas del modelo A4 + columnas extra a la
 *    derecha), guarda el enlace al hilo, crea un BORRADOR de acuse si procede
 *    y etiqueta el hilo con S7_PROCESADO.
 *
 *  GARANTÍAS DE SEGURIDAD (revisar antes de aprobar el código)
 *    · NO envía ningún email: este proyecto no contiene ninguna llamada de
 *      envío ni de borrado. Solo crea borradores (createDraftReply).
 *    · NO decide ni propone compensaciones, abonos ni descuentos.
 *    · NO toca otra hoja: va vinculado a UNA hoja (alcance currentonly) y
 *      comprueba su nombre exacto antes de escribir.
 *    · NO llama a servicios externos (sin UrlFetch, sin IA): reglas locales.
 *    · NO procesa dos veces el mismo hilo (etiqueta + Id en hoja + bloqueo).
 *
 *  FUNCIONES QUE SE EJECUTAN A MANO
 *    probarClasificador()   → prueba las reglas con 8 textos; no toca nada.
 *    simularSinEscribir()   → recorre Gmail y SOLO escribe en el registro.
 *    procesarIncidencias()  → ejecución real.
 *    instalarTrigger() / desinstalarTrigger() → ejecución automática 15 min.
 *
 *  @OnlyCurrentDoc
 */

// ============================================================================
// 1. CONFIGURACIÓN (lo único que debería tocarse)
// ============================================================================
const CONFIG = {
  // Seguridad: el script se niega a escribir si la hoja vinculada se llama distinto.
  HOJA_CALCULO_ESPERADA: 'Incidencias_GARAIA_demo',
  PESTANA_INCIDENCIAS: 'Incidencias',        // pestaña del modelo A4
  PESTANA_ERRORES: 'S7_Errores',
  PESTANA_DESCARTADOS: 'S7_Descartados',

  ETIQUETA_PROCESADO: 'S7_PROCESADO',
  ETIQUETA_ERROR: 'S7_ERROR',                // hilos abandonados tras N fallos

  // Búsqueda base en Gmail. Se le añade la exclusión de las dos etiquetas.
  CONSULTA_GMAIL: 'in:inbox newer_than:3d -category:promotions -category:social -category:forums',
  MAX_HILOS_BUSQUEDA: 50,                    // hilos traídos por ejecución
  MAX_EVALUACIONES_POR_EJECUCION: 20,        // hilos nuevos analizados por ejecución
  MAX_REINTENTOS: 3,                         // fallos antes de poner S7_ERROR
  MAX_MS_EJECUCION: 4.5 * 60 * 1000,         // margen bajo el límite de 6 min

  CREAR_BORRADORES: true,                    // false => nunca se crean borradores
  LOG_DESCARTADOS: true,                     // registrar hilos que no son incidencia
  SIMULACION: false,                         // true => procesarIncidencias() no escribe
  ZONA_HORARIA: 'Europe/Madrid',

  // Direcciones de la propia empresa (no se crean borradores hacia ellas).
  DOMINIOS_INTERNOS: ['garaialogistika.example'],
  // Direcciones DESDE las que responde el equipo (p. ej. el buzón de la demo).
  // Si el último mensaje del hilo es de una de ellas, se considera "ya respondido".
  DIRECCIONES_PROPIAS: [],                   // ej.: ['micuentademo@gmail.com']

  // Remitentes que suman un punto (agencias, clientes habituales...). Texto contenido en el email.
  REMITENTES_VIGILADOS: ['iparlurexpress.example'],
  // Remitentes que se ignoran por completo (no se etiqueta ni se registra).
  REMITENTES_EXCLUIDOS: ['no-reply', 'noreply', 'do-not-reply', 'mailer-daemon',
                         'postmaster', 'notifications@', 'newsletter']
};

// Columnas del modelo A4_incidencias_destino: NO cambiar orden ni nombres.
const COLUMNAS_MODELO = ['Nº de ficha', 'Origen', 'Fecha y hora', 'Cliente o proveedor', 'Tipo',
  'Gravedad', 'Descripción', 'Referencia', 'Qué pide el cliente', 'DATOS QUE FALTAN'];

// Columnas añadidas a la derecha del modelo (se crean si no existen).
const COLUMNAS_EXTRA = ['Estado', 'Enlace hilo Gmail', 'Id hilo', 'Remitente', 'Código tipo',
  'Confianza', 'Escalar a Operaciones', 'Borrador', 'Notas del proceso', 'Procesado el'];

const ESTADO_INICIAL = 'Borrador automático – pendiente de validación humana';
const ESTADO_ESCALAR = 'ESCALAR A OPERACIONES HOY – pendiente de validación humana';

// ============================================================================
// 2. REGLAS DE DETECCIÓN (palabras SIN tildes y en minúsculas)
//    Se busca como "inicio de palabra": 'faltan' casa con 'faltantes'.
//    Peso 2 = señal fuerte; peso 1 = señal débil. Ajustar tras probar.
// ============================================================================

// Tipos de PG-07 §2. El orden es la prioridad en caso de empate.
const TIPOS = [
  { codigo: 'ENT-01', nombre: 'Entrega incompleta', requeridos: ['docRef', 'refProducto', 'cantidad'],
    palabras: { 'faltaban': 2, 'faltaba': 2, 'faltan': 2, 'falta mercancia': 2, 'incompleta': 2,
                'incompleto': 2, 'no han llegado todos': 2, 'no llego todo': 2, 'sin llegar': 1 } },
  { codigo: 'ENT-02', nombre: 'Entrega errónea', requeridos: ['docRef', 'refProducto', 'cantidad'],
    palabras: { 'pedido incorrecto': 2, 'pedido erroneo': 2, 'referencia equivocada': 2, 'equivocad': 2,
                'no es lo que pedimos': 2, 'no es lo que habiamos pedido': 2, 'okerra': 2,
                'eskaera okerra': 2, 'en lugar de': 1, 'en vez de': 1, 'erroneo': 1 } },
  { codigo: 'ENT-03', nombre: 'Entrega fuera de plazo', requeridos: ['docRef'],
    palabras: { 'retraso': 2, 'retrasad': 2, 'fuera de plazo': 2, 'llego tarde': 2, 'llegado tarde': 2,
                'no ha llegado': 2, 'todavia no ha llegado': 2, 'sin entregar': 2,
                'quedo en plataforma': 2, 'plataforma': 1, 'pendiente de asignacion': 1,
                'exceso de volumen': 1 } },
  { codigo: 'ENT-04', nombre: 'Entrega no realizada', requeridos: ['docRef'],
    palabras: { 'estaba cerrado': 2, 'no habia nadie': 2, 'no se pudo entregar': 2, 'no pudimos entregar': 2,
                'direccion incorrecta': 2, 'entrega fallida': 2, 'intento de entrega': 2, 'rechaz': 2,
                'cerrado': 1, 'persiana': 1 } },
  { codigo: 'DAN-01', nombre: 'Mercancía dañada', requeridos: ['docRef', 'refProducto', 'cantidad', 'fotos'],
    palabras: { 'golpead': 2, 'danad': 2, 'roto': 2, 'rota': 2, 'deteriorad': 2, 'aplastad': 2,
                'mojad': 2, 'abollad': 2, 'en mal estado': 2, 'mal estado': 1 } },
  { codigo: 'DOC-01', nombre: 'Incidencia documental', requeridos: ['docRef'],
    palabras: { 'falta el albaran': 2, 'falta el alb': 2, 'sin albaran': 2, 'no coincide': 2, 'no cuadra': 2,
                'datos erroneos': 2, 'factura incorrecta': 2, 'factura erronea': 2,
                'albaran': 1, 'factura': 1 } },
  { codigo: 'DEV-01', nombre: 'Devolución con incidencia', requeridos: ['docRef', 'refProducto'],
    palabras: { 'devolucion': 1, 'devolver': 1 } },
  { codigo: 'CAL-01', nombre: 'Calidad de producto', requeridos: ['docRef', 'refProducto', 'cantidad'],
    palabras: { 'no cumple': 2, 'defectuos': 2, 'no conforme': 2, 'fuera de tolerancia': 2,
                'especificacion': 1, 'calidad': 1, 'no funciona': 1 } }
];

// Palabras genéricas de queja (suman como máximo 2 puntos en total).
const GENERICAS = { 'incidencia': 1, 'reclamacion': 1, 'queja': 1, 'inaceptable': 1, 'problema': 1,
                    'error': 1, 'recepcion': 1, 'situacion': 1, 'urgente': 1 };

// Señales para PROPONER gravedad y escalado (PG-07 §3 y §8). Solo proponen.
const SENALES_GRAVES = ['parar una linea', 'linea de produccion', 'linea parada', 'parados', 'paralizad',
  'parada de produccion', 'paro de produccion', 'produccion parada', 'no podemos trabajar',
  'no podemos operar', 'sin poder producir'];
const SENALES_PERJUICIO = ['nos ha costado', 'perjuicio', 'danos y perjuicios', 'indemnizacion',
  'compensacion', 'dejar constancia', 'que quede constancia', 'penalizacion', 'reclamaremos'];
const SENALES_ABONO = ['abono', 'abonar', 'abonen', 'nota de credito', 'reembolso', 'devolver el dinero'];

// Señales comerciales (PG-07 §1 las excluye): bajan la confianza y bloquean el borrador en DOC-01.
const SENALES_COMERCIALES = ['presupuest', 'oferta', 'tarifa', 'cotizacion', 'precio', 'previsiones',
  'stock', 'descuento'];

// Qué pide el remitente (solo se REGISTRA; no se decide nada).
const PETICIONES = [
  ['Fecha de llegada / plazo', ['cuando llega', 'cuando llegara', 'cuando recibiremos', 'fecha de entrega']],
  ['Reposición o reenvío del material', ['reposicion', 'reponer', 'reenvio', 'reenviar', 'enviar de nuevo',
                                         'necesitamos el', 'necesitamos esta semana']],
  ['Explicación de lo ocurrido', ['explicacion', 'explicar', 'que ha pasado', 'que paso']],
  ['Instrucciones sobre el material recibido', ['que hacemos con', 'que hacer con', 'que hago con',
                                                'dejar o enviar', 'recoger']],
  ['Abono / nota de crédito (NO decide el script)', SENALES_ABONO],
  ['Compensación o constancia de costes (NO decide el script)', SENALES_PERJUICIO],
  ['Respuesta urgente (hoy / esta semana)', ['hoy mismo', 'esta semana', 'urgente', 'lo antes posible']]
];

// Datos mínimos que se buscan en el texto para rellenar "DATOS QUE FALTAN".
const RE_CANTIDAD = /\b(\d{1,4}|un|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\s+(cajas?|cj|palets?|pales|bultos?|unidades|uds?|bobinas?|rollos?|piezas?|rodamientos?)\b/;
const COMPROBACIONES = {
  docRef:      { etiqueta: 'Nº de albarán, pedido o factura', ok: (r, n) => r.docs.length > 0 },
  refProducto: { etiqueta: 'Referencia exacta del producto',  ok: (r, n) => r.productos.length > 0 },
  cantidad:    { etiqueta: 'Cantidad afectada',               ok: (r, n) => RE_CANTIDAD.test(n) },
  fotos:       { etiqueta: 'Fotos o descripción del estado del material', ok: (r, n) => /foto|imagen|adjunt/.test(n) }
};

// Estado global de la ejecución (true = no se escribe nada fuera del registro de errores).
let SIMULACION_ACTIVA = false;

// ============================================================================
// 3. PUNTOS DE ENTRADA
// ============================================================================

/** Ejecución real (o simulada si CONFIG.SIMULACION = true). */
function procesarIncidencias() { ejecutar_(CONFIG.SIMULACION); }

/** Recorre Gmail y muestra en el Registro qué haría, SIN escribir, etiquetar ni crear borradores. */
function simularSinEscribir() { ejecutar_(true); }

/** Crea el disparador automático cada 15 minutos (sustituye a uno anterior). */
function instalarTrigger() {
  desinstalarTrigger();
  ScriptApp.newTrigger('procesarIncidencias').timeBased().everyMinutes(15).create();
}

/** Elimina el disparador automático. */
function desinstalarTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'procesarIncidencias')
    .forEach(t => ScriptApp.deleteTrigger(t));
}

/** Prueba las reglas con 8 textos de ejemplo. No toca Gmail ni la hoja: mirar el Registro. */
function probarClasificador() {
  const casos = [
    ['RE: RE: entrega jueves - SITUACIÓN INACEPTABLE', 'El viernes, al abrir el palé, vimos que FALTABAN rodamientos. El viernes por la tarde tuvimos que PARAR una línea de producción. Hemos estado el fin de semana parados. Esto nos ha costado dinero. Necesito hoy mismo que me digáis cuándo llega el material que falta y una explicación de qué ha pasado.', 'admin@mecanizadosaldalur.example'],
    ['Aviso plataforma - carga pendiente 18/09', 'Uno de los palés quedó en plataforma por exceso de volumen en el vehículo. Queda pendiente de asignación a un servicio. Este mensaje se ha generado automáticamente.', 'trafico@iparlurexpress.example'],
    ['[WhatsApp] recepcion viernes', 'hay 3 cj de 6205 golpeadas. ojo q ademas falta el alb de la 2a entrega', 'ainhoa.beltran@garaialogistika.example'],
    ['Eskaera okerra / Pedido incorrecto', 'Desengrasantea eskatu genuen, EPI-3401 erreferentzia, eta eskularruak iritsi zaizkigu. Nos habéis mandado guantes en lugar del desengrasante. Necesitamos el desengrasante esta semana.', 'pedidos@salvatierraagroindustria.example'],
    ['URGENTE - Laudio Estanpazioak pregunta por plazos', 'Qué plazo tenemos para la electroválvula de 1/4". Quieren PRESUPUESTO para unas 40 referencias de neumática. CL-0176', 'ainhoa.beltran@garaialogistika.example'],
    ['Revisión factura del mes', 'En dos líneas el precio no coincide con lo que teníamos presupuestado. No os la pago hasta que lo aclaremos.', 'info@talleresgorbeaindustrial.example'],
    ['[Audio transcrito] Iker - viernes Orduña', 'baje a orduna con el pale y estaba cerrado, no habia nadie, la persiana bajada. me lo traje otra vez', 'ainhoa.beltran@garaialogistika.example'],
    ['Film del viernes + previsiones vendimia', 'Del film que nos llegó el viernes hay cuatro bobinas con el mandril roto. Vamos a DOBLAR el consumo de film por la vendimia. Confirmadme que tenéis stock.', 'info@bodegasiturrieta.example']
  ];
  casos.forEach((c, i) => {
    const a = analizarTexto_({ asunto: c[0], cuerpo: c[1], nombre: 'Prueba', email: c[2], cc: '', yaRespondido: false });
    Logger.log('#%s | incidencia=%s | tipo=%s | conf=%s | %s | escalar=%s | borrador=%s | faltan=%s',
      i + 1, a.esIncidencia, a.tipo ? a.tipo.codigo : 'N/D', a.confianza, a.gravedad,
      a.motivosEscalado.length ? a.motivosEscalado.join(' / ') : 'no',
      a.procedeBorrador ? 'sí' : 'no (' + a.motivoSinBorrador + ')', a.faltan.join(' · '));
  });
}

// ============================================================================
// 4. BUCLE PRINCIPAL
// ============================================================================

function ejecutar_(simulacion) {
  SIMULACION_ACTIVA = simulacion;
  const inicio = Date.now();

  // BARRERA 3 contra duplicados: una sola ejecución a la vez.
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) { Logger.log('Hay otra ejecución en curso. Se cancela esta.'); return; }

  try {
    const ctx = prepararEntorno_(simulacion);
    const resumen = { revisados: 0, filas: 0, borradores: 0, descartados: 0, yaProcesados: 0, errores: 0 };

    // BARRERA 1: Gmail no devuelve hilos con S7_PROCESADO ni S7_ERROR.
    const consulta = [CONFIG.CONSULTA_GMAIL, '-label:' + CONFIG.ETIQUETA_PROCESADO,
                      '-label:' + CONFIG.ETIQUETA_ERROR].join(' ');
    const hilos = GmailApp.search(consulta, 0, CONFIG.MAX_HILOS_BUSQUEDA);
    let evaluados = 0;

    for (const hilo of hilos) {
      if (Date.now() - inicio > CONFIG.MAX_MS_EJECUCION) { Logger.log('Tiempo agotado: se continúa en la próxima ejecución.'); break; }
      if (evaluados >= CONFIG.MAX_EVALUACIONES_POR_EJECUCION) break;
      try {
        const estado = procesarHilo_(hilo, ctx, resumen);
        if (estado !== 'omitido') evaluados++;
      } catch (e) {
        evaluados++;
        resumen.errores++;
        gestionarFallo_(hilo, e, ctx);
      }
    }
    Logger.log('%s Resumen: %s', simulacion ? '[SIMULACIÓN]' : '[REAL]', JSON.stringify(resumen));
  } catch (e) {
    // Fallo de entorno (hoja equivocada, cabeceras distintas...): no se procesa NADA.
    registrarError_('ENTORNO', null, e, 0);
  } finally {
    lock.releaseLock();
  }
}

/** Valida hoja, cabeceras y etiquetas. Si algo no cuadra, lanza error y no se escribe nada. */
function prepararEntorno_(simulacion) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('El script debe estar vinculado a la hoja (Extensiones > Apps Script desde la propia hoja).');
  if (ss.getName() !== CONFIG.HOJA_CALCULO_ESPERADA) {
    throw new Error('Hoja vinculada "' + ss.getName() + '" distinta de "' + CONFIG.HOJA_CALCULO_ESPERADA + '". No se escribe nada.');
  }
  let hoja = ss.getSheetByName(CONFIG.PESTANA_INCIDENCIAS);
  if (!hoja) {
    if (simulacion) throw new Error('No existe la pestaña "' + CONFIG.PESTANA_INCIDENCIAS + '".');
    hoja = ss.insertSheet(CONFIG.PESTANA_INCIDENCIAS);
  }
  const columnas = asegurarCabeceras_(hoja, simulacion);
  const ultimaColumna = Math.max.apply(null, Object.keys(columnas).map(k => columnas[k] || 0));

  const hojaDesc = ss.getSheetByName(CONFIG.PESTANA_DESCARTADOS);
  return {
    ss: ss, hoja: hoja, columnas: columnas, ultimaColumna: ultimaColumna, hojaDesc: hojaDesc,
    etiquetaProcesado: obtenerEtiqueta_(CONFIG.ETIQUETA_PROCESADO, simulacion),
    etiquetaError: obtenerEtiqueta_(CONFIG.ETIQUETA_ERROR, simulacion),
    idsIncidencia: new Set(leerColumna_(hoja, columnas['Id hilo'])),
    descartados: new Set(hojaDesc ? leerColumna_(hojaDesc, 2) : [])
  };
}

/** Procesa un hilo. Devuelve 'omitido' | 'yaProcesado' | 'descartado' | 'fila'. */
function procesarHilo_(hilo, ctx, resumen) {
  const id = hilo.getId();

  // BARRERA 2: si el hilo ya tiene fila (p. ej. falló justo antes de etiquetar), solo se etiqueta.
  if (ctx.idsIncidencia.has(id)) {
    if (!SIMULACION_ACTIVA && ctx.etiquetaProcesado) hilo.addLabel(ctx.etiquetaProcesado);
    resumen.yaProcesados++;
    return 'yaProcesado';
  }
  // Descartado antes con el mismo nº de mensajes: no se reevalúa (sí si llega un mensaje nuevo).
  const claveDesc = id + '#' + hilo.getMessageCount();
  if (ctx.descartados.has(claveDesc)) return 'omitido';

  const mensajes = hilo.getMessages().filter(m => !m.isDraft());
  const objetivo = elegirMensajeObjetivo_(mensajes);
  if (!objetivo) return 'omitido';

  resumen.revisados++;
  const msg = objetivo.mensaje;
  const remit = parsearRemitente_(msg.getFrom());
  if (CONFIG.REMITENTES_EXCLUIDOS.some(x => remit.email.indexOf(x) >= 0)) return 'omitido';

  const d = {
    asunto: msg.getSubject() || '',
    cuerpo: limpiarCuerpo_(msg.getPlainBody()),
    nombre: remit.nombre, email: remit.email,
    cc: msg.getCc() || '',
    yaRespondido: objetivo.ultimoEsPropio
  };
  const a = analizarTexto_(d);

  // ---- No es incidencia: se anota aparte (nada se pierde en silencio) ----
  if (!a.esIncidencia) {
    const motivo = a.comercial.length
      ? 'Posible consulta comercial (PG-07 §1 la excluye): revisar a mano'
      : 'Sin señales de incidencia';
    registrarDescartado_(ctx, hilo, claveDesc, d, motivo);
    resumen.descartados++;
    return 'descartado';
  }

  // ---- Es incidencia: completar con datos de la hoja ----
  const motivos = a.motivosEscalado.slice();
  if (contarPrevias_(ctx, remit.email) > 0) {
    motivos.push('Posible 2ª incidencia del mismo remitente en 60 días (PG-07 §8)');
  }
  const escalar = motivos.length > 0;
  const fechaMsg = Utilities.formatDate(msg.getDate(), CONFIG.ZONA_HORARIA, 'dd/MM/yyyy HH:mm');
  const url = hilo.getPermalink();

  if (SIMULACION_ACTIVA) {
    Logger.log('[SIMULACIÓN] "%s" (%s) → %s | %s | conf %s | escalar: %s | borrador: %s',
      d.asunto, remit.email, a.tipo ? a.tipo.codigo : 'N/D', a.gravedad, a.confianza,
      escalar ? motivos.join(' / ') : 'no', a.procedeBorrador ? 'sí' : 'no (' + a.motivoSinBorrador + ')');
    resumen.filas++;
    return 'fila';
  }

  // 1) Fila nueva (columna Borrador = PENDIENTE hasta saber el resultado)
  const fila = hoja_siguienteFila_(ctx.hoja);
  const ficha = siguienteFicha_(ctx.hoja);
  const valores = new Array(ctx.ultimaColumna).fill('');
  const poner = (nombre, valor) => { const c = ctx.columnas[nombre]; if (c) valores[c - 1] = seguro_(valor); };

  poner('Nº de ficha', ficha);
  poner('Origen', a.origenPrefijo + ' ' + remit.nombre);
  poner('Fecha y hora', fechaMsg);
  poner('Cliente o proveedor', remit.nombre + ' <' + remit.email + '>' +
        (a.refs.cliente ? ' · ' + a.refs.cliente : '') + ' [sin verificar contra ERP]');
  poner('Tipo', a.tipo ? a.tipo.codigo + ' ' + a.tipo.nombre : 'POR CLASIFICAR');
  poner('Gravedad', a.gravedad);
  poner('Descripción', a.descripcion);
  poner('Referencia', a.refs.todos.join('; '));
  poner('Qué pide el cliente', a.peticiones.length ? a.peticiones.join('; ') : 'No detectado: leer el mensaje');
  poner('DATOS QUE FALTAN', a.faltan.join(' · '));
  poner('Estado', escalar ? ESTADO_ESCALAR : ESTADO_INICIAL);
  poner('Enlace hilo Gmail', url);
  poner('Id hilo', id);
  poner('Remitente', remit.email);
  poner('Código tipo', a.tipo ? a.tipo.codigo : 'N/D');
  poner('Confianza', a.confianza);
  poner('Escalar a Operaciones', escalar ? 'SÍ: ' + motivos.join(' | ') : 'No detectado (confirmar)');
  poner('Borrador', a.procedeBorrador ? 'PENDIENTE' : 'No: ' + a.motivoSinBorrador);
  poner('Notas del proceso', a.notas.join(' | '));
  poner('Procesado el', Utilities.formatDate(new Date(), CONFIG.ZONA_HORARIA, 'dd/MM/yyyy HH:mm'));

  ctx.hoja.getRange(fila, ctx.columnas['Id hilo']).setNumberFormat('@'); // el Id es texto, no número
  ctx.hoja.getRange(fila, 1, 1, valores.length).setValues([valores]);
  if (escalar) ctx.hoja.getRange(fila, 1, 1, COLUMNAS_MODELO.length).setBackground('#fdeaea');
  ctx.idsIncidencia.add(id);
  resumen.filas++;

  // 2) Borrador (NUNCA se envía). Si falla, se anota y se sigue.
  if (a.procedeBorrador) {
    let resultado;
    try {
      msg.createDraftReply(construirBorrador_(d, a, motivos));
      resultado = 'Sí (pendiente de revisión humana)';
      resumen.borradores++;
    } catch (e) {
      resultado = 'ERROR al crear (ver S7_Errores)';
      registrarError_('BORRADOR', hilo, e, 0);
    }
    ctx.hoja.getRange(fila, ctx.columnas['Borrador']).setValue(resultado);
  }

  // 3) Etiqueta al final: si algo falló antes, el hilo se reintenta sin duplicar la fila (barrera 2).
  hilo.addLabel(ctx.etiquetaProcesado);
  PropertiesService.getScriptProperties().deleteProperty('reint_' + id);
  return 'fila';
}

// ============================================================================
// 5. ANÁLISIS (función "pura": no usa Gmail ni la hoja; por eso se puede probar)
// ============================================================================

function analizarTexto_(d) {
  const asuntoN = normalizar_(d.asunto);
  const cuerpoN = normalizar_(d.cuerpo);
  const todoN = asuntoN + ' ' + cuerpoN;
  const email = String(d.email || '').toLowerCase();

  // ---- Puntuar cada tipo; gana el de más puntos (empate → el primero de la lista) ----
  const res = TIPOS.map(t => Object.assign({ tipo: t }, puntuarMapa_(t.palabras, asuntoN, cuerpoN)));
  let mejor = res[0];
  res.forEach(r => { if (r.puntos > mejor.puntos) mejor = r; });
  const segundo = res.filter(r => r !== mejor).reduce((m, r) => Math.max(m, r.puntos), 0);
  const adicionales = res.filter(r => r !== mejor && r.puntos >= 2).map(r => r.tipo.codigo);

  // ---- Otras señales ----
  const genericas = Math.min(2, puntuarMapa_(GENERICAS, asuntoN, cuerpoN).puntos);
  const graves = halladas_(SENALES_GRAVES, todoN);
  const perjuicio = halladas_(SENALES_PERJUICIO, todoN);
  const abono = halladas_(SENALES_ABONO, todoN);
  const comercial = halladas_(SENALES_COMERCIALES, todoN);
  const vigilado = CONFIG.REMITENTES_VIGILADOS.some(x => email.indexOf(x) >= 0);
  const esTranscripcion = /^\s*\[(whatsapp|audio)/i.test(d.asunto || '');
  const esEuskera = /\b(egun on|eskerrik asko|mesedez|eskaera|okerra|kaixo|eskatu)\b/.test(cuerpoN);
  const esAutomatico = /no responda|no conteste|generado automaticamente|mensaje automatico/.test(cuerpoN);
  const emisorExterno = !esDominioInterno_(email);

  // ---- ¿Entra? Regla: señal fuerte de tipo, o señal débil + contexto, o señales de gravedad ----
  const total = mejor.puntos + genericas + (vigilado ? 1 : 0) + (graves.length ? 1 : 0);
  const esIncidencia = mejor.puntos >= 2 || (mejor.puntos >= 1 && total >= 3) || graves.length > 0;
  const tipo = mejor.puntos > 0 ? mejor.tipo : null;

  // ---- Confianza: sube con los puntos; baja con empates, mezcla comercial o transcripción ----
  let nivel = mejor.puntos >= 4 ? 2 : (mejor.puntos >= 2 ? 1 : 0);
  if (segundo > 0 && mejor.puntos - segundo < 2) nivel--;
  if (comercial.length) nivel--;
  if (esTranscripcion) nivel--;
  const confianza = ['Baja', 'Media', 'Alta'][Math.max(0, nivel)];

  // ---- Referencias y datos que faltan ----
  const textoRef = (d.asunto || '') + '\n' + (d.cuerpo || '');
  const refs = extraerReferencias_(textoRef, cuerpoN + ' ' + asuntoN);
  const faltan = [];
  const faltanCliente = [];
  (tipo ? tipo.requeridos : ['docRef']).forEach(k => {
    if (!COMPROBACIONES[k].ok(refs, todoN)) { faltan.push(COMPROBACIONES[k].etiqueta); faltanCliente.push(COMPROBACIONES[k].etiqueta); }
  });
  faltan.push('Cliente/proveedor real y código CL/PR (sin verificar contra el ERP)');
  if (esTranscripcion) faltan.push('Transcripción pegada: confirmar nombres y datos con el original');

  // ---- Escalado: SOLO marca motivos (PG-07 §8); el script no avisa a nadie ----
  const motivos = [];
  if (graves.length) motivos.push('Posible impacto operativo del cliente = grave (PG-07 §3, mismo día)');
  if (perjuicio.length) motivos.push('El cliente alude a coste/perjuicio/compensación (PG-07 §8)');
  if (abono.length) motivos.push('Se menciona abono (PG-07 §8)');
  if (/direccion|gerencia/.test(normalizar_(d.cc))) motivos.push('Con copia a la dirección del cliente');

  // ---- Notas para la persona que valide ----
  const notas = [];
  if (adicionales.length) notas.push('Posibles incidencias adicionales (' + adicionales.join(', ') + '): valorar dividir la ficha');
  if (comercial.length) notas.push('Señales comerciales (' + comercial.join(', ') + '): puede no ser incidencia (PG-07 §1)');
  if (tipo && tipo.codigo === 'DOC-01' && comercial.length) notas.push('Frontera DOC-01 / reclamación comercial de precio: decidir a mano');
  if (tipo && tipo.codigo === 'ENT-03') notas.push('Retraso: escala POL-004 NO calculada (faltan nivel de servicio y fecha comprometida). No se propone compensación');
  if (perjuicio.length || abono.length) notas.push('Compensaciones/abonos: decide Operaciones, no el script');
  if (esTranscripcion) notas.push('Origen pegado en el buzón: el remitente puede ser quien pegó, no quien escribió');
  if (esEuskera) notas.push('Mensaje con euskera: revisar el idioma del borrador');
  if (d.yaRespondido) notas.push('El equipo ya respondió en este hilo');
  notas.push('Gravedad y tipo son propuestas automáticas (reglas de palabras clave)');

  // ---- ¿Borrador? Solo si es seguro y útil ----
  let motivoSinBorrador = '';
  if (!CONFIG.CREAR_BORRADORES) motivoSinBorrador = 'borradores desactivados';
  else if (!emisorExterno) motivoSinBorrador = 'remitente interno';
  else if (esAutomatico) motivoSinBorrador = 'mensaje automático / "no responda"';
  else if (d.yaRespondido) motivoSinBorrador = 'ya respondido por el equipo';
  else if (confianza === 'Baja') motivoSinBorrador = 'confianza baja';
  else if (tipo && tipo.codigo === 'DOC-01' && comercial.length) motivoSinBorrador = 'posible reclamación comercial';

  const peticiones = PETICIONES.filter(p => halladas_(p[1], todoN).length > 0).map(p => p[0]);

  return {
    esIncidencia: esIncidencia, tipo: tipo, confianza: confianza,
    gravedad: graves.length ? 'Grave (propuesta)' : 'Leve (propuesta)',
    graves: graves, perjuicio: perjuicio, abono: abono, comercial: comercial,
    refs: refs, faltan: faltan, faltanCliente: faltanCliente, peticiones: peticiones,
    motivosEscalado: motivos, notas: notas,
    origenPrefijo: /^\s*\[whatsapp/i.test(d.asunto || '') ? 'WhatsApp (transcripción pegada)'
                 : (/^\s*\[audio/i.test(d.asunto || '') ? 'Audio transcrito (pegado)' : 'Email'),
    // Extracto literal (no es un resumen): la persona debe contrastarlo con el original.
    descripcion: 'Extracto automático (verificar con el mensaje original): ' +
                 String(d.cuerpo || '').replace(/\s+/g, ' ').trim().slice(0, 450),
    procedeBorrador: motivoSinBorrador === '', motivoSinBorrador: motivoSinBorrador
  };
}

/** Extrae códigos (EPI-3401, CL-0176, PR-004) y nº de albarán/pedido/factura. */
function extraerReferencias_(textoOriginal, textoNormalizado) {
  const codigos = unicos_(textoOriginal.match(/\b[A-Z]{2,4}-\d{2,5}\b/g) || []);
  const docs = [];
  const re = /\b(albaran|pedido|factura|expedicion)\b[^\S\n]*(?:n[º°o]\.?|num(?:ero)?\.?)?[^\S\n]*[:#]?[^\S\n]*((?=[a-z0-9\-\/]*\d)[a-z0-9][a-z0-9\-\/]{2,})/g;
  let m;
  while ((m = re.exec(textoNormalizado)) !== null) docs.push(m[2].toUpperCase());
  const docsU = unicos_(docs);
  return {
    docs: docsU,
    productos: codigos.filter(c => !/^(CL|PR)-/.test(c)),
    cliente: codigos.filter(c => /^CL-/.test(c))[0] || '',
    todos: unicos_(codigos.concat(docsU))
  };
}

/** Texto del borrador: acuse neutro. Sin fechas, causas, compensaciones ni compromisos. */
function construirBorrador_(d, a, motivos) {
  const nombre = String(d.nombre || '').split(' ')[0];
  const l = [];
  l.push('[BORRADOR AUTOMÁTICO · REVISAR, EDITAR Y BORRAR ESTAS LÍNEAS ANTES DE ENVIAR]');
  l.push('[No contiene fechas, causas, compensaciones ni compromisos de resolución: eso lo decide una persona.]');
  if (motivos.length) l.push('[CASO MARCADO PARA ESCALADO: no enviar sin consultar antes con Operaciones.]');
  l.push('');
  l.push('Buenos días' + (nombre ? ', ' + nombre : '') + ':');
  l.push('');
  l.push('Hemos recibido su mensaje y lo hemos registrado como incidencia. Una persona responsable la revisará y se pondrá en contacto con usted.');
  if (a.faltanCliente.length) {
    l.push('');
    l.push('Para agilizar la gestión, nos ayudaría que nos indicara, si dispone de ello:');
    a.faltanCliente.forEach(x => l.push('- ' + x));
  }
  l.push('');
  l.push('Un saludo,');
  l.push('[Nombre y cargo de quien firma]');
  l.push('GARAIA LOGISTIKA');
  return l.join('\n');
}

// ============================================================================
// 6. HOJA: cabeceras, números de ficha, descartados, errores
// ============================================================================

/** Comprueba A–J contra el modelo y añade las columnas extra a la derecha. Devuelve {nombre: nº columna}. */
function asegurarCabeceras_(hoja, simulacion) {
  if (hoja.getLastRow() === 0) {
    if (simulacion) throw new Error('La pestaña "' + hoja.getName() + '" está vacía (sin cabeceras).');
    const todas = COLUMNAS_MODELO.concat(COLUMNAS_EXTRA);
    hoja.getRange(1, 1, 1, todas.length).setValues([todas]).setFontWeight('bold');
    hoja.setFrozenRows(1);
  }
  const cab = hoja.getRange(1, 1, 1, Math.max(hoja.getLastColumn(), COLUMNAS_MODELO.length)).getValues()[0]
                  .map(c => String(c).trim());
  while (cab.length > COLUMNAS_MODELO.length && cab[cab.length - 1] === '') cab.pop();

  // Las 10 columnas del modelo deben estar, en su orden. Si no, NO se escribe nada.
  COLUMNAS_MODELO.forEach((nombre, i) => {
    if (clavePlana_(cab[i]) !== clavePlana_(nombre)) {
      throw new Error('Cabecera inesperada en la columna ' + (i + 1) + ': "' + cab[i] + '" (se esperaba "' + nombre + '").');
    }
  });
  const mapa = {};
  COLUMNAS_MODELO.forEach((n, i) => { mapa[n] = i + 1; });

  COLUMNAS_EXTRA.forEach(nombre => {
    let idx = -1;
    cab.forEach((c, i) => { if (i >= COLUMNAS_MODELO.length && clavePlana_(c) === clavePlana_(nombre)) idx = i; });
    if (idx < 0 && !simulacion) {          // se añade siempre a la derecha, sin mover nada
      idx = cab.length;
      hoja.getRange(1, idx + 1).setValue(nombre).setFontWeight('bold');
      cab.push(nombre);
    }
    mapa[nombre] = idx >= 0 ? idx + 1 : null;
  });
  return mapa;
}

function hoja_siguienteFila_(hoja) { return hoja.getLastRow() + 1; }

/** Siguiente nº de ficha = máximo numérico de la columna A + 1 (el formato oficial no está documentado). */
function siguienteFicha_(hoja) {
  const ultima = hoja.getLastRow();
  if (ultima < 2) return 1;
  const nums = hoja.getRange(2, 1, ultima - 1, 1).getValues().map(r => Number(r[0])).filter(n => !isNaN(n));
  return (nums.length ? Math.max.apply(null, nums) : 0) + 1;
}

/** Cuenta filas previas del mismo remitente/empresa en los últimos 60 días (PG-07 §8). */
function contarPrevias_(ctx, email) {
  const ultima = ctx.hoja.getLastRow();
  if (ultima < 2) return 0;
  const datos = ctx.hoja.getRange(2, 1, ultima - 1, COLUMNAS_MODELO.length).getValues();
  const limite = Date.now() - 60 * 24 * 3600 * 1000;
  const claveEmail = clavePlana_(email);
  const claveDom = claveDominio_(email);
  let n = 0;
  datos.forEach(fila => {
    const cliente = clavePlana_(fila[3]);                 // col D: Cliente o proveedor
    const ts = parsearFecha_(fila[2]);                    // col C: Fecha y hora
    const coincide = cliente.indexOf(claveEmail) >= 0 || (claveDom.length >= 6 && cliente.indexOf(claveDom) >= 0);
    if (coincide && ts && ts >= limite) n++;
  });
  return n;
}

function registrarDescartado_(ctx, hilo, claveDesc, d, motivo) {
  ctx.descartados.add(claveDesc);
  if (!CONFIG.LOG_DESCARTADOS || SIMULACION_ACTIVA) return;
  if (!ctx.hojaDesc) {
    ctx.hojaDesc = obtenerOCrearPestana_(ctx.ss, CONFIG.PESTANA_DESCARTADOS,
      ['Fecha', 'Clave hilo', 'Remitente', 'Asunto', 'Motivo', 'Enlace']);
  }
  ctx.hojaDesc.appendRow([
    Utilities.formatDate(new Date(), CONFIG.ZONA_HORARIA, 'dd/MM/yyyy HH:mm'),
    claveDesc, d.email, d.asunto, motivo, hilo.getPermalink()
  ].map(seguro_));
}

/** Registra un error en S7_Errores y en el Registro. Nunca lanza excepciones. */
function registrarError_(fase, hilo, e, intento) {
  let asunto = '', id = '';
  try { if (hilo) { id = hilo.getId(); asunto = hilo.getFirstMessageSubject(); } } catch (_) { /* sin datos del hilo */ }
  Logger.log('[ERROR][%s] hilo=%s intento=%s: %s', fase, id, intento, e && e.message ? e.message : e);
  if (SIMULACION_ACTIVA) return;
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    if (!ss || ss.getName() !== CONFIG.HOJA_CALCULO_ESPERADA) return;   // nunca escribir en otra hoja
    const hoja = obtenerOCrearPestana_(ss, CONFIG.PESTANA_ERRORES,
      ['Fecha', 'Fase', 'Id hilo', 'Asunto', 'Error', 'Intento', 'Detalle técnico']);
    hoja.appendRow([
      Utilities.formatDate(new Date(), CONFIG.ZONA_HORARIA, 'dd/MM/yyyy HH:mm:ss'),
      fase, id, asunto, e && e.message ? e.message : String(e), intento,
      e && e.stack ? String(e.stack).slice(0, 500) : ''
    ].map(seguro_));
  } catch (e2) {
    Logger.log('No se pudo escribir en S7_Errores: ' + e2);
  }
}

/** Cuenta reintentos por hilo; al llegar al máximo lo aparta con S7_ERROR para no bloquear la cola. */
function gestionarFallo_(hilo, e, ctx) {
  let id = '?';
  try { id = hilo.getId(); } catch (_) { /* ignorar */ }
  const props = PropertiesService.getScriptProperties();
  const clave = 'reint_' + id;
  const n = (parseInt(props.getProperty(clave), 10) || 0) + 1;
  if (!SIMULACION_ACTIVA) props.setProperty(clave, String(n));
  registrarError_('HILO', hilo, e, n);

  if (n >= CONFIG.MAX_REINTENTOS && !SIMULACION_ACTIVA) {
    try {
      if (ctx.etiquetaError) hilo.addLabel(ctx.etiquetaError);
      props.deleteProperty(clave);
      registrarError_('ABANDONO', hilo, new Error('Hilo apartado tras ' + n + ' fallos: revisar a mano.'), n);
    } catch (e2) {
      Logger.log('No se pudo etiquetar S7_ERROR: ' + e2);
    }
  }
}

function obtenerOCrearPestana_(ss, nombre, cabeceras) {
  let h = ss.getSheetByName(nombre);
  if (!h) {
    h = ss.insertSheet(nombre);
    h.getRange(1, 1, 1, cabeceras.length).setValues([cabeceras]).setFontWeight('bold');
    h.setFrozenRows(1);
  }
  return h;
}

function obtenerEtiqueta_(nombre, simulacion) {
  return GmailApp.getUserLabelByName(nombre) || (simulacion ? null : GmailApp.createLabel(nombre));
}

// ============================================================================
// 7. UTILIDADES
// ============================================================================

/** Minúsculas, sin tildes ni espacios repetidos. */
function normalizar_(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
}

/** Solo letras y números (para comparar cabeceras y nombres). */
function clavePlana_(s) { return normalizar_(s).replace(/[^a-z0-9]/g, ''); }

const CACHE_RE = {};
/** ¿Aparece la palabra clave al inicio de una palabra del texto? ('roto' no casa con 'protocolo'). */
function contiene_(texto, kw) {
  let re = CACHE_RE[kw];
  if (!re) {
    re = new RegExp('(^|[^a-z0-9])' + kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    CACHE_RE[kw] = re;
  }
  return re.test(texto);
}

/** Suma pesos de un mapa {palabra: peso}; una señal fuerte en el asunto vale +1. */
function puntuarMapa_(mapa, asuntoN, cuerpoN) {
  let puntos = 0;
  const claves = [];
  Object.keys(mapa).forEach(kw => {
    const peso = mapa[kw];
    const enAsunto = contiene_(asuntoN, kw);
    if (enAsunto || contiene_(cuerpoN, kw)) {
      puntos += peso + (enAsunto && peso >= 2 ? 1 : 0);
      claves.push(kw);
    }
  });
  return { puntos: puntos, claves: claves };
}

function halladas_(lista, texto) { return lista.filter(kw => contiene_(texto, kw)); }
function unicos_(arr) { return arr.filter((x, i) => arr.indexOf(x) === i); }

/** Último mensaje que no es del propio buzón. 'ultimoEsPropio' = el equipo ya contestó después. */
function elegirMensajeObjetivo_(mensajes) {
  const propias = CONFIG.DIRECCIONES_PROPIAS.map(x => x.toLowerCase());
  const esPropio = m => propias.indexOf(parsearRemitente_(m.getFrom()).email) >= 0;
  for (let i = mensajes.length - 1; i >= 0; i--) {
    if (!esPropio(mensajes[i])) {
      return { mensaje: mensajes[i], ultimoEsPropio: esPropio(mensajes[mensajes.length - 1]) };
    }
  }
  return null;
}

function parsearRemitente_(from) {
  const m = String(from).match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  const email = (m ? m[2] : String(from)).trim().toLowerCase();
  const nombre = (m ? m[1] : '').trim() || email.split('@')[0];
  return { nombre: nombre, email: email };
}

function esDominioInterno_(email) {
  return CONFIG.DOMINIOS_INTERNOS.some(dom => email.endsWith('@' + dom));
}

function claveDominio_(email) {
  const stem = (String(email).split('@')[1] || '').split('.')[0];
  if (['gmail', 'hotmail', 'outlook', 'yahoo', 'icloud', 'live'].indexOf(stem) >= 0) return '';
  return clavePlana_(stem);
}

/** Quita citas de mensajes anteriores y recorta (evita analizar el hilo viejo). */
function limpiarCuerpo_(texto) {
  const salida = [];
  for (const l of String(texto || '').split(/\r?\n/)) {
    if (/^\s*>/.test(l)) continue;
    if (/^\s*(el .{5,80} escribi[oó]:|on .{5,80} wrote:|-{2,}\s*(mensaje original|original message))/i.test(l)) break;
    salida.push(l);
  }
  return salida.join('\n').trim().slice(0, 6000);
}

/** Convierte Date o "dd/MM/yyyy HH:mm" en milisegundos (null si no se entiende). */
function parsearFecha_(v) {
  if (v instanceof Date) return v.getTime();
  const m = String(v).match(/(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}))?/);
  return m ? new Date(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0)).getTime() : null;
}

function leerColumna_(hoja, col) {
  if (!col) return [];
  const ultima = hoja.getLastRow();
  if (ultima < 2) return [];
  return hoja.getRange(2, col, ultima - 1, 1).getValues().map(r => String(r[0]).trim()).filter(Boolean);
}

/**
 * Neutraliza "inyección de fórmulas": un texto de un email que empiece por = + - @
 * se guardaría como fórmula. El apóstrofo inicial fuerza texto (no se ve en la celda).
 * También recorta para no superar el límite de celda.
 */
function seguro_(v) {
  if (typeof v !== 'string') return v;
  const t = v.length > 5000 ? v.slice(0, 5000) + '…' : v;
  return /^[=+\-@\t\r]/.test(t) ? "'" + t : t;
}
