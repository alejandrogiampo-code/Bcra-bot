const TelegramBot = require("node-telegram-bot-api");
const AdmZip = require("adm-zip");
const cron = require("node-cron");

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) { console.error("Falta BOT_TOKEN"); process.exit(1); }

const bot = new TelegramBot(TOKEN, { polling: true });

// ── Lista blanca ──────────────────────────────────────────────────────────────
const ALLOWED_USERS = process.env.ALLOWED_USERS
  ? new Set(process.env.ALLOWED_USERS.split(",").map(id => id.trim()))
  : null;
function usuarioAutorizado(msg) {
  if (!ALLOWED_USERS) return true;
  return ALLOWED_USERS.has(String(msg.from?.id));
}
function rechazarAcceso(chatId) {
  bot.sendMessage(chatId, "🔒 No tenes acceso a este bot.");
}

// ── Situaciones ───────────────────────────────────────────────────────────────
const SITS = {
  1:{emoji:"🟢",label:"Normal"},2:{emoji:"🟡",label:"Riesgo bajo"},
  3:{emoji:"🟠",label:"Riesgo medio"},4:{emoji:"🔴",label:"Riesgo alto"},
  5:{emoji:"⛔",label:"Irrecuperable"},6:{emoji:"🔵",label:"Irrecup. Tecnica"},
};

// ── Base en memoria ───────────────────────────────────────────────────────────
// { cuit: [ { nroCheque, fecha, monto, causal, banco, cuenta, pagado } ] }
let baseCheques = {};
let ultimaActualizacion = null;
let estadoBase = "iniciando";
let muestraDebug = null; // primeras lineas reales para debug

function parseCuit(v) { return v.replace(/\D/g, ""); }
function formatCuit(c) {
  if (c.length !== 11) return c;
  return c.slice(0,2)+"-"+c.slice(2,10)+"-"+c.slice(10);
}
function formatMonto(m) {
  return "$" + Number(m).toLocaleString("es-AR",{minimumFractionDigits:2});
}
function parseFecha(s) {
  if (!s || s.length < 8) return s;
  return s.slice(6,8)+"/"+s.slice(4,6)+"/"+s.slice(0,4);
}

async function fetchJSON(url) {
  const c = new AbortController();
  const t = setTimeout(()=>c.abort(), 15000);
  try {
    const r = await fetch(url,{signal:c.signal,headers:{Accept:"application/json","User-Agent":"Mozilla/5.0"}});
    clearTimeout(t);
    if(!r.ok) return null;
    return await r.json();
  } catch(e){ clearTimeout(t); return null; }
}

async function fetchZip(url) {
  const c = new AbortController();
  const t = setTimeout(()=>c.abort(), 30000);
  try {
    const r = await fetch(url,{signal:c.signal,headers:{"User-Agent":"Mozilla/5.0"}});
    clearTimeout(t);
    if(!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch(e){ clearTimeout(t); return null; }
}

// ── Parseo del TXT del BCRA ───────────────────────────────────────────────────
// Formato segun documentacion "A 8340" del BCRA
// El archivo tiene registros de longitud fija.
// Primero intentamos detectar la longitud real de la primera linea.
function parsearArchivo(contenido) {
  const lineas = contenido.split(/\r?\n/).filter(l => l.length > 0);
  if (lineas.length === 0) return 0;

  // Guardar muestra para debug (primeras 3 lineas)
  if (!muestraDebug) {
    muestraDebug = lineas.slice(0,3).map(l =>
      "len=" + l.length + " | " + l.slice(0,80)
    ).join("\n");
    console.log("Muestra de lineas:\n" + muestraDebug);
  }

  let procesados = 0;
  const longLinea = lineas[0].length;

  lineas.forEach(linea => {
    if (linea.length < 60) return;

    const tipo = linea[0]; // A=alta, B=baja, M=modif
    if (!["A","B","M"].includes(tipo)) return;

    let cuit, nroCheque, fechaStr, montoStr, causalCod, codEntidad, cuenta;

    if (longLinea >= 100) {
      // Formato largo (probablemente el correcto segun A8340)
      // pos 0: tipo (1)
      // pos 1-3: cod entidad (3)
      // pos 4-8: sucursal (5)
      // pos 9-18: nro cuenta (10)
      // pos 19-26: nro cheque (8)
      // pos 27-32: aviso (6)
      // pos 33: cod movimiento (1)
      // pos 34: clase registro (1)
      // pos 35-42: fecha notificacion (8)
      // pos 43-44: causal (2)
      // pos 45-46: moneda (2)
      // pos 47-61: importe (15, 2 decimales)
      // pos 62-69: fecha rechazo (8)
      // pos 70: tipo cheque (1)
      // pos 71-81: CUIT librador (11)
      codEntidad = linea.slice(1,4).trim();
      cuenta     = linea.slice(9,19).trim();
      nroCheque  = linea.slice(19,27).trim().replace(/^0+/,"");
      causalCod  = linea.slice(43,45).trim();
      montoStr   = linea.slice(47,62).trim();
      fechaStr   = linea.slice(62,70).trim();
      cuit       = linea.slice(71,82).trim();
    } else {
      // Formato corto alternativo
      codEntidad = linea.slice(1,4).trim();
      cuenta     = linea.slice(9,19).trim();
      nroCheque  = linea.slice(19,27).trim().replace(/^0+/,"");
      causalCod  = linea.slice(36,38).trim();
      montoStr   = linea.slice(40,55).trim();
      fechaStr   = linea.slice(55,63).trim();
      cuit       = linea.slice(64,75).trim();
    }

    if (!cuit || cuit.length !== 11 || !/^\d{11}$/.test(cuit)) return;
    if (!nroCheque) return;

    const monto = montoStr ? parseFloat(montoStr)/100 : 0;
    const fecha = parseFecha(fechaStr);
    const CAUSALES = {"01":"SIN FONDOS","02":"DEFECTOS FORMALES","03":"DENUNCIADO"};
    const causal = CAUSALES[causalCod] || "SIN FONDOS";

    if (!baseCheques[cuit]) baseCheques[cuit] = [];

    if (tipo === "A") {
      const existe = baseCheques[cuit].find(c => c.nroCheque===nroCheque && c.codEntidad===codEntidad);
      if (!existe) {
        baseCheques[cuit].push({nroCheque, fecha, monto, causal, codEntidad, cuenta, pagado:false});
        procesados++;
      }
    } else if (tipo === "B") {
      const idx = baseCheques[cuit]?.findIndex(c => c.nroCheque===nroCheque && c.codEntidad===codEntidad);
      if (idx !== -1) baseCheques[cuit][idx].pagado = true;
    }
  });

  return procesados;
}

async function procesarZip(fecha) {
  const url = `https://www.bcra.gob.ar/archivos/zips/cheques/${fecha}.zip`;
  const buf = await fetchZip(url);
  if (!buf) return 0;
  try {
    const zip = new AdmZip(buf);
    let total = 0;
    zip.getEntries().forEach(entry => {
      if (entry.isDirectory) return;
      const texto = entry.getData().toString("latin1");
      total += parsearArchivo(texto);
    });
    return total;
  } catch(e) {
    console.error("Error ZIP", fecha, e.message);
    return 0;
  }
}

function generarFechas(dias) {
  const fechas = [];
  const hoy = new Date();
  for (let i = 0; i < dias; i++) {
    const d = new Date(hoy);
    d.setDate(hoy.getDate() - i);
    const dd = d.getDate().toString().padStart(2,"0");
    const mm = (d.getMonth()+1).toString().padStart(2,"0");
    fechas.push(`${d.getFullYear()}${mm}${dd}`);
  }
  return fechas;
}

async function cargaInicial() {
  console.log("Cargando base (90 dias)...");
  estadoBase = "actualizando";
  const fechas = generarFechas(90);
  let archivos = 0, registros = 0;
  for (const f of fechas) {
    const n = await procesarZip(f);
    if (n > 0) { archivos++; registros += n; }
  }
  ultimaActualizacion = new Date().toLocaleString("es-AR");
  estadoBase = "lista";
  console.log(`Base lista: ${archivos} archivos, ${registros} altas, ${Object.keys(baseCheques).length} CUITs.`);
}

async function actualizarDiario() {
  const hoy = new Date();
  const dd = hoy.getDate().toString().padStart(2,"0");
  const mm = (hoy.getMonth()+1).toString().padStart(2,"0");
  const fecha = `${hoy.getFullYear()}${mm}${dd}`;
  await procesarZip(fecha);
  ultimaActualizacion = new Date().toLocaleString("es-AR");
  console.log("Actualizacion diaria OK:", fecha);
}

// ── Respuesta ─────────────────────────────────────────────────────────────────
async function procesarCUITs(chatId, texto) {
  if (estadoBase !== "lista") {
    return bot.sendMessage(chatId,
      "⏳ La base se esta cargando por primera vez (~3 min).\nIntenta con /estado para ver cuando esta lista."
    );
  }

  const cuits = [...new Set(texto.split(/[\s,;|]+/).map(parseCuit).filter(c=>c.length===11))];
  if (cuits.length === 0) {
    if (/\d/.test(texto)) return bot.sendMessage(chatId,"⚠️ CUIT invalido (11 digitos).\nEj: 20123456789");
    return;
  }
  if (cuits.length > 10) return bot.sendMessage(chatId,"⚠️ Maximo 10 CUITs.");

  const espera = await bot.sendMessage(chatId,
    cuits.length===1 ? "🔍 Consultando "+formatCuit(cuits[0])+"..." : "🔍 Consultando "+cuits.length+" CUITs..."
  );

  const respuestas = await Promise.all(cuits.map(async cuit => {
    try {
      const deudores = await fetchJSON("https://api.bcra.gob.ar/centraldedeudores/v1.0/Deudas/"+cuit);
      const chequesLocal = baseCheques[cuit] || [];
      return {cuit, deudores, chequesLocal, error:null};
    } catch(e) {
      return {cuit, error:"No se pudo consultar."};
    }
  }));

  try { await bot.deleteMessage(chatId, espera.message_id); } catch {}

  for (const r of respuestas) {
    try {
      if (r.error) {
        await bot.sendMessage(chatId, "❌ "+formatCuit(r.cuit)+"\n"+r.error);
      } else {
        await bot.sendMessage(chatId, armarMensaje(r.cuit, r.deudores, r.chequesLocal));
      }
    } catch(e) {
      await bot.sendMessage(chatId, "❌ Error mostrando "+formatCuit(r.cuit));
    }
    if (respuestas.length > 1) await new Promise(r=>setTimeout(r,400));
  }
}

function armarMensaje(cuit, deudores, chequesLocal) {
  const fmt = formatCuit(cuit);
  const nombre = deudores?.results?.denominacion || "";
  const periodos = deudores?.results?.periodos || [];
  const lineas = [];

  lineas.push("🏦 CUIT: "+fmt);
  if (nombre) lineas.push("👤 "+nombre);
  lineas.push("");

  if (periodos.length === 0) {
    lineas.push("✅ Sin deudas en el sistema financiero.");
  } else {
    let maxSit = 0;
    periodos.forEach(p=>(p.entidades||[]).forEach(e=>{const s=parseInt(e.situacion);if(s>maxSit)maxSit=s;}));
    const sit = SITS[maxSit]||{emoji:"❓",label:"S"+maxSit};
    lineas.push("📊 Situacion maxima: S"+maxSit+" "+sit.emoji+" "+sit.label);
    lineas.push("");
    periodos.forEach(p=>{
      lineas.push("📅 Periodo: "+p.periodo);
      (p.entidades||[]).forEach(e=>{
        const s=parseInt(e.situacion);
        const sit=SITS[s]||{emoji:"❓",label:"S"+s};
        let l="  "+sit.emoji+" S"+s+" "+sit.label+" - "+(e.entidad||"Entidad");
        if(e.monto) l+="  "+formatMonto(e.monto*1000);
        lineas.push(l);
      });
      lineas.push("");
    });
  }

  lineas.push("─────────────────────");

  const sinPagar = chequesLocal.filter(c=>!c.pagado);
  const pagados  = chequesLocal.filter(c=>c.pagado);

  if (sinPagar.length > 0) {
    lineas.push("🚨 Cheques rechazados sin pagar: "+sinPagar.length);
    sinPagar.sort((a,b)=>(b.fecha||"").localeCompare(a.fecha||"")).slice(0,15).forEach(ch=>{
      lineas.push("");
      lineas.push("  N° "+ch.nroCheque+"  |  "+ch.causal);
      if (ch.fecha) lineas.push("  Fecha: "+ch.fecha);
      if (ch.monto) lineas.push("  Monto: "+formatMonto(ch.monto));
    });
    if (sinPagar.length > 15) lineas.push("  ... y "+(sinPagar.length-15)+" mas");
    if (pagados.length > 0) lineas.push("\n✅ "+pagados.length+" ya pagado(s).");
  } else if (pagados.length > 0) {
    lineas.push("✅ Tenia "+pagados.length+" cheque(s), todos ya pagados.");
  } else {
    lineas.push("✅ Sin cheques rechazados (ultimos 90 dias).");
  }

  lineas.push("");
  lineas.push("📅 Base: "+(ultimaActualizacion||"-"));
  return lineas.join("\n");
}

// ── Comandos ──────────────────────────────────────────────────────────────────
bot.onText(/\/start/, msg=>{
  if(!usuarioAutorizado(msg)) return rechazarAcceso(msg.chat.id);
  bot.sendMessage(msg.chat.id,
    "👋 Hola "+msg.from.first_name+"!\n\n"+
    "Consulto el Central de Deudores y cheques rechazados del BCRA.\n\n"+
    "Manda un CUIT o varios separados por coma:\n"+
    "20123456789\n20123456789, 27987654321\n\n"+
    "/estado - Estado de la base\n/ayuda - Ayuda"
  );
});

bot.onText(/\/estado/, msg=>{
  if(!usuarioAutorizado(msg)) return rechazarAcceso(msg.chat.id);
  const cuits = Object.keys(baseCheques).length;
  const total = Object.values(baseCheques).reduce((a,v)=>a+v.length,0);
  bot.sendMessage(msg.chat.id,
    "📊 Estado de la base:\n\n"+
    "Estado: "+estadoBase+"\n"+
    "CUITs con cheques: "+cuits.toLocaleString("es-AR")+"\n"+
    "Total registros: "+total.toLocaleString("es-AR")+"\n"+
    "Ultima actualizacion: "+(ultimaActualizacion||"pendiente")+"\n"+
    "Periodo cubierto: ultimos 90 dias"
  );
});

bot.onText(/\/debug/, msg=>{
  if(!usuarioAutorizado(msg)) return rechazarAcceso(msg.chat.id);
  bot.sendMessage(msg.chat.id,
    "🔧 Muestra de lineas del archivo BCRA:\n\n"+
    (muestraDebug || "Todavia no se proceso ningun archivo.")
  );
});

bot.onText(/\/ayuda/, msg=>{
  if(!usuarioAutorizado(msg)) return rechazarAcceso(msg.chat.id);
  bot.sendMessage(msg.chat.id,
    "📖 Situaciones:\n🟢S1 Normal\n🟡S2 Riesgo bajo\n🟠S3 Riesgo medio\n"+
    "🔴S4 Riesgo alto\n⛔S5 Irrecuperable\n🔵S6 Irrecup tecnica\n\n"+
    "Cheques: base propia del BCRA, actualizada diariamente.\n\n"+
    "/start /estado /debug /ayuda"
  );
});

bot.onText(/\/consultar (.+)/, async(msg,match)=>{
  if(!usuarioAutorizado(msg)) return rechazarAcceso(msg.chat.id);
  await procesarCUITs(msg.chat.id, match[1]);
});

bot.on("message", async msg=>{
  if(!msg.text||msg.text.startsWith("/")) return;
  if(!usuarioAutorizado(msg)) return rechazarAcceso(msg.chat.id);
  await procesarCUITs(msg.chat.id, msg.text);
});

bot.on("polling_error", err=>console.error("Polling error:", err.message));

// Actualizar todos los dias a las 8 AM Argentina
cron.schedule("0 8 * * *", actualizarDiario, {timezone:"America/Argentina/Buenos_Aires"});

console.log("Bot BCRA v3 iniciando...");
cargaInicial();
