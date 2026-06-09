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
    headless: "new",
    args: ["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage",
           "--disable-gpu","--no-zygote","--single-process"],
  });
}

// ── Scraping deudas ───────────────────────────────────────────────────────────
async function scrapearDeudas(page, cuit) {
  await page.goto(
    `https://www.bcra.gob.ar/BCRAyVos/Situacion_Crediticia.asp?cuit=${cuit}`,
    {waitUntil:"networkidle2", timeout:30000}
  );
  return await page.evaluate(() => {
    const res = {nombre:"", periodos:[]};
    const texto = document.body.innerText;

    // Nombre: buscar linea que siga a "Denominacion" o similar
    const mNombre = texto.match(/Denominaci[oó]n[:\s]+([^\n]+)/i);
    if (mNombre) res.nombre = mNombre[1].trim();

    // Parsear tabla de situaciones
    const filas = [...document.querySelectorAll("table tr")];
    let periodoActual = null;
    for (const fila of filas) {
      const celdas = [...fila.querySelectorAll("td,th")].map(c=>c.innerText.trim());
      if (!celdas.length) continue;
      if (/^\d{6}$/.test(celdas[0])) {
        periodoActual = celdas[0];
      }
      if (periodoActual && celdas.length>=3 && /^[1-6]$/.test(celdas[2])) {
        let p = res.periodos.find(x=>x.periodo===periodoActual);
        if (!p) { p={periodo:periodoActual,entidades:[]}; res.periodos.push(p); }
        p.entidades.push({
          entidad: celdas[1]||"",
          situacion: parseInt(celdas[2]),
          monto: (celdas[3]||"0").replace(/\./g,"").replace(",",".")
        });
      }
    }
    return res;
  });
}

// ── Scraping cheques ──────────────────────────────────────────────────────────
async function scrapearCheques(page, cuit) {
  // Primero obtener el HTML del formulario para saber el nombre del campo
  await page.goto("https://www.bcra.gob.ar/cheques/actualiza.asp",
    {waitUntil:"networkidle2", timeout:30000}
  );

  // Guardar HTML para debug
  const htmlForm = await page.evaluate(() => document.body.innerHTML.slice(0,3000));
  console.log("HTML formulario cheques:", htmlForm.slice(0,1000));

  // Buscar el input de CUIT por cualquier selector posible
  const inputSelector = await page.evaluate(() => {
    const inputs = [...document.querySelectorAll("input")];
    for (const inp of inputs) {
      if (inp.type==="text" || inp.type==="number" || inp.name?.toLowerCase().includes("cuit") || inp.id?.toLowerCase().includes("cuit")) {
        return inp.name ? `input[name="${inp.name}"]` : (inp.id ? `#${inp.id}` : "input[type='text']");
      }
    }
    return "input[type='text']";
  });

  console.log("Input selector:", inputSelector);

  try {
    await page.waitForSelector(inputSelector, {timeout:8000});
    await page.click(inputSelector, {clickCount:3});
    await page.type(inputSelector, cuit, {delay:50});

    // Submit
    const submitted = await page.evaluate(() => {
      const btn = document.querySelector("input[type='submit'],button[type='submit'],button");
      if (btn) { btn.click(); return true; }
      const form = document.querySelector("form");
      if (form) { form.submit(); return true; }
      return false;
    });

    if (submitted) {
      await page.waitForNavigation({waitUntil:"networkidle2", timeout:15000}).catch(()=>{});
    }
  } catch(e) {
    console.error("Error llenando formulario:", e.message);
    // Intentar URL directa
    await page.goto(
      `https://www.bcra.gob.ar/cheques/actualiza.asp?cuit=${cuit}`,
      {waitUntil:"networkidle2", timeout:20000}
    ).catch(()=>{});
  }

  // Leer resultado
  const html = await page.evaluate(() => document.body.innerHTML);
  console.log("HTML resultado cheques (primeros 2000):", html.slice(0,2000));

  return await page.evaluate(() => {
    const res = {cheques:[], htmlDebug: document.body.innerText.slice(0,500)};
    const filas = [...document.querySelectorAll("table tr")];
    for (const fila of filas) {
      const celdas = [...fila.querySelectorAll("td")].map(c=>c.innerText.trim());
      if (celdas.length >= 4) {
        // Detectar filas de cheques: primera celda es numero o fecha
        const esCheque = /^\d+$/.test(celdas[0]) ||
                         /^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}$/.test(celdas[1]);
        if (esCheque) {
          const pagado = celdas.length>=5 &&
                         celdas[4].trim()!=="" &&
                         celdas[4].trim()!=="No Regularizado" &&
                         celdas[4].trim()!=="NO REGULARIZADO";
          res.cheques.push({
            nro:       celdas[0]||"",
            fecha:     celdas[1]||"",
            monto:     celdas[2]||"",
            causal:    celdas[3]||"",
            fechaPago: celdas[4]||"",
            pagado,
          });
        }
      }
    }
    return res;
  });
}

// ── Armar mensaje ─────────────────────────────────────────────────────────────
function armarMensaje(cuit, deudas, cheques) {
  const fmt    = formatCuit(cuit);
  const nombre = deudas?.nombre || "";
  const periodos= deudas?.periodos || [];
  const lista  = cheques?.cheques || [];
  const L = [];

  const sinPagar = lista.filter(c=>!c.pagado);
  const pagados  = lista.filter(c=>c.pagado);
  const semaforo = sinPagar.length>0 ? "🔴" : (pagados.length>0 ? "🟡" : "🟢");

  L.push(semaforo+" CUIT: "+fmt);
  if (nombre) L.push("👤 "+nombre);
  L.push("");

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
        L.push("   "+s.emoji+" S"+e.situacion+" "+s.label+" — "+e.entidad);
      });
    });
  }

  L.push("");
  L.push("━━━━━━━━━━━━━━━━━━━━━");

  if (lista.length===0) {
    L.push("🟢 SIN CHEQUES RECHAZADOS");
    // Si hay debug text mostrarlo brevemente
    if (cheques?.htmlDebug) {
      const txt = cheques.htmlDebug.replace(/\s+/g," ").trim().slice(0,200);
      if (txt) L.push("   ("+txt+")");
    }
  } else {
    const porCausal = {};
    lista.forEach(ch=>{
      const k=ch.causal||"SIN FONDOS";
      if(!porCausal[k]) porCausal[k]=[];
      porCausal[k].push(ch);
    });

    L.push("🔴 CHEQUES RECHAZADOS: "+lista.length);
    L.push("━━━━━━━━━━━━━━━━━━━━━");
    Object.entries(porCausal).forEach(([causal,arr])=>L.push("  "+causal+": "+arr.length));
    L.push("━━━━━━━━━━━━━━━━━━━━━");
    L.push("  ❌ Sin pagar:  "+sinPagar.length);
    L.push("  ✅ Pagados:    "+pagados.length);

    if (sinPagar.length>0) {
      L.push("");
      L.push("❌ SIN PAGAR:");
      sinPagar.slice(0,20).forEach(ch=>{
        L.push("  Nro: "+ch.nro+"  Fecha: "+ch.fecha);
        L.push("  Monto: "+ch.monto+"  "+ch.causal);
      });
      if (sinPagar.length>20) L.push("  ... y "+(sinPagar.length-20)+" mas");
    }
    if (pagados.length>0) {
      L.push("");
      L.push("✅ PAGADOS:");
      pagados.slice(0,20).forEach(ch=>{
        L.push("  Nro: "+ch.nro+"  Fecha: "+ch.fecha);
        L.push("  Monto: "+ch.monto+"  Pagado: "+ch.fechaPago);
      });
      if (pagados.length>20) L.push("  ... y "+(pagados.length-20)+" mas");
    }
  }

  L.push("");
  L.push("📅 "+new Date().toLocaleString("es-AR"));
  return L.join("\n");
}

// ── Procesar ──────────────────────────────────────────────────────────────────
async function procesarCUITs(chatId, texto) {
  const cuits=[...new Set(texto.split(/[\s,;|]+/).map(parseCuit).filter(c=>c.length===11))];
  if (cuits.length===0) {
    if (/\d/.test(texto)) return bot.sendMessage(chatId,"⚠️ CUIT invalido. Ej: 20123456789");
    return;
  }
  if (cuits.length>5) return bot.sendMessage(chatId,"⚠️ Maximo 5 CUITs.");

  for (const cuit of cuits) {
    const espera = await bot.sendMessage(chatId,"🔍 Consultando "+formatCuit(cuit)+"...");
    let browser;
    try {
      browser = await lanzarBrowser();
      const page = await browser.newPage();
      await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36");

      const [deudas, cheques] = await Promise.allSettled([
        scrapearDeudas(page, cuit),
        scrapearCheques(page, cuit),
      ]);

      try { await bot.deleteMessage(chatId, espera.message_id); } catch {}
      await bot.sendMessage(chatId, armarMensaje(
        cuit,
        deudas.status==="fulfilled" ? deudas.value : null,
        cheques.status==="fulfilled" ? cheques.value : null,
      ));
    } catch(e) {
      try { await bot.deleteMessage(chatId, espera.message_id); } catch {}
      console.error("Error:", e.message);
      await bot.sendMessage(chatId,"❌ Error consultando "+formatCuit(cuit)+". Intenta de nuevo.");
    } finally {
      if (browser) await browser.close().catch(()=>{});
    }
    if (cuits.length>1) await new Promise(r=>setTimeout(r,2000));
  }
}

bot.onText(/\/start/,msg=>{
  if(!usuarioAutorizado(msg)) return rechazarAcceso(msg.chat.id);
  bot.sendMessage(msg.chat.id,
    "👋 Hola "+msg.from.first_name+"!\n\nConsulto el BCRA en tiempo real.\n\n"+
    "Manda un CUIT o varios (max 5) separados por coma.\n\n/ayuda - Ayuda"
  );
});
bot.onText(/\/ayuda/,msg=>{
  if(!usuarioAutorizado(msg)) return rechazarAcceso(msg.chat.id);
  bot.sendMessage(msg.chat.id,
    "🟢 Sin cheques rechazados\n🟡 Cheques pagados\n🔴 Cheques sin pagar\n\n"+
    "Datos directo del sitio BCRA en tiempo real."
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

console.log("Bot BCRA v9 (Puppeteer) iniciando...");
