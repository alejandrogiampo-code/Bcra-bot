const TelegramBot = require("node-telegram-bot-api");
const AdmZip = require("adm-zip");
const cron = require("node-cron");
const Database = require("better-sqlite3");

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) { console.error("Falta BOT_TOKEN"); process.exit(1); }

const bot = new TelegramBot(TOKEN, { polling: true });

const ALLOWED_USERS = process.env.ALLOWED_USERS
  ? new Set(process.env.ALLOWED_USERS.split(",").map(id => id.trim()))
  : null;
function usuarioAutorizado(msg) {
  if (!ALLOWED_USERS) return true;
  return ALLOWED_USERS.has(String(msg.from?.id));
}
function rechazarAcceso(chatId) { bot.sendMessage(chatId, "🔒 No tenes acceso."); }

const SITS = {
  1:{emoji:"🟢",label:"Normal"},2:{emoji:"🟡",label:"Riesgo bajo"},
  3:{emoji:"🟠",label:"Riesgo medio"},4:{emoji:"🔴",label:"Riesgo alto"},
  5:{emoji:"⛔",label:"Irrecuperable"},6:{emoji:"🔵",label:"Irrecup. Tecnica"},
};

const DIAS = parseInt(process.env.DIAS_HISTORICO || "30");
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
    UNIQUE(cuit, banco, fecha_pres, monto)
  );
  CREATE INDEX IF NOT EXISTS idx_cuit ON cheques(cuit);
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`);

const stmtInsert = db.prepare(`
  INSERT OR IGNORE INTO cheques (cuit,banco,fecha_pres,monto,fecha_rec,causal,pagado,fecha_pago)
  VALUES (@cuit,@banco,@fecha_pres,@monto,@fecha_rec,@causal,@pagado,@fecha_pago)
`);
const stmtPagar = db.prepare(`
  UPDATE cheques SET pagado=1,fecha_pago=@fecha_pago
  WHERE cuit=@cuit AND banco=@banco AND fecha_pres=@fecha_pres AND ABS(monto-@monto)<1
`);
const stmtQuery  = db.prepare(`SELECT * FROM cheques WHERE cuit=? ORDER BY fecha_pres DESC`);
const stmtCount  = db.prepare(`SELECT COUNT(*) as n FROM cheques`);
const stmtCuits  = db.prepare(`SELECT COUNT(DISTINCT cuit) as n FROM cheques`);
const batchIns   = db.transaction(rows => { for(const r of rows) stmtInsert.run(r); });
const batchPag   = db.transaction(rows => { for(const r of rows) stmtPagar.run(r); });

let ultimaAct = db.prepare(`SELECT value FROM meta WHERE key='ultima_act'`).get()?.value || null;
let estadoBase = "iniciando";
let muestraDebug = null;

function parseCuit(v) { return v.replace(/\D/g,""); }
function formatCuit(c) { return c.length===11 ? c.slice(0,2)+"-"+c.slice(2,10)+"-"+c.slice(10) : c; }
function formatMonto(m) { return "$"+Number(m).toLocaleString("es-AR",{minimumFractionDigits:2}); }
function fmtFechaYMD(f) {
  // AAAAMMDD -> DD/MM/AAAA
  if (f && f.length===8 && /^\d{8}$/.test(f))
    return f.slice(6,8)+"/"+f.slice(4,6)+"/"+f.slice(0,4);
  return f||"-";
}

async function fetchJSON(url) {
  const c=new AbortController(), t=setTimeout(()=>c.abort(),15000);
  try {
    const r=await fetch(url,{signal:c.signal,headers:{Accept:"application/json","User-Agent":"Mozilla/5.0"}});
    clearTimeout(t); if(!r.ok) return null; return await r.json();
  } catch(e){clearTimeout(t);return null;}
}
async function fetchZip(url) {
  const c=new AbortController(), t=setTimeout(()=>c.abort(),30000);
  try {
    const r=await fetch(url,{signal:c.signal,headers:{"User-Agent":"Mozilla/5.0"}});
    clearTimeout(t); if(!r.ok) return null; return Buffer.from(await r.arrayBuffer());
  } catch(e){clearTimeout(t);return null;}
}

// ── Parser BCRA (formato real 81 chars) ──────────────────────────────────────
// Posiciones confirmadas empiricamente:
// 00-10: CUIT librador (11)
// 11-17: espacios
// 18-28: banco(3) + fecha_presentacion AAAAMMDD (8) -- a veces con espacio inicial
// 34-44: monto en centavos (11) -- longitud fija
// 45-52: fecha rechazo AAAAMMDD (8) -- puede estar vacio (espacios)
// 53-54: causal (2): SF=sin fondos, DF=defectos formales, DE=denunciado
// 65-75: fecha pago DD/MM/AAAA o "IMPAGA" o espacios
function parsearLinea(linea) {
  const l = linea.padEnd(81);
  const cuit = l.slice(0,11).trim();
  if (!/^\d{11}$/.test(cuit)) return null;

  // Banco + fecha presentacion (pos 18-28, 11 chars)
  const bc_raw   = l.slice(18,29).trim();
  const banco    = bc_raw.slice(0,3).replace(/\D/g,"").padStart(3,"0") || "---";
  const fechaP   = bc_raw.slice(3).trim();

  // Monto fijo 11 chars pos 34-44
  const montoRaw = l.slice(34,45).trim();
  const monto    = /^\d+$/.test(montoRaw) ? parseInt(montoRaw)/100 : 0;

  // Fecha rechazo pos 45-52 (8 chars)
  const fechaRecRaw = l.slice(45,53).trim();

  // Causal pos 53-54
  const causalRaw = l.slice(53,55).trim();
  const CAUSALES  = {"SF":"SIN FONDOS","DF":"DEFECTOS FORMALES","DE":"DENUNCIADO"};
  const causal    = CAUSALES[causalRaw] || (causalRaw||"SIN FONDOS");

  // Estado pago pos 65-76
  const estado   = l.slice(65,76).trim();
  const pagado   = /\d{2}\/\d{2}\/\d{4}/.test(estado) ? 1 : 0;
  const fechaPago= pagado ? (estado.match(/\d{2}\/\d{2}\/\d{4}/)||[""])[0] : "";

  return {
    cuit,
    banco,
    fecha_pres: fmtFechaYMD(fechaP),
    monto,
    fecha_rec:  fmtFechaYMD(fechaRecRaw),
    causal,
    pagado,
    fecha_pago: fechaPago,
  };
}

function parsearArchivo(contenido) {
  const lineas = contenido.split(/\r?\n/).filter(l=>l.trim());
  if (!muestraDebug && lineas.length>0) {
    muestraDebug = lineas.slice(0,3).map(l=>"len="+l.length+" | "+l.slice(0,80)).join("\n");
    console.log("Debug:\n"+muestraDebug);
  }
  let altas=[], bajas=[], n=0;
  for (const linea of lineas) {
    const reg = parsearLinea(linea);
    if (!reg) continue;
    altas.push(reg);
    if (reg.pagado) bajas.push(reg);
    if (altas.length>=500) { batchIns(altas); n+=altas.length; altas=[]; }
  }
  if (altas.length) { batchIns(altas); n+=altas.length; }
  if (bajas.length) batchPag(bajas);
  return n;
}

async function procesarZip(fecha) {
  const buf = await fetchZip(`https://www.bcra.gob.ar/archivos/zips/cheques/${fecha}.zip`);
  if (!buf) return 0;
  try {
    const zip=new AdmZip(buf); let total=0;
    for (const e of zip.getEntries()) {
      if (!e.isDirectory) total += parsearArchivo(e.getData().toString("latin1"));
    }
    return total;
  } catch(e) { console.error("ZIP error",fecha,e.message); return 0; }
}

function fechas(dias) {
  const res=[], hoy=new Date();
  for(let i=0;i<dias;i++){
    const d=new Date(hoy); d.setDate(hoy.getDate()-i);
    res.push(`${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}`);
  }
  return res;
}

async function cargaInicial() {
  console.log(`Cargando ${DIAS} dias...`);
  estadoBase="actualizando";
  let arch=0,regs=0;
  for (const f of fechas(DIAS)) {
    const n=await procesarZip(f);
    if(n>0){arch++;regs+=n;}
  }
  ultimaAct=new Date().toLocaleString("es-AR");
  db.prepare(`INSERT OR REPLACE INTO meta VALUES('ultima_act',?)`).run(ultimaAct);
  estadoBase="lista";
  console.log(`Base lista: ${arch} arch, ${stmtCount.get().n} registros.`);
}

async function actualizarDiario() {
  const hoy=new Date();
  const f=`${hoy.getFullYear()}${String(hoy.getMonth()+1).padStart(2,"0")}${String(hoy.getDate()).padStart(2,"0")}`;
  await procesarZip(f);
  ultimaAct=new Date().toLocaleString("es-AR");
  db.prepare(`INSERT OR REPLACE INTO meta VALUES('ultima_act',?)`).run(ultimaAct);
}

// ── Mensaje ───────────────────────────────────────────────────────────────────
function armarMensaje(cuit, deudores, cheques) {
  const fmt=formatCuit(cuit);
  const nombre=deudores?.results?.denominacion||"";
  const periodos=deudores?.results?.periodos||[];
  const L=[];

  L.push("🏦 CUIT: "+fmt);
  if(nombre) L.push("👤 "+nombre);
  L.push("");

  if(periodos.length===0){
    L.push("✅ Sin deudas en el sistema financiero.");
  } else {
    let max=0;
    periodos.forEach(p=>(p.entidades||[]).forEach(e=>{const s=parseInt(e.situacion);if(s>max)max=s;}));
    const sit=SITS[max]||{emoji:"❓",label:"S"+max};
    L.push("📊 Situacion maxima: S"+max+" "+sit.emoji+" "+sit.label);
    L.push("");
    periodos.forEach(p=>{
      L.push("📅 Periodo: "+p.periodo);
      (p.entidades||[]).forEach(e=>{
        const s=parseInt(e.situacion),sit=SITS[s]||{emoji:"❓",label:"S"+s};
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

  if(sinPagar.length>0){
    L.push("🚨 Cheques sin pagar: "+sinPagar.length);
    sinPagar.slice(0,15).forEach(ch=>{
      L.push("");
      L.push("  Banco: "+ch.banco+"  |  "+ch.causal);
      L.push("  Presentado: "+ch.fecha_pres);
      if(ch.fecha_rec&&ch.fecha_rec!=="-") L.push("  Rechazado: "+ch.fecha_rec);
      L.push("  Monto: "+formatMonto(ch.monto));
    });
    if(sinPagar.length>15) L.push("  ... y "+(sinPagar.length-15)+" mas");
    if(pagados.length>0) L.push("\n✅ "+pagados.length+" ya regularizado(s).");
  } else if(pagados.length>0){
    L.push("✅ Cheques ya regularizados: "+pagados.length);
    pagados.slice(0,15).forEach(ch=>{
      L.push("");
      L.push("  Banco: "+ch.banco+"  |  "+ch.causal);
      L.push("  Presentado: "+ch.fecha_pres);
      if(ch.fecha_rec&&ch.fecha_rec!=="-") L.push("  Rechazado: "+ch.fecha_rec);
      L.push("  Monto: "+formatMonto(ch.monto));
      if(ch.fecha_pago) L.push("  ✅ Pagado: "+ch.fecha_pago);
    });
    if(pagados.length>15) L.push("  ... y "+(pagados.length-15)+" mas");
  } else {
    L.push("✅ Sin cheques rechazados (ultimos "+DIAS+" dias).");
  }

  L.push("");
  L.push("📅 Base: "+(ultimaAct||"-"));
  return L.join("\n");
}

// ── Procesar ──────────────────────────────────────────────────────────────────
async function procesarCUITs(chatId, texto) {
  if(estadoBase!=="lista")
    return bot.sendMessage(chatId,"⏳ Base cargando (~5 min). Usa /estado para ver el progreso.");
  const cuits=[...new Set(texto.split(/[\s,;|]+/).map(parseCuit).filter(c=>c.length===11))];
  if(cuits.length===0){
    if(/\d/.test(texto)) return bot.sendMessage(chatId,"⚠️ CUIT invalido. Ej: 20123456789");
    return;
  }
  if(cuits.length>10) return bot.sendMessage(chatId,"⚠️ Maximo 10 CUITs.");
  const espera=await bot.sendMessage(chatId,
    cuits.length===1?"🔍 Consultando "+formatCuit(cuits[0])+"...":"🔍 Consultando "+cuits.length+" CUITs..."
  );
  const resps=await Promise.all(cuits.map(async cuit=>{
    try {
      const deudores=await fetchJSON("https://api.bcra.gob.ar/centraldedeudores/v1.0/Deudas/"+cuit);
      return {cuit,deudores,cheques:stmtQuery.all(cuit),error:null};
    } catch {return {cuit,error:"Error al consultar."};}
  }));
  try{await bot.deleteMessage(chatId,espera.message_id);}catch{}
  for(const r of resps){
    try{
      await bot.sendMessage(chatId,
        r.error?"❌ "+formatCuit(r.cuit)+"\n"+r.error:armarMensaje(r.cuit,r.deudores,r.cheques)
      );
    }catch(e){await bot.sendMessage(chatId,"❌ Error mostrando "+formatCuit(r.cuit));}
    if(resps.length>1) await new Promise(r=>setTimeout(r,400));
  }
}

// ── Comandos ──────────────────────────────────────────────────────────────────
bot.onText(/\/start/,msg=>{
  if(!usuarioAutorizado(msg)) return rechazarAcceso(msg.chat.id);
  bot.sendMessage(msg.chat.id,
    "👋 Hola "+msg.from.first_name+"!\n\n"+
    "Consulto el Central de Deudores y cheques rechazados del BCRA.\n\n"+
    "Manda un CUIT o varios separados por coma:\n20123456789\n20123456789, 27987654321\n\n"+
    "/estado - Ver estado\n/ayuda - Ayuda"
  );
});

bot.onText(/\/estado/,msg=>{
  if(!usuarioAutorizado(msg)) return rechazarAcceso(msg.chat.id);
  const mem=Math.round(process.memoryUsage().heapUsed/1024/1024);
  bot.sendMessage(msg.chat.id,
    "📊 Estado:\n\nEstado: "+estadoBase+
    "\nRegistros: "+stmtCount.get().n.toLocaleString("es-AR")+
    "\nCUITs: "+stmtCuits.get().n.toLocaleString("es-AR")+
    "\nRAM: "+mem+" MB"+
    "\nUltima act.: "+(ultimaAct||"pendiente")+
    "\nPeriodo: ultimos "+DIAS+" dias"
  );
});

bot.onText(/\/debug/,msg=>{
  if(!usuarioAutorizado(msg)) return rechazarAcceso(msg.chat.id);
  bot.sendMessage(msg.chat.id,"🔧 Muestra:\n\n"+(muestraDebug||"Sin datos."));
});

bot.onText(/\/resetdb/,async msg=>{
  if(!usuarioAutorizado(msg)) return rechazarAcceso(msg.chat.id);
  if(estadoBase==="actualizando") return bot.sendMessage(msg.chat.id,"Ya actualizando...");
  bot.sendMessage(msg.chat.id,"🗑 Limpiando y recargando base (~5 min)...");
  db.exec("DELETE FROM cheques; DELETE FROM meta");
  muestraDebug=null;
  await cargaInicial();
  bot.sendMessage(msg.chat.id,"✅ Base recargada. Usa /estado para verificar.");
});

bot.onText(/\/ayuda/,msg=>{
  if(!usuarioAutorizado(msg)) return rechazarAcceso(msg.chat.id);
  bot.sendMessage(msg.chat.id,
    "📖 Situaciones:\n🟢S1 Normal\n🟡S2 Riesgo bajo\n🟠S3 Riesgo medio\n"+
    "🔴S4 Riesgo alto\n⛔S5 Irrecuperable\n🔵S6 Irrecup tecnica\n\n"+
    "Cheques del BCRA actualizados cada dia a las 8 AM.\n\n"+
    "/start /estado /resetdb /debug /ayuda"
  );
});

bot.onText(/\/consultar (.+)/,async(msg,match)=>{
  if(!usuarioAutorizado(msg)) return rechazarAcceso(msg.chat.id);
  await procesarCUITs(msg.chat.id,match[1]);
});

bot.on("message",async msg=>{
  if(!msg.text||msg.text.startsWith("/")) return;
  if(!usuarioAutorizado(msg)) return rechazarAcceso(msg.chat.id);
  await procesarCUITs(msg.chat.id,msg.text);
});

bot.on("polling_error",err=>console.error("Polling:",err.message));
cron.schedule("0 8 * * *",actualizarDiario,{timezone:"America/Argentina/Buenos_Aires"});

console.log("Bot BCRA v7 iniciando...");
cargaInicial();
