const TelegramBot = require("node-telegram-bot-api");
const puppeteer   = require("puppeteer");

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

function parseCuit(v) { return v.replace(/\D/g, ""); }
function formatCuit(c) { return c.length===11 ? c.slice(0,2)+"-"+c.slice(2,10)+"-"+c.slice(10) : c; }

const SITS = {
  1:{emoji:"🟢",label:"Normal"},2:{emoji:"🟡",label:"Riesgo bajo"},
  3:{emoji:"🟠",label:"Riesgo medio"},4:{emoji:"🔴",label:"Riesgo alto"},
  5:{emoji:"⛔",label:"Irrecuperable"},6:{emoji:"🔵",label:"Irrecup. Tecnica"},
};

function lanzarBrowser() {
  return puppeteer.launch({
    headless:"new",
    args:["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage",
          "--disable-gpu","--no-zygote","--single-process"],
  });
}

async function consultarBCRA(cuit) {
  const browser = await lanzarBrowser();
  try {
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36");
    await page.setViewport({width:1280, height:900});

    // Una sola URL que tiene TODO: deudas + cheques rechazados
    const url = `https://www2.bcra.gob.ar/BCRAyVos/Situacion_Crediticia.asp?cuit=${cuit}`;
    console.log("Consultando:", url);

    await page.goto(url, {waitUntil:"networkidle2", timeout:40000});

    // Extraer TODO el texto y tablas de la pagina
    const datos = await page.evaluate(() => {
      const resultado = {
        nombre: "",
        textoCompleto: document.body.innerText,
        tablas: [],
        periodos: [],
        cheques: [],
      };

      // Nombre
      const textoBody = document.body.innerText;
      const mNombre = textoBody.match(/Denominaci[oó]n[:\s]+([^\n\r]+)/i);
      if (mNombre) resultado.nombre = mNombre[1].trim();

      // Extraer todas las tablas con sus datos
      const tablas = document.querySelectorAll("table");
      tablas.forEach((tabla, ti) => {
        const filas = [];
        tabla.querySelectorAll("tr").forEach(tr => {
          const celdas = [...tr.querySelectorAll("td,th")].map(c => c.innerText.trim());
          if (celdas.some(c => c)) filas.push(celdas);
        });
        if (filas.length > 0) resultado.tablas.push({indice: ti, filas});
      });

      return resultado;
    });

    console.log("Texto completo (primeros 2000):", datos.textoCompleto.slice(0,2000));
    console.log("Tablas encontradas:", datos.tablas.length);
    datos.tablas.forEach((t,i) => console.log(`Tabla ${i}:`, JSON.stringify(t.filas.slice(0,5))));

    // Parsear periodos y cheques del texto
    return parsearDatos(datos, cuit);

  } finally {
    await browser.close().catch(()=>{});
  }
}

function parsearDatos(datos, cuit) {
  const resultado = {nombre: datos.nombre, periodos: [], cheques: []};

  // Parsear tablas para encontrar situacion crediticia y cheques
  for (const tabla of datos.tablas) {
    for (const fila of tabla.filas) {
      // Detectar fila de situacion crediticia (tiene periodo YYYYMM, entidad, situacion 1-6)
      if (fila.length >= 3 && /^\d{6}$/.test(fila[0]) && /^[1-6]$/.test(fila[2])) {
        let p = resultado.periodos.find(x => x.periodo === fila[0]);
        if (!p) { p = {periodo: fila[0], entidades: []}; resultado.periodos.push(p); }
        p.entidades.push({
          entidad: fila[1]||"",
          situacion: parseInt(fila[2]),
          monto: fila[3]||"",
        });
      }

      // Detectar fila de cheque rechazado
      // Columnas tipicas: Nro cheque | Fecha | Monto | Causal | Fecha pago / No Regularizado
      if (fila.length >= 4) {
        const posibleNro  = fila[0];
        const posibleFecha= fila[1];
        const posibleMonto= fila[2];
        const posibleCausal=fila[3];

        // Cheque si: primera col es numero, segunda es fecha dd/mm/aaaa
        if (/^\d+$/.test(posibleNro.replace(/\D/g,"")) &&
            /\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/.test(posibleFecha) &&
            posibleCausal.length > 2) {

          const fechaPago = fila[4]||"";
          const pagado = fechaPago.trim() !== "" &&
                         !fechaPago.toLowerCase().includes("no regul") &&
                         !fechaPago.toLowerCase().includes("impaga");

          resultado.cheques.push({
            nro:       posibleNro,
            fecha:     posibleFecha,
            monto:     posibleMonto,
            causal:    posibleCausal,
            fechaPago: fechaPago,
            pagado,
          });
        }
      }
    }
  }

  return resultado;
}

function armarMensaje(cuit, datos) {
  const fmt    = formatCuit(cuit);
  const nombre = datos?.nombre || "";
  const periodos= datos?.periodos || [];
  const cheques = datos?.cheques || [];
  const L = [];

  const sinPagar = cheques.filter(c=>!c.pagado);
  const pagados  = cheques.filter(c=>c.pagado);
  const semaforo = sinPagar.length>0 ? "🔴" : (pagados.length>0 ? "🟡" : "🟢");

  L.push(semaforo+" CUIT: "+fmt);
  if (nombre) L.push("👤 "+nombre);
  L.push("");

  // Situacion crediticia
  if (periodos.length===0) {
    L.push("✅ Sin deudas en el sistema financiero.");
  } else {
    let max=0;
    periodos.forEach(p=>p.entidades.forEach(e=>{if(e.situacion>max)max=e.situacion;}));
    const sit=SITS[max]||{emoji:"❓",label:"S"+max};
    L.push("📊 Situacion: S"+max+" "+sit.emoji+" "+sit.label);
    periodos.forEach(p=>{
      L.push("   Periodo "+p.periodo+":");
      p.entidades.forEach(e=>{
        const s=SITS[e.situacion]||{emoji:"❓",label:"S"+e.situacion};
        L.push("   "+s.emoji+" S"+e.situacion+" "+s.label+" — "+e.entidad+(e.monto?" ("+e.monto+")":""));
      });
    });
  }

  L.push("");
  L.push("━━━━━━━━━━━━━━━━━━━━━");

  if (cheques.length===0) {
    L.push("🟢 SIN CHEQUES RECHAZADOS");
  } else {
    // Agrupar por causal
    const porCausal = {};
    cheques.forEach(ch=>{
      const k=ch.causal||"SIN FONDOS";
      if(!porCausal[k]) porCausal[k]=0;
      porCausal[k]++;
    });

    L.push("🔴 CHEQUES RECHAZADOS: "+cheques.length);
    L.push("━━━━━━━━━━━━━━━━━━━━━");
    Object.entries(porCausal).forEach(([c,n])=>L.push("  "+c+": "+n));
    L.push("━━━━━━━━━━━━━━━━━━━━━");
    L.push("  ❌ Sin pagar:  "+sinPagar.length);
    L.push("  ✅ Pagados:    "+pagados.length);

    if (sinPagar.length>0) {
      L.push("");
      L.push("❌ SIN PAGAR:");
      sinPagar.slice(0,20).forEach(ch=>{
        L.push("  N°"+ch.nro+"  "+ch.fecha+"  "+ch.monto);
        L.push("  "+ch.causal);
      });
      if (sinPagar.length>20) L.push("  ... y "+(sinPagar.length-20)+" mas");
    }
    if (pagados.length>0) {
      L.push("");
      L.push("✅ PAGADOS:");
      pagados.slice(0,20).forEach(ch=>{
        L.push("  N°"+ch.nro+"  "+ch.fecha+"  "+ch.monto);
        L.push("  Pagado: "+ch.fechaPago);
      });
      if (pagados.length>20) L.push("  ... y "+(pagados.length-20)+" mas");
    }
  }

  L.push("");
  L.push("📅 "+new Date().toLocaleString("es-AR"));
  return L.join("\n");
}

async function procesarCUITs(chatId, texto) {
  const cuits=[...new Set(texto.split(/[\s,;|]+/).map(parseCuit).filter(c=>c.length===11))];
  if (cuits.length===0) {
    if (/\d/.test(texto)) return bot.sendMessage(chatId,"⚠️ CUIT invalido. Ej: 20123456789");
    return;
  }
  if (cuits.length>5) return bot.sendMessage(chatId,"⚠️ Maximo 5 CUITs.");

  for (const cuit of cuits) {
    const espera = await bot.sendMessage(chatId,"🔍 Consultando "+formatCuit(cuit)+"...");
    try {
      const datos = await consultarBCRA(cuit);
      try { await bot.deleteMessage(chatId, espera.message_id); } catch {}
      await bot.sendMessage(chatId, armarMensaje(cuit, datos));
    } catch(e) {
      try { await bot.deleteMessage(chatId, espera.message_id); } catch {}
      console.error("Error:", e.message);
      await bot.sendMessage(chatId,"❌ Error consultando "+formatCuit(cuit)+". Intenta de nuevo.");
    }
    if (cuits.length>1) await new Promise(r=>setTimeout(r,2000));
  }
}

bot.onText(/\/start/,msg=>{
  if(!usuarioAutorizado(msg)) return rechazarAcceso(msg.chat.id);
  bot.sendMessage(msg.chat.id,
    "👋 Hola "+msg.from.first_name+"!\n\nConsulto el BCRA en tiempo real.\n\n"+
    "Manda un CUIT o varios (max 5) separados por coma:\n20123456789\n\n/ayuda"
  );
});
bot.onText(/\/ayuda/,msg=>{
  if(!usuarioAutorizado(msg)) return rechazarAcceso(msg.chat.id);
  bot.sendMessage(msg.chat.id,
    "🟢 Sin cheques rechazados\n🟡 Cheques pagados\n🔴 Tiene sin pagar\n\n"+
    "Datos directo del BCRA en tiempo real."
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

console.log("Bot BCRA v10 iniciando...");
