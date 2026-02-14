import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import nodemailer from "nodemailer";


dotenv.config();

// __dirname / __filename (ESM)
const SOLD_OUT = String(process.env.SOLD_OUT || "false").toLowerCase() === "true";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// ---------- Config ----------
const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const PRICE_PER_PERSON = Number(process.env.PRICE_PER_PERSON || 30000);
const MAX_RESERVAS = Number(process.env.MAX_RESERVAS || 30);

// Persistencia (Railway Volume recomendado: DATA_DIR=/data)
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "reservas.json");

function ensureDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ reservas: [] }, null, 2), "utf-8");
  }
}
function loadDb() {
  ensureDb();
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
}
function saveDb(db) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), "utf-8");
}
function confirmedCount(db) {
  return db.reservas.filter((r) => r.status === "approved").length;
}

// ---------- Static ----------
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  if (SOLD_OUT) return res.sendFile(path.join(__dirname, "public", "completo.html"));
  return res.sendFile(path.join(__dirname, "public", "index1.html"));
});


// ---------- Ping ----------
app.get("/ping", (req, res) => res.send("pong"));

// ---------- Availability ----------
app.get("/api/availability", (req, res) => {
  const db = loadDb();
  const remaining = Math.max(0, MAX_RESERVAS - confirmedCount(db));
  res.json({ remaining, max: MAX_RESERVAS });
});


function mailer() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
}

async function sendEmails({
  customerEmail,
  restaurantEmail,
  subjectCustomer,
  htmlCustomer,
  subjectRestaurant,
  htmlRestaurant
}) {
  const tx = mailer();
  const fromName = process.env.MAIL_FROM_NAME || "Botánico";
  const fromEmail = process.env.MAIL_FROM_EMAIL || process.env.SMTP_USER;
  const from = `"${fromName}" <${fromEmail}>`;

  // Cliente
  await tx.sendMail({
    from,
    to: customerEmail,
    subject: subjectCustomer,
    html: htmlCustomer
  });

  // Restaurante
  await tx.sendMail({
    from,
    to: restaurantEmail,
    subject: subjectRestaurant,
    html: htmlRestaurant
  });
}


// ---------- Mercado Pago: create preference ----------
app.post("/api/create-preference", async (req, res) => {
  try {
    if (SOLD_OUT) {
  return res.status(409).json({
    error: "Reservas completas",
    message: "Esta edición de San Valentín ya se encuentra completa. Gracias por tu interés."
  });
}

    const { adults, kids, fullName, email, phone } = req.body;

    const a = Number(adults);
    const k = Number(kids);

    if (!fullName || String(fullName).trim().length < 3) {
      return res.status(400).json({ error: "Ingresá tu nombre y apellido." });
    }
    if (!email || !String(email).includes("@")) {
      return res.status(400).json({ error: "Ingresá un email válido." });
    }
    if (!phone || String(phone).trim().length < 6) {
      return res.status(400).json({ error: "Ingresá un teléfono válido." });
    }
    if (!Number.isFinite(a) || !Number.isFinite(k) || a < 0 || k < 0) {
      return res.status(400).json({ error: "Datos inválidos." });
    }

    const totalPeople = a + k;
    if (totalPeople <= 0) {
      return res.status(400).json({ error: "Ingresá al menos 1 comensal." });
    }

    const db = loadDb();
    const remaining = Math.max(0, MAX_RESERVAS - confirmedCount(db));
    if (remaining <= 0) {
      return res.status(409).json({
        error: "Reservas completas",
        message: "Esta edición de San Valentín ya se encuentra completa. Gracias por tu interés."
      });
    }

    const amount = totalPeople * PRICE_PER_PERSON;
    const externalRef = `BOTANICO-SV-${Date.now()}`;

    // Guardamos como pending
    db.reservas.push({
      external_reference: externalRef,
      created_at: new Date().toISOString(),
      status: "pending",
      fullName: String(fullName).trim(),
      email: String(email).trim(),
      phone: String(phone).trim(),
      adults: a,
      kids: k,
      total_people: totalPeople,
      amount
    });
    saveDb(db);

    const preference = {
      items: [
        {
          title: "Reserva San Valentín - Botánico (turno único 21:00)",
          quantity: 1,
          currency_id: "ARS",
          unit_price: amount
        }
      ],
      back_urls: {
        success: `${BASE_URL}/resultado.html`,
        pending: `${BASE_URL}/resultado.html`,
        failure: `${BASE_URL}/resultado.html`
      },
      auto_return: "approved",
      external_reference: externalRef,
      metadata: {
        external_reference: externalRef,
        fullName: String(fullName).trim(),
        email: String(email).trim(),
        phone: String(phone).trim(),
        adults: a,
        kids: k,
        total_people: totalPeople,
        price_per_person: PRICE_PER_PERSON,
        event: "san_valentin",
        shift: "21:00"
      }
    };

    const resp = await axios.post(
      "https://api.mercadopago.com/checkout/preferences",
      preference,
      {
        headers: {
          Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

    return res.json({
      preferenceId: resp.data.id,
      init_point: resp.data.init_point
    });
  } catch (err) {
    const mpError = err?.response?.data;
    console.error("MP error:", mpError || err.message);
    return res.status(500).json({
      error: "No se pudo iniciar el pago.",
      detail: mpError || err.message
    });
  }
});

// ---------- Confirm payment + send emails ----------
app.get("/api/confirm", async (req, res) => {
  try {
    const paymentId = req.query.payment_id;
    if (!paymentId) return res.status(400).json({ error: "payment_id faltante" });

    console.log("CONFIRM HIT payment_id:", paymentId);

    const payResp = await axios.get(
      `https://api.mercadopago.com/v1/payments/${paymentId}`,
      { headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}` } }
    );

    const payment = payResp.data;
    const status = (payment.status || "").toLowerCase();
    const externalRef = payment.external_reference || payment.metadata?.external_reference;

    if (!externalRef) {
      return res.status(400).json({ error: "No se encontró external_reference en el pago." });
    }

    const db = loadDb();
    const r = db.reservas.find((x) => x.external_reference === externalRef);
    if (!r) return res.status(404).json({ error: "Reserva no encontrada." });

    // Ya aprobada: no duplicamos
    if (r.status === "approved") {
      return res.json({ ok: true, status: "approved", message: "Reserva ya confirmada." });
    }

    r.mp_payment_id = String(paymentId);
    r.mp_status = status;

    if (status === "approved") {
      // Control final cupo
      const remaining = Math.max(0, MAX_RESERVAS - confirmedCount(db));
      if (remaining <= 0) {
        r.status = "rejected_full";
        saveDb(db);
        return res.status(409).json({
          ok: false,
          status: "full",
          message: "Reservas completas. Si el pago fue realizado, contactar al restaurante."
        });
      }

      r.status = "approved";
      r.approved_at = new Date().toISOString();
      saveDb(db);

      const restaurantEmail = String(process.env.RESTAURANT_EMAIL || "").trim();
      if (!restaurantEmail) {
        return res.status(500).json({ ok: false, error: "Falta RESTAURANT_EMAIL en Railway" });
      }

      const htmlCustomer = `
        <div style="font-family:Arial,sans-serif; line-height:1.7; color:#111;">
          <h2 style="margin:0 0 10px;">Reserva confirmada</h2>
          <p style="margin:0 0 16px;">Botánico · San Valentín</p>
          <p style="margin:0 0 6px;">Nombre: ${r.fullName}</p>
          <p style="margin:0 0 6px;">Comensales: ${r.total_people} (Adultos ${r.adults} · Niños ${r.kids})</p>
          <p style="margin:0 0 6px;">Turno: 21:00</p>
          <p style="margin:0;">Tolerancia máxima: 15 minutos</p>
        </div>
      `;

      const htmlRestaurant = `
        <div style="font-family:Arial,sans-serif; line-height:1.7; color:#111;">
          <h2 style="margin:0 0 10px;">Reserva confirmada</h2>
          <p style="margin:0 0 6px;">Nombre: ${r.fullName}</p>
          <p style="margin:0 0 6px;">Email: ${r.email}</p>
          <p style="margin:0 0 6px;">Tel: ${r.phone}</p>
          <p style="margin:0 0 6px;">Comensales: ${r.total_people} (Adultos ${r.adults} · Niños ${r.kids})</p>
          <p style="margin:0 0 6px;">Monto: $${Number(r.amount).toLocaleString("es-AR")} ARS</p>
          <p style="margin:0 0 6px;">Pago MP: ${paymentId}</p>
        </div>
      `;

      await sendEmails({
        customerEmail: r.email,          // <- email del cliente (del formulario)
        restaurantEmail,                // <- email del restaurante (variable)
        subjectCustomer: "Botánico · Reserva confirmada (San Valentín)",
        htmlCustomer,
        subjectRestaurant: "Botánico · Reserva confirmada",
        htmlRestaurant
      });

      return res.json({ ok: true, status: "approved" });
    }

    saveDb(db);
    return res.json({ ok: true, status });
  } catch (err) {
    const mpError = err?.response?.data;
    console.error("Confirm error:", mpError || err.message);
    return res.status(500).json({
      error: "No se pudo confirmar el pago.",
      detail: mpError || err.message
    });
  }
});

app.get("/api/whatsapp-link", (req, res) => {
  const phone = String(process.env.RESTAURANT_WA || "").trim();
  if (!phone) return res.status(500).json({ ok: false, error: "Falta RESTAURANT_WA en Railway" });

  const fullName = String(req.query.fullName || "").trim();
  const total = String(req.query.total || "").trim();
  const adults = String(req.query.adults || "").trim();
  const kids = String(req.query.kids || "").trim();
  const external = String(req.query.external_reference || "").trim();

  const lines = [
    "Botánico — Reserva confirmada ✅",
    "",
    fullName ? `Nombre: ${fullName}` : null,
    total ? `Comensales: ${total} (Adultos ${adults || "0"} · Niños ${kids || "0"})` : null,
    "Turno único: 21:00",
    "Tolerancia máxima: 15 minutos",
    external ? `Código: ${external}` : null
  ].filter(Boolean);

  const text = encodeURIComponent(lines.join("\n"));
  const url = `https://wa.me/${phone}?text=${text}`;

  res.json({ ok: true, url });
});
app.get("/api/reserva", (req, res) => {
  try {
    const externalRef = String(req.query.external_reference || "").trim();
    if (!externalRef) return res.status(400).json({ ok: false, error: "Falta external_reference" });

    const db = loadDb();
    const r = db.reservas.find(x => x.external_reference === externalRef);

    if (!r) return res.status(404).json({ ok: false, error: "Reserva no encontrada" });

    return res.json({
      ok: true,
      reserva: {
        fullName: r.fullName,
        adults: r.adults,
        kids: r.kids,
        total_people: r.total_people,
        amount: r.amount,
        status: r.status
      }
    });
  } catch (err) {
    console.error("API RESERVA ERROR:", err.message);
    return res.status(500).json({ ok: false, error: "Error leyendo reserva" });
  }
});

// ---------- Start ----------
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Servidor OK: http://localhost:${port}`));
