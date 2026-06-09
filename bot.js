const TelegramBot = require("node-telegram-bot-api");

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) {
  console.error("Falta la variable BOT_TOKEN");
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });

const SITS = {
  1: { emoji: "🟢", label: "Normal",            desc: "Cumplimiento normal" },
  2: { emoji: "🟡", label: "Riesgo bajo",        desc: "Atraso 31-90 dias" },
  3: { emoji: "🟠", label: "Riesgo medio",       desc: "Atraso 91-180 dias" },
  4: { emoji: "🔴", label: "Riesgo alto",        desc: "Atraso 181-365 dias" },
  5: { emoji: "⛔", label: "Irrecuperable",      desc: "Mas de 365 dias o quiebra" },
  6: { emoji: "🔵", label: "Irrecup. Tecnica",   desc: "Irrecuperable tecnica" },
};

function parseCuit(v) { return v.replace(/\D/g, ""); }

function formatCuit(c) {
  if (c.length !== 11) return c;
  return c.slice(0,2) + "-" + c.slice(2,10) + "-" + c.slice(10);
}

function formatMonto(m) {
  return "$" + Number(m).toLocaleString("es-AR");
}

async function fetchBCRA(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    clearTimeout(timer);
    console.error("fetchBCRA error:", url, e.message);
    return null;
  }
}

async function consultarCUIT(cuit) {
  const [deudores, cheques] = await Promise.all([
    fetchBCRA("https://api.bcra.gob.ar/centraldedeudores/v1.0/Deudas/" + cuit),
    fetchBCRA("https://api.bcra.gob.ar/cheques/v1.0/deudores/" + cuit),
  ]);
  return { deudores, cheques };
}

function armarRespuesta(cuit, deudores, cheques) {
  const fmt = formatCuit(cuit);
  const nombre = deudores?.results?.denominacion || "";
  const periodos = deudores?.results?.periodos || [];
  const chequesArr = cheques?.results || [];

  let lines = [];

  lines.push("🏦 CUIT: " + fmt);
  if (nombre) lines.push("👤 " + nombre);
  lines.push("");

  if (periodos.length === 0) {
    lines.push("✅ Sin deudas en el sistema financiero.");
  } else {
    let maxSit = 0;
    periodos.forEach(p =>
      (p.entidades || []).forEach(e => {
        const s = parseInt(e.situacion);
        if (s > maxSit) maxSit = s;
      })
    );
    const sitMax = SITS[maxSit] || { emoji: "❓", label: "S" + maxSit };
    lines.push("📊 Situacion maxima: S" + maxSit + " " + sitMax.emoji + " " + sitMax.label);
    lines.push("");

    periodos.forEach(p => {
      lines.push("📅 Periodo: " + p.periodo);
      (p.entidades || []).forEach(e => {
        const s = parseInt(e.situacion);
        const sit = SITS[s] || { emoji: "❓", label: "S" + s };
        let linea = "  " + sit.emoji + " S" + s + " " + sit.label + " - " + (e.entidad || "Entidad");
        if (e.monto) linea += "  " + formatMonto(e.monto);
        lines.push(linea);
      });
      lines.push("");
    });
  }

  if (chequesArr.length > 0) {
    lines.push("🏦 Cheques rechazados: " + chequesArr.length);
    chequesArr.slice(0, 10).forEach(ch => {
      lines.push("");
      lines.push("  Cheque N " + (ch.nroCheque || ch.numeroCheque || "-"));
      if (ch.fechaRechazo || ch.fecha) lines.push("  Fecha: " + (ch.fechaRechazo || ch.fecha));
      if (ch.entidad) lines.push("  Entidad: " + ch.entidad);
      if (ch.monto) lines.push("  Monto: " + formatMonto(ch.monto));
      if (ch.motivoRechazo) lines.push("  Motivo: " + ch.motivoRechazo);
    });
    if (chequesArr.length > 10) {
      lines.push("  ... y " + (chequesArr.length - 10) + " mas");
    }
  } else {
    lines.push("✅ Sin cheques rechazados.");
  }

  return lines.join("\n");
}

async function procesarCUITs(chatId, texto) {
  const cuits = texto
    .split(/[\s,;|]+/)
    .map(parseCuit)
    .filter(c => c.length === 11);

  if (cuits.length === 0) {
    if (/\d/.test(texto)) {
      return bot.sendMessage(chatId, "⚠️ CUIT invalido. Debe tener 11 digitos.\nEjemplo: 20123456789");
    }
    return;
  }

  const unique = [...new Set(cuits)];

  if (unique.length > 10) {
    return bot.sendMessage(chatId, "⚠️ Maximo 10 CUITs por consulta.");
  }

  const espera = await bot.sendMessage(chatId,
    unique.length === 1
      ? "🔍 Consultando CUIT " + formatCuit(unique[0]) + "... un momento"
      : "🔍 Consultando " + unique.length + " CUITs... un momento"
  );

  const respuestas = await Promise.all(
    unique.map(async (cuit) => {
      try {
        const { deudores, cheques } = await consultarCUIT(cuit);
        return { cuit, deudores, cheques, error: null };
      } catch(e) {
        console.error("Error consultando", cuit, e.message);
        return { cuit, error: "No se pudo consultar. Intenta de nuevo." };
      }
    })
  );

  try { await bot.deleteMessage(chatId, espera.message_id); } catch {}

  for (const r of respuestas) {
    try {
      if (r.error) {
        await bot.sendMessage(chatId, "❌ CUIT " + formatCuit(r.cuit) + "\n" + r.error);
      } else {
        const msg = armarRespuesta(r.cuit, r.deudores, r.cheques);
        await bot.sendMessage(chatId, msg);
      }
    } catch(e) {
      console.error("Error enviando mensaje:", e.message);
      await bot.sendMessage(chatId, "❌ Error al mostrar resultado del CUIT " + formatCuit(r.cuit));
    }
    if (respuestas.length > 1) await new Promise(r => setTimeout(r, 400));
  }
}

bot.onText(/\/start/, (msg) => {
  const nombre = msg.from.first_name || "amigo";
  bot.sendMessage(msg.chat.id,
    "👋 Hola " + nombre + "!\n\n" +
    "Soy el bot de consulta del Central de Deudores del BCRA.\n\n" +
    "Como usarme:\n" +
    "Manda un CUIT para consultarlo\n" +
    "O varios separados por espacio o coma\n\n" +
    "Ejemplos:\n" +
    "20123456789\n" +
    "20-12345678-9\n" +
    "20123456789, 27987654321\n\n" +
    "/ayuda para mas info"
  );
});

bot.onText(/\/ayuda/, (msg) => {
  bot.sendMessage(msg.chat.id,
    "📖 Situaciones crediticias:\n\n" +
    "🟢 S1 - Normal (paga en termino)\n" +
    "🟡 S2 - Riesgo bajo (31-90 dias de atraso)\n" +
    "🟠 S3 - Riesgo medio (91-180 dias)\n" +
    "🔴 S4 - Riesgo alto (181-365 dias)\n" +
    "⛔ S5 - Irrecuperable (+365 dias o quiebra)\n" +
    "🔵 S6 - Irrecuperable tecnica\n\n" +
    "Comandos:\n" +
    "/start - Inicio\n" +
    "/consultar [cuit] - Consultar\n" +
    "/ayuda - Esta ayuda"
  );
});

bot.onText(/\/consultar (.+)/, async (msg, match) => {
  await procesarCUITs(msg.chat.id, match[1]);
});

bot.on("message", async (msg) => {
  if (!msg.text || msg.text.startsWith("/")) return;
  await procesarCUITs(msg.chat.id, msg.text);
});

bot.on("polling_error", (err) => console.error("Polling error:", err.message));

console.log("Bot BCRA iniciado y escuchando...");
