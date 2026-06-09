const TelegramBot = require("node-telegram-bot-api");
const AdmZip = require("adm-zip");
const cron = require("node-cron");
const Database = require("better-sqlite3");
const path = require("path");

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

const DIAS_HISTORICO = parseInt(process.env.DIAS_HISTORICO || "30");

// ── Base de datos SQLite ──────────────────────────────────────────────────────
const DB_PATH = process.env.DB_PATH || "/tmp/bcra.db";
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS cheques (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cuit TEXT NOT NULL,
    banco TEXT,
    fecha_pres TEXT,
    monto REAL,
    fecha_rec TEXT,
    causal TEXT,
    pagado INTEGER DEFAULT 0,
    fecha_pago TEXT,
    estado_multa TEXT,
    UNIQUE(cuit, banco, fecha_pres, monto)
  );
  CREATE INDEX IF NOT EXISTS idx_cuit ON cheques(cuit);
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`);

const stmtInsert = db.prepare(`
  INSERT OR IGNORE INTO cheques (cuit, banco, fecha_pres, monto, fecha_rec, causal, pagado, fecha_pago, estado_multa)
  VALUES (@cuit, @banco, @fecha_pres, @monto, @fecha_rec, @causal, @pagado, @fecha_pago, @estado_multa)
`);
const stmtPagar = db.prepare(`
  UPDATE cheques SET pagado=1, fecha_pago=@fecha_pago WHERE cuit=@cuit AND banco=@banco AND fecha_pres=@fecha_pres AND ABS(monto-@monto)<0.01
`);
const stmtQuery = db.prepare(`SELECT * FROM cheques WHERE cuit=? ORDER BY fecha_pres DESC`);
const stmtCount = db.prepare(`SELECT COUNT(*) as total FROM cheques`);
const stmtCuits = db.prepare(`SELECT COUNT(DISTINCT cuit) as total FROM cheques`);
const insertBatch = db.transaction((registros) => {
  for (const r of registros) stmtInsert.run(r);
});
const pagarBatch = db.transaction((registros) => {
  for (const r of registros) stmtPagar.run(r);
});

let ultimaActualizacion = db.prepare(`SELECT value FROM meta WHERE key='ultima_act'`).get()?.value || null;
let estadoBase = "iniciando";
let muestraDebug = null;

// ── Helpers ───────────────────────────────────────────────────────────────────
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
    clearTimeout(t); if (!r.ok) return null; return await r.json();
  } catch(e) { clearTimeout(t); return null; }
}

async function fetchZip(url) {
  const c = new AbortController();
  const t = setTimeout(()=>c.abort(), 30000);
  try {
    const r = await fetch(url, {signal:c.signal, headers:{"User-Agent":"Mozilla/5.0"}});
    clearTimeout(t); if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch(e) { clearTimeout(t); return null; }
}

// ── Parser formato BCRA (81 chars) ───────────────────────────────────────────
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
  const pagado = Boolean(extra && /\d{2}\/\d{2}\/\d{4}/.test(extra));
  const fechaPago = pagado ? (extra.match(/\d{2}\/\d{2}\/\d{4}/)?.[0] || "") : "";
  const estadoMulta = !pagado && extra ? extra.trim() : "";

  return {
    cuit, banco,
    fecha_pres: fmtFecha(fechaP),
    monto,
    fecha_rec: fmtFecha(fechaRec),
    causal: causalLabel,
    pagado: pagado ? 1 : 0,
    fecha_pago: fechaPago,
    estado_multa: estadoMulta,
  };
}

// Procesa el contenido de un TXT línea por línea, en batches de 500
function parsearArchivo(contenido) {
  const lineas = contenido.split(/\r?\n/);
  if (!muestraDebug) {
    const muestra = lineas.filter(l=>l.trim()).slice(0,3);
    muestraDebug = muestra.map(l=>"len="+l.length+" | "+l.slice(0,80)).join("\n");
    console.log("Muestra:\n"+muestraDebug);
  }

  let altas = [], bajas = [], procesados = 0;

  for (const linea of lineas) {
    if (!linea.trim()) continue;
    const reg = parsearLinea(linea);
    if (!reg) continue;
    altas.push(reg);
    if (reg.pagado) bajas.push(reg);
    if (altas.length >= 500) {
      procesados += altas.length;
      insertBatch(altas);
      altas = [];
    }
  }
  if (altas.length > 0) { procesados += altas.length; insertBatch(altas); }
  if (bajas.length > 0) pagarBatch(bajas);

  return procesados;
}

async function procesarZip(fecha) {
  const url = `https://www.bcra.gob.ar/archivos/zips/cheques/${fecha}.zip`;
  const buf = await fetchZip(url);
  if (!buf) return 0;
  try {
    const zip = new AdmZip(buf);
    let total = 0;
    for (const entry of zip.getEntries()) {
      if (!entry.isDirectory) {
        total += parsearArchivo(entry.getData().toString("latin1"));
      }
    }
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
    d.setDate(hoy.getDate()-i);
    const dd = String(d.getDate()).padStart(2,"0");
    const mm = String(d.getMonth()+1).padStart(2,"0");
    res.push(`${d.getFullYear()}${mm}${dd}`);
  }
  return res;
}

async function cargaInicial() {
  console.log(`Cargando base (${DIAS_HISTORICO} dias) en SQLite...`);
  estadoBase = "actualizando";
  const fechas = generarFechas(DIAS_HISTORICO);
  let archivos = 0, registros = 0;
  for (const f of fechas) {
    const n = await procesarZip(f);
    if (n > 0) { archivos++; registros += n; }
  }
  ultimaActualizacion = new Date().toLocaleString("es-AR");
  db.prepare(`INSERT OR REPLACE INTO meta VALUES ('ultima_act', ?)`).run(ultimaActualizacion);
  estadoBase = "lista";
  const total = stmtCount.get().total;
  console.log(`Base lista: ${archivos} archivos, ${total} registros en DB.`);
}

async function actualizarDiario() {
  const hoy = new Date();
  const dd = String(hoy.getDate()).padStart(2,"0");
  const mm = String(hoy.getMonth()+1).padStart(2,"0");
  const n = await procesarZip(`${hoy.getFullYear()}${mm}${dd}`);
  ultimaActualizacion = new Date().toLocaleString("es-AR");
  db.prepare(`INSERT OR REPLACE INTO meta VALUES ('ultima_act', ?)`).run(ultimaActualizacion);
  console.log(`Actualizacion diaria: ${n} registros`);
}

// ── Armar mensaje ─────────────────────────────────────────────────────────────
function armarMensaje(cuit, deudores, cheques) {
  const fmt = formatCuit(cuit);
  const nombre = deudores?.results?.denominacion || "";
  const periodos = deudores?.results?.periodos || [];
  const L = [];

  L.push("🏦 CUIT: " + fmt);
  if (nombre) L.push("👤 " + nombre);
  L.push("");

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

  const sinPagar = cheques.filter(c=>!c.pagado);
  const pagados  = cheques.filter(c=>c.pagado);

  if (sinPagar.length > 0) {
    L.push("🚨 Cheques sin pagar: " + sinPagar.length);
    sinPagar.slice(0,15).forEach(ch=>{
      L.push("");
      L.push("  Banco: "+ch.banco+"  |  "+ch.causal);
      L.push("  Presentado: "+ch.fecha_pres);
      if (ch.fecha_rec && ch.fecha_rec!=="-") L.push("  Rechazado: "+ch.fecha_rec);
      L.push("  Monto: "+formatMonto(ch.monto));
      if (ch.estado_multa) L.push("  Multa: "+ch.estado_multa);
    });
    if (sinPagar.length>15) L.push("  ... y "+(sinPagar.length-15)+" mas");
    if (pagados.length>0) L.push("\n✅ "+pagados.length+" ya pagado(s).");
  } else if (pagados.length>0) {
    L.push("✅ Tenia "+pagados.length+" cheque(s), todos ya pagados.");
  } else {
    L.push("✅ Sin cheques rechazados (ultimos "+DIAS_HISTORICO+" dias).");
  }

  L.push("");
  L.push("📅 Base: "+(ultimaActualizacion||"-"));
  return L.join("\n");
}

// ── Procesar CUITs ────────────────────────────────────────────────────────────
async function procesarCUITs(chatId, texto) {
  if (estadoBase !== "lista") {
    return bot.sendMessage(chatId,
      "⏳ La base se esta cargando (~5 min).\nUsa /estado para ver el progreso."
    );
  }
  const cuits = [...new Set(texto.split(/[\s,;|]+/).map(parseCuit).filter(c=>c.length===11))];
  if (cuits.length===0) {
    if (/\d/.test(texto)) return bot.sendMessage(chatId,"⚠️ CUIT invalido. Ej: 20123456789");
    return;
  }
  if (cuits.length>10) return bot.sendMessage(chatId,"⚠️ Maximo 10 CUITs.");

  const espera = await bot.sendMessage(chatId,
    cuits.length===1 ? "🔍 Consultando "+formatCuit(cuits[0])+"..." : "🔍 Consultando "+cuits.length+" CUITs..."
  );

  const resps = await Promise.all(cuits.map(async cuit => {
    try {
      const deudores = await fetchJSON("https://api.bcra.gob.ar/centraldedeudores/v1.0/Deudas/"+cuit);
      const cheques = stmtQuery.all(cuit);
      return {cuit, deudores, cheques, error:null};
    } catch { return {cuit, error:"Error al consultar."}; }
  }));

  try { await bot.deleteMessage(chatId, espera.message_id); } catch {}

  for (const r of resps) {
    try {
      await bot.sendMessage(chatId,
        r.error ? "❌ "+formatCuit(r.cuit)+"\n"+r.error
                : armarMensaje(r.cuit, r.deudores, r.cheques)
      );
    } catch(e) {
      await bot.sendMessage(chatId,"❌ Error mostrando "+formatCuit(r.cuit));
    }
    if (resps.length>1) await new Promise(r=>setTimeout(r,400));
  }
}

// ── Comandos ──────────────────────────────────────────────────────────────────
bot.onText(/\/start/, msg=>{
  if(!usuarioAutorizado(msg)) return rechazarAcceso(msg.chat.id);
  bot.sendMessage(msg.chat.id,
    "👋 Hola "+msg.from.first_name+"!\n\n"+
    "Consulto el Central de Deudores y cheques rechazados del BCRA.\n\n"+
    "Manda un CUIT o varios separados por coma:\n20123456789\n20123456789, 27987654321\n\n"+
    "/estado - Ver estado\n/ayuda - Ayuda"
  );
});

bot.onText(/\/estado/, msg=>{
  if(!usuarioAutorizado(msg)) return rechazarAcceso(msg.chat.id);
  const total = stmtCount.get().total;
  const cuits = stmtCuits.get().total;
  const mem = Math.round(process.memoryUsage().heapUsed/1024/1024);
  bot.sendMessage(msg.chat.id,
    "📊 Estado:\n\nEstado: "+estadoBase+
    "\nRegistros en DB: "+total.toLocaleString("es-AR")+
    "\nCUITs con cheques: "+cuits.toLocaleString("es-AR")+
    "\nRAM usada: "+mem+" MB"+
    "\nUltima act.: "+(ultimaActualizacion||"pendiente")+
    "\nPeriodo: ultimos "+DIAS_HISTORICO+" dias"
  );
});

bot.onText(/\/debug/, msg=>{
  if(!usuarioAutorizado(msg)) return rechazarAcceso(msg.chat.id);
  bot.sendMessage(msg.chat.id,"🔧 Muestra:\n\n"+(muestraDebug||"Sin datos aun."));
});

bot.onText(/\/ayuda/, msg=>{
  if(!usuarioAutorizado(msg)) return rechazarAcceso(msg.chat.id);
  bot.sendMessage(msg.chat.id,
    "📖 Situaciones:\n🟢S1 Normal\n🟡S2 Riesgo bajo\n🟠S3 Riesgo medio\n"+
    "🔴S4 Riesgo alto\n⛔S5 Irrecuperable\n🔵S6 Irrecup tecnica\n\n"+
    "Cheques: base propia del BCRA, actualizada cada dia a las 8 AM.\n\n"+
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

console.log("Bot BCRA v6 (SQLite) iniciando...");
cargaInicial();
