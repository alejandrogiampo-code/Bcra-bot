const TelegramBot = require("node-telegram-bot-api");
const puppeteer   = require("puppeteer");
const cron        = require("node-cron");

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
function rechazarAcceso(chatId) { bot.sendMessage(chatId, "🔒 No tenes acceso."); }

function parseCuit(v) { return v.replace(/\D/g, ""); }
function formatCuit(c) {
  return c.length===11 ? c.slice(0,2)+"-"+c.slice(2,10)+"-"+c.slice(10) : c;
}
function formatMonto(m) {
  return "$" + Number(m).toLocaleString("es-AR", {minimumFractionDigits:2});
}

const SITS = {
  1:{emoji:"🟢",label:"Normal"},2:{emoji:"🟡",label:"Riesgo bajo"},
  3:{emoji:"🟠",label:"Riesgo medio"},4:{emoji:"🔴",label:"Riesgo alto"},
  5:{emoji:"⛔",label:"Irrecuperable"},6:{emoji:"🔵",label:"Irrecup. Tecnica"},
};

// ── Scraping BCRA ─────────────────────────────────────────────────────────────
async function scrapearBCRA(cuit) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-first-run",
        "--no-zygote",
        "--single-process",
      ],
    });

    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36");
    await page.setViewport({ width: 1280, height: 800 });

    // ── Consultar deudas (situacion crediticia) ──
    let deudaData = null;
    try {
      await page.goto(`https://www.bcra.gob.ar/BCRAyVos/Situacion_Crediticia.asp?cuit=${cuit}`, {
        waitUntil: "networkidle2", timeout: 30000
      });
      deudaData = await page.evaluate(() => {
        const resultado = { nombre: "", periodos: [] };
        // Nombre/razon social
        const tds = document.querySelectorAll("td");
        for (const td of tds) {
          if (td.textContent.includes("Denominación") || td.textContent.includes("Denominacion")) {
            resultado.nombre = td.nextElementSibling?.textContent?.trim() || "";
            break;
          }
        }
        // Tabla de deudas
        const tablas = document.querySelectorAll("table");
        for (const tabla of tablas) {
          const filas = tabla.querySelectorAll("tr");
          let periodoActual = "";
          for (const fila of filas) {
            const celdas = [...fila.querySelectorAll("td,th")].map(c => c.textContent.trim());
            if (celdas.length === 0) continue;
            // Detectar periodo (formato YYYYMM)
            if (celdas[0] && /^\d{6}$/.test(celdas[0])) {
              periodoActual = celdas[0];
            }
            // Fila con entidad y situacion
            if (periodoActual && celdas.length >= 3 && celdas[2] && /^\d$/.test(celdas[2])) {
              let periodo = resultado.periodos.find(p => p.periodo === periodoActual);
              if (!periodo) { periodo = {periodo: periodoActual, entidades:[]}; resultado.periodos.push(periodo); }
              periodo.entidades.push({
                entidad: celdas[1] || "",
                situacion: parseInt(celdas[2]),
                monto: celdas[3] ? celdas[3].replace(/\./g,"").replace(",",".") : "0",
              });
            }
          }
        }
        return resultado;
      });
    } catch(e) { console.error("Error scraping deudas:", e.message); }

    // ── Consultar cheques rechazados ──
    let chequesData = null;
    try {
      await page.goto(`https://www.bcra.gob.ar/cheques/actualiza.asp`, {
        waitUntil: "networkidle2", timeout: 30000
      });
      // Llenar el formulario con el CUIT
      await page.waitForSelector("input[name='cuit'], input[type='text']", {timeout:10000});
      const inputs = await page.$$("input[type='text'], input[name='cuit']");
      if (inputs.length > 0) {
        await inputs[0].click({clickCount:3});
        await inputs[0].type(cuit);
        // Buscar boton submit
        const btns = await page.$$("input[type='submit'], button[type='submit'], button");
        if (btns.length > 0) await btns[0].click();
        await page.waitForNavigation({waitUntil:"networkidle2", timeout:15000}).catch(()=>{});
      }

      chequesData = await page.evaluate(() => {
        const resultado = { cheques: [] };
        const tablas = document.querySelectorAll("table");
        for (const tabla of tablas) {
          const filas = tabla.querySelectorAll("tr");
          for (const fila of filas) {
            const celdas = [...fila.querySelectorAll("td")].map(c => c.textContent.trim());
            // Fila de cheque: nro, fecha, monto, causal, fechaPago
            if (celdas.length >= 4 && celdas[0] && /^\d+$/.test(celdas[0].replace(/\D/g,""))) {
              resultado.cheques.push({
                nro:      celdas[0] || "",
                fecha:    celdas[1] || "",
                monto:    celdas[2] || "",
                causal:   celdas[3] || "",
                fechaPago:celdas[4] || "",
                pagado:   celdas[4] && celdas[4].trim() !== "" && celdas[4].trim() !== "No Regularizado",
              });
            }
          }
        }
        return resultado;
      });
    } catch(e) { console.error("Error scraping cheques:", e.message); }

    return { deudaData, chequesData };

  } finally {
    if (browser) await browser.close().catch(()=>{});
  }
}

// ── Armar mensaje ─────────────────────────────────────────────────────────────
function armarMensaje(cuit, deudaData, chequesData) {
  const fmt    = formatCuit(cuit);
  const nombre = deudaData?.nombre || "";
  const periodos= deudaData?.periodos || [];
  const cheques = chequesData?.cheques || [];
  const L = [];

  const sinPagar = cheques.filter(c => !c.pagado);
  const pagados  = cheques.filter(c => c.pagado);
  const semaforo = sinPagar.length > 0 ? "🔴" : (pagados.length > 0 ? "🟡" : "🟢");

  L.push(semaforo + " CUIT: " + fmt);
  if (nombre) L.push("👤 " + nombre);
  L.push("");

  // Situacion crediticia
  if (periodos.length === 0) {
    L.push("✅ Sin deudas en el sistema financiero.");
  } else {
    let max = 0;
    periodos.forEach(p => p.entidades.forEach(e => { if(e.situacion > max) max = e.situacion; }));
    const sit = SITS[max] || {emoji:"❓", label:"S"+max};
    L.push("📊 Situacion: S"+max+" "+sit.emoji+" "+sit.label);
    periodos.forEach(p => {
      L.push("   Periodo "+p.periodo+":");
      p.entidades.forEach(e => {
        const s = SITS[e.situacion] || {emoji:"❓", label:"S"+e.situacion};
        L.push("   "+s.emoji+" S"+e.situacion+" "+s.label+" — "+e.entidad+
          (e.monto && e.monto!=="0" ? " ($"+Number(e.monto).toLocaleString("es-AR")+")" : ""));
      });
    });
  }

  L.push("");
  L.push("━━━━━━━━━━━━━━━━━━━━━");

  if (cheques.length === 0) {
    L.push("🟢 SIN CHEQUES RECHAZADOS");
  } else {
    // Agrupar por causal
    const porCausal = {};
    cheques.forEach(ch => {
      const k = ch.causal || "SIN FONDOS";
      if (!porCausal[k]) porCausal[k] = [];
      porCausal[k].push(ch);
    });

    L.push("🔴 CHEQUES RECHAZADOS: " + cheques.length);
    L.push("━━━━━━━━━━━━━━━━━━━━━");
    Object.entries(porCausal).forEach(([causal, arr]) => {
      L.push("  "+causal+": "+arr.length);
    });
    L.push("━━━━━━━━━━━━━━━━━━━━━");
    L.push("  ❌ Sin pagar:  " + sinPagar.length);
    L.push("  ✅ Pagados:    " + pagados.length);

    if (sinPagar.length > 0) {
      L.push("");
      L.push("❌ SIN PAGAR:");
      sinPagar.slice(0, 20).forEach(ch => {
        L.push("  Nro: "+ch.nro+"  Fecha: "+ch.fecha);
        L.push("  Monto: "+ch.monto+"  "+ch.causal);
      });
      if (sinPagar.length > 20) L.push("  ... y "+(sinPagar.length-20)+" mas");
    }

    if (pagados.length > 0) {
      L.push("");
      L.push("✅ PAGADOS:");
      pagados.slice(0, 20).forEach(ch => {
        L.push("  Nro: "+ch.nro+"  Fecha: "+ch.fecha);
        L.push("  Monto: "+ch.monto+"  Pagado: "+ch.fechaPago);
      });
      if (pagados.length > 20) L.push("  ... y "+(pagados.length-20)+" mas");
    }
  }

  L.push("");
  L.push("📅 "+new Date().toLocaleString("es-AR"));
  return L.join("\n");
}

// ── Procesar CUITs ────────────────────────────────────────────────────────────
async function procesarCUITs(chatId, texto) {
  const cuits = [...new Set(texto.split(/[\s,;|]+/).map(parseCuit).filter(c => c.length===11))];
  if (cuits.length === 0) {
    if (/\d/.test(texto)) return bot.sendMessage(chatId, "⚠️ CUIT invalido. Ej: 20123456789");
    return;
  }
  if (cuits.length > 5) return bot.sendMessage(chatId, "⚠️ Maximo 5 CUITs por consulta.");

  for (const cuit of cuits) {
    const espera = await bot.sendMessage(chatId, "🔍 Consultando "+formatCuit(cuit)+"...");
    try {
      const { deudaData, chequesData } = await scrapearBCRA(cuit);
      try { await bot.deleteMessage(chatId, espera.message_id); } catch {}
      await bot.sendMessage(chatId, armarMensaje(cuit, deudaData, chequesData));
    } catch(e) {
      try { await bot.deleteMessage(chatId, espera.message_id); } catch {}
      console.error("Error scraping", cuit, e.message);
      await bot.sendMessage(chatId, "❌ Error consultando "+formatCuit(cuit)+". Intenta de nuevo.");
    }
    if (cuits.length > 1) await new Promise(r => setTimeout(r, 1000));
  }
}

// ── Comandos ──────────────────────────────────────────────────────────────────
bot.onText(/\/start/, msg => {
  if (!usuarioAutorizado(msg)) return rechazarAcceso(msg.chat.id);
  bot.sendMessage(msg.chat.id,
    "👋 Hola "+msg.from.first_name+"!\n\n"+
    "Consulto el BCRA directamente — Central de Deudores y cheques rechazados.\n\n"+
    "Manda un CUIT:\n20123456789\n\n"+
    "O varios separados por coma (max 5):\n20123456789, 27987654321\n\n"+
    "/ayuda - Ayuda"
  );
});

bot.onText(/\/ayuda/, msg => {
  if (!usuarioAutorizado(msg)) return rechazarAcceso(msg.chat.id);
  bot.sendMessage(msg.chat.id,
    "📖 Situaciones:\n🟢S1 Normal\n🟡S2 Riesgo bajo\n🟠S3 Riesgo medio\n"+
    "🔴S4 Riesgo alto\n⛔S5 Irrecuperable\n🔵S6 Irrecup tecnica\n\n"+
    "🟢 = Sin cheques rechazados\n"+
    "🟡 = Cheques rechazados pero todos pagados\n"+
    "🔴 = Tiene cheques sin pagar\n\n"+
    "Los datos vienen directo del sitio del BCRA en tiempo real."
  );
});

bot.onText(/\/consultar (.+)/, async (msg, match) => {
  if (!usuarioAutorizado(msg)) return rechazarAcceso(msg.chat.id);
  await procesarCUITs(msg.chat.id, match[1]);
});

bot.on("message", async msg => {
  if (!msg.text || msg.text.startsWith("/")) return;
  if (!usuarioAutorizado(msg)) return rechazarAcceso(msg.chat.id);
  await procesarCUITs(msg.chat.id, msg.text);
});

bot.on("polling_error", err => console.error("Polling:", err.message));

console.log("Bot BCRA v8 (Puppeteer) iniciando...");
