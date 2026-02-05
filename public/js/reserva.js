const PRICE_PER_PERSON = 1; // test

const form = document.getElementById("reserveForm");
const payBtn = document.getElementById("payBtn");
const errorBox = document.getElementById("errorBox");

const fullNameEl = document.getElementById("fullName");
const emailEl = document.getElementById("email");
const phoneEl = document.getElementById("phone");

const adultsEl = document.getElementById("adults");
const kidsEl = document.getElementById("kids");

const totalPeopleEl = document.getElementById("totalPeople");
const totalAmountEl = document.getElementById("totalAmount");

function showError(msg) {
  if (!errorBox) return alert(msg);
  errorBox.style.display = "block";
  errorBox.textContent = msg;
}
function clearError() {
  if (!errorBox) return;
  errorBox.style.display = "none";
  errorBox.textContent = "";
}

function formatARS(n) {
  return Math.round(n).toLocaleString("es-AR");
}

function recalc() {
  if (!adultsEl || !kidsEl || !totalPeopleEl || !totalAmountEl) return;

  const a = Math.max(0, Number(adultsEl.value || 0));
  const k = Math.max(0, Number(kidsEl.value || 0));
  const people = a + k;
  const amount = people * PRICE_PER_PERSON;

  totalPeopleEl.textContent = String(people);
  totalAmountEl.textContent = `$ ${formatARS(amount)}`;
}

if (adultsEl) adultsEl.addEventListener("input", recalc);
if (kidsEl) kidsEl.addEventListener("input", recalc);
recalc();

if (!form) {
  console.error("No se encontró el form #reserveForm");
} else {
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearError();

    // chequeo de elementos clave
    if (!fullNameEl || !emailEl || !phoneEl || !adultsEl || !kidsEl) {
      return showError("Faltan campos en el formulario (IDs). Revisá fullName/email/phone/adults/kids.");
    }

    const fullName = fullNameEl.value.trim();
    const email = emailEl.value.trim();
    const phone = phoneEl.value.trim();

    const adults = Number(adultsEl.value || 0);
    const kids = Number(kidsEl.value || 0);
    const total = adults + kids;

    if (fullName.length < 3) return showError("Ingresá tu nombre y apellido.");
    if (!email.includes("@")) return showError("Ingresá un email válido.");
    if (phone.length < 6) return showError("Ingresá un teléfono válido.");
    if (!Number.isFinite(adults) || !Number.isFinite(kids) || adults < 0 || kids < 0) {
      return showError("Revisá los valores ingresados.");
    }
    if (total <= 0) return showError("Ingresá al menos 1 comensal.");

    if (payBtn) {
      payBtn.disabled = true;
      payBtn.textContent = "Iniciando pago...";
    }

    try {
      const resp = await fetch("/api/create-preference", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adults, kids, fullName, email, phone })
      });

      const data = await resp.json();

      if (!resp.ok) {
        throw new Error(data?.message || data?.error || "No se pudo iniciar el pago.");
      }

      if (!data.init_point) throw new Error("Mercado Pago no devolvió init_point.");

      window.location.href = data.init_point;
    } catch (err) {
      showError(err.message || "Ocurrió un error.");
      if (payBtn) {
        payBtn.disabled = false;
        payBtn.textContent = "Pagar y confirmar reserva";
      }
    }
  });
}
