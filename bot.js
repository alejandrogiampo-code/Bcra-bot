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

const SITS = {
  1:{emoji:"🟢",label:"Normal"},2:{emoji:"🟡",label:"Riesgo bajo"},
  3:{emoji:"🟠",label:"Riesgo medio"},4:{emoji:"🔴",label:"Riesgo alto"},
  5:{emoji:"⛔",label:"Irrecuperable"},6:{emoji:"🔵",label:"Irrecup. Tecnica"},
};

// ── Base en memoria ───────────────────────────────────────────────────────────
let baseCheques = {};       // { cuit: [ {banco, fechaPres, monto, fechaRec, causal, pagado, fechaPago} ] }
let ultimaActualizacion = null;
let estadoBase = "iniciando";
let muestraDebug = null;

function parseCuit(v) { return v.replace(/\D/g, ""); }
function formatCuit(c) {
  if (c.length !== 11) return c;
  return c.slice(0,2)+"-"+c.slice(2,10)+"-"+c.slice(10);
}
function formatMonto(m) {
  return "$" + Number(m).toLocaleString("es-AR", {minimumFractionDigits:2});
}
function fmtFecha(f) {
  if (f && f.length===8 && /^\d{8}$/.test(f))
    return f.slice(6,8)+"/"+f.slice(4,6)+"/"+f.slice(0,4);
  return f || "-";
}

async function fetchJSON(url) {
  const c = new AbortController();
  const t = setTimeout(()=>c.abort(), 15000);
  try {
    const r = await fetch(url, {signal:c.signal, headers:{Accept:"application/json","User-Agent":"Mozilla/5.0"}});
    clearTimeout(t);
    if (!r.ok) return null;
    return await r.json();
  } catch(e) { clearTimeout(t); return null; }
}

async function fetchZip(url) {
  const c = new AbortController();
  const t = setTimeout(()=>c.abort(), 30000);
  try {
    const r = await fetch(url, {signal:c.signal, headers:{"User-Agent":"Mozilla/5.0"}});
    clearTimeout(t);
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch(e) { clearTimeout(t); return null; }
}

// ── Parser del formato real del BCRA (81 chars por linea) ────────────────────
// Formato detectado empiricamente:
// 0-10:  CUIT (11)
// 11-15: espacios (5)
// 16-18: codigo banco (3)
// 19-26: fecha presentacion al cobro AAAAMMDD (8)
// 27:    espacio
// 28-38: monto en centavos (11)
// 39:    espacio
// 40-49: si empieza con digito: fechaRechazo(8)+causal(2), si no: causal(2)+espacios
// 50+:   estado multa o fecha de pago
function parsearLinea(linea) {
  const l = linea.padEnd(81);
  const cuit = l.slice(0,11).trim();
  if (!/^\d{11}$/.test(cuit)) return null;

  const banco    = l.slice(16,19).trim();
  const fechaP   = l.slice(19,27).trim();
  const montoRaw = l.slice(28,39).trim();
  const bloque   = l.slice(40,50).trim();

  let fechaRec, causal, extra;

  if (bloque && /^\d/.test(bloque) && bloque.length >= 8) {
    fechaRec = bloque.slice(0,8);
    causal   = bloque.slice(8,10).trim();
    extra    = l.slice(50,81).trim();
  } else {
    fechaRec = "";
    causal   = l.slice(40,42).trim();
    extra    = l.slice(49,81).trim();
  }

  const monto = /^\d+$/.test(montoRaw) ? parseInt(montoRaw) / 100 : 0;
  const CAUSALES = {"SF":"SIN FONDOS","DF":"DEFECTOS FORMALES","DE":"DENUNCIADO"};
  const causalLabel = CAUSALES[causal] || (causal || "SIN FONDOS");

  // Pagado si extra contiene fecha en formato dd/mm/aaaa o aaaammdd
  const pagado = Boolean(extra && (/\d{2}\/\d{2}\/\d{4}/.test(extra) || /^\d{8}$/.test(extra)));
  const fechaPago = pagado ? extra.match(/\d{2}\/\d{2}\/\d{4}/)?.[0] || extra : "";
  const estadoMulta = !pagado && extra ? extra : "";

  return {
    cuit, banco,
    fechaPres: fmtFecha(fechaP),
    monto,
    fechaRec: fmtFecha(fechaRec),
    causal: causalLabel,
    pagado,
    fechaPago,
    estadoMulta,
  };
}

function parsearArchivo(contenido) {
  const lineas = contenido.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (!muestraDebug && lineas.length > 0) {
    muestraDebug = lineas.slice(0,3).map(l => "len="+l.length+" | "+l.slice(0,80)).join("\n");
    console.log("Debug muestra:\n" + muestraDebug);
  }

  let procesados = 0;
  lineas.forEach(linea => {
    const reg = parsearLinea(linea);
    if (!reg) return;
    const {cuit, ...datos} = reg;
    if (!baseCheques[cuit]) baseCheques[cuit] = [];
    // Evitar duplicados: misma combinacion banco+fechaPres
    const existe = baseCheques[cuit].find(c => c.banco===datos.banco && c.fechaPres===datos.fechaPres && c.monto===datos.monto);
    if (!existe) {
      baseCheques[cuit].push(datos);
      procesados++;
    } else if (datos.pagado && !existe.pagado) {
      // Actualizar si ahora esta pagado
      Object.assign(existe, {pagado:true, fechaPago:datos.fechaPago});
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
      if (!entry.isDirectory) {
        total += parsearArchivo(entry.getData().toString("latin1"));
      }
    });
    return total;
  } catch(e) {
    console.error("Error ZIP", fecha, e.message);
    return 0;
  }
}

function generarFechas(dias) {
  const res = [];
  const hoy = new Date();
  for (let i = 0; i < dias; i++) {
    const d = new Date(hoy);
    d.setDate(hoy.getDate() - i);
    const dd = String(d.getDate()).padStart(2,"0");
    const mm = String(d.getMonth()+1).padStart(2,"0");
    res.push(`${d.getFullYear()}${mm}${dd}`);
  }
  return res;
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
  console.log(`Base lista: ${archivos} archivos, ${registros} registros, ${Object.keys(baseCheques).length} CUITs.`);
}

async function actualizarDiario() {
  const hoy = new Date();
  const dd = String(hoy.getDate()).padStart(2,"0");
  const mm = String(hoy.getMonth()+1).padStart(2,"0");
  const fecha = `${hoy.getFullYear()}${mm}${dd}`;
  const n = await procesarZip(fecha);
  ultimaActualizacion = new Date().toLocaleString("es-AR");
  console.log(`Actualizacion diaria ${fecha}: ${n} registros`);
}

// ── Armar mensaje ─────────────────────────────────────────────────────────────
function armarMensaje(cuit, deudores, chequesLocal) {
  const fmt = formatCuit(cuit);
  const nombre = deudores?.results?.denominacion || "";
  const periodos = deudores?.results?.periodos || [];
  const L = [];

  L.push("🏦 CUIT: " + fmt);
  if (nombre) L.push("👤 " + nombre);
  L.push("");

  // Situacion crediticia
  if (periodos.length === 0) {
    L.push("✅ Sin deudas en el sistema financiero.");
  } else {
    let maxSit = 0;
    periodos.forEach(p=>(p.entidades||[]).forEach(e=>{const s=parseInt(e.situacion);if(s>maxSit)maxSit=s;}));
    const sit = SITS[maxSit]||{emoji:"❓",label:"S"+maxSit};
    L.push("📊 Situacion maxima: S"+maxSit+" "+sit.emoji+" "+sit.label);
    L.push("");
    periodos.forEach(p=>{
      L.push("📅 Periodo: "+p.periodo);
      (p.entidades||[]).forEach(e=>{
        const s=parseInt(e.situacion), sit=SITS[s]||{emoji:"❓",label:"S"+s};
        let li="  "+sit.emoji+" S"+s+" "+sit.label+" - "+(e.entidad||"Entidad");
        if(e.monto) li+="  "+formatMonto(e.monto*1000);
        L.push(li);
      });
      L.push("");
    });
  }

  L.push("─────────────────────");

  const sinPagar = chequesLocal.filter(c=>!c.pagado);
  const pagados  = chequesLocal.filter(c=>c.pagado);

  if (sinPagar.length > 0) {
    L.push("🚨 Cheques rechazados SIN PAGAR: " + sinPagar.length);
    // Ordenar por fecha mas reciente
    sinPagar.sort((a,b)=>(b.fechaPres||"").localeCompare(a.fechaPres||"")).slice(0,15).forEach(ch=>{
      L.push("");
      L.push("  Banco: " + ch.banco + "  |  " + ch.causal);
      L.push("  Presentado: " + ch.fechaPres);
      if (ch.fechaRec && ch.fechaRec !== "-") L.push("  Rechazado: " + ch.fechaRec);
      L.push("  Monto: " + formatMonto(ch.monto));
      if (ch.estadoMulta) L.push("  Multa: " + ch.estadoMulta);
    });
    if (sinPagar.length > 15) L.push("  ... y "+(sinPagar.length-15)+" mas");
    if (pagados.length > 0) L.push("\n✅ "+pagados.length+" cheque(s) ya pagado(s).");
  } else if (pagados.length > 0) {
    L.push("✅ Tenia "+pagados.length+" cheque(s) rechazado(s), todos ya pagados.");
  } else {
    L.push("✅ Sin cheques rechazados (ultimos 90 dias).");
  }

  L.push("");
  L.push("📅 Base: " + (ultimaActualizacion||"-"));
  return L.join("\n");
}

// ── Procesar CUITs ────────────────────────────────────────────────────────────
async function procesarCUITs(chatId, texto) {
  if (estadoBase !== "lista") {
    return bot.sendMessage(chatId,
      "⏳ La base se esta cargando (~3 min).\nUsa /estado para ver cuando esta lista."
    );
  }
  const cuits = [...new Set(texto.split(/[\s,;|]+/).map(parseCuit).filter(c=>c.length===11))];
  if (cuits.length === 0) {
    if (/\d/.test(texto)) return bot.sendMessage(chatId,"⚠️ CUIT invalido. Ej: 20123456789");
    return;
  }
  if (cuits.length > 10) return bot.sendMessage(chatId,"⚠️ Maximo 10 CUITs.");

  const espera = await bot.sendMessage(chatId,
    cuits.length===1 ? "🔍 Consultando "+formatCuit(cuits[0])+"..." : "🔍 Consultando "+cuits.length+" CUITs..."
  );

  const resps = await Promise.all(cuits.map(async cuit => {
    try {
      const deudores = await fetchJSON("https://api.bcra.gob.ar/centraldedeudores/v1.0/Deudas/"+cuit);
      return {cuit, deudores, chequesLocal: baseCheques[cuit]||[], error:null};
    } catch { return {cuit, error:"Error al consultar."}; }
  }));

  try { await bot.deleteMessage(chatId, espera.message_id); } catch {}

  for (const r of resps) {
    try {
      await bot.sendMessage(chatId,
        r.error ? "❌ "+formatCuit(r.cuit)+"\n"+r.error : armarMensaje(r.cuit, r.deudores, r.chequesLocal)
      );
    } catch(e) {
      await bot.sendMessage(chatId, "❌ Error mostrando "+formatCuit(r.cuit));
    }
    if (resps.length > 1) await new Promise(r=>setTimeout(r,400));
  }
}

// ── Comandos ──────────────────────────────────────────────────────────────────
bot.onText(/\/start/, msg=>{
  if(!usuarioAutorizado(msg)) return rechazarAcceso(msg.chat.id);
  bot.sendMessage(msg.chat.id,
    "👋 Hola "+msg.from.first_name+"!\n\n"+
    "Consulto el Central de Deudores y cheques rechazados del BCRA.\n\n"+
    "Manda un CUIT o varios separados por coma:\n"+
    "20123456789\n20123456789, 27987654321\n\n"+
    "/estado - Ver estado de la base\n/ayuda - Ayuda"
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
    "Ultima act.: "+(ultimaActualizacion||"pendiente")+"\n"+
    "Periodo: ultimos 90 dias"
  );
});

bot.onText(/\/debug/, msg=>{
  if(!usuarioAutorizado(msg)) return rechazarAcceso(msg.chat.id);
  bot.sendMessage(msg.chat.id,
    "🔧 Muestra de lineas BCRA:\n\n"+(muestraDebug||"Todavia no se proceso ningun archivo.")
  );
});

bot.onText(/\/ayuda/, msg=>{
  if(!usuarioAutorizado(msg)) return rechazarAcceso(msg.chat.id);
  bot.sendMessage(msg.chat.id,
    "📖 Situaciones:\n🟢S1 Normal\n🟡S2 Riesgo bajo\n🟠S3 Riesgo medio\n"+
    "🔴S4 Riesgo alto\n⛔S5 Irrecuperable\n🔵S6 Irrecup tecnica\n\n"+
    "Cheques: base propia actualizada diariamente desde el BCRA.\n\n"+
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

cron.schedule("0 8 * * *", actualizarDiario, {timezone:"America/Argentina/Buenos_Aires"});

console.log("Bot BCRA v4 iniciando...");
cargaInicial();
