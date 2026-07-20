import { supabase } from "./supabaseClient.js";
import { requireSession, showError } from "./auth.js";

// Finance is team-lead only — requireSession bounces interns back to buyers.html.
const session = await requireSession({ teamLeadOnly: true });
if (!session) throw new Error("redirecting");

let payments = [];
let commissions = [];
let buyers = [];
let deals = [];
let sellers = [];

const els = {
  errorBox: document.getElementById("errorBox"),
  paymentsWrap: document.getElementById("paymentsWrap"),
  commissionsWrap: document.getElementById("commissionsWrap"),
  addPaymentBtn: document.getElementById("addPaymentBtn"),
  paymentModalBackdrop: document.getElementById("paymentModalBackdrop"),
  paymentModalError: document.getElementById("paymentModalError"),
  paymentForm: document.getElementById("paymentForm"),
  buyerSelect: document.getElementById("buyerSelect"),
  periodMonth: document.getElementById("periodMonth"),
  amount: document.getElementById("amount"),
  paid: document.getElementById("paid"),
  paymentCancelBtn: document.getElementById("paymentCancelBtn"),
};

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function buyerName(id) {
  const b = buyers.find((x) => x.id === id);
  return b ? b.company_name : "—";
}
function dealLabel(id) {
  const d = deals.find((x) => x.id === id);
  if (!d) return "—";
  const s = sellers.find((x) => x.id === d.seller_id);
  const b = buyers.find((x) => x.id === d.buyer_id);
  return `${s?.business_name ?? "?"} → ${b?.company_name ?? "?"}`;
}

async function loadLookups() {
  const [bRes, dRes, sRes] = await Promise.all([
    supabase.from("buyers").select("id, company_name"),
    supabase.from("deals").select("id, seller_id, buyer_id"),
    supabase.from("sellers").select("id, business_name"),
  ]);
  buyers = bRes.data || [];
  deals = dRes.data || [];
  sellers = sRes.data || [];
  els.buyerSelect.innerHTML = buyers.map((b) => `<option value="${b.id}">${b.company_name}</option>`).join("");
}

async function loadPayments() {
  const { data, error } = await supabase.from("subscription_payments").select("*").order("period_month", { ascending: false });
  if (error) return showError(els.errorBox, error);
  payments = data || [];
  renderPayments();
}

async function loadCommissions() {
  const { data, error } = await supabase.from("commissions").select("*").order("created_at", { ascending: false });
  if (error) return showError(els.errorBox, error);
  commissions = data || [];
  renderCommissions();
}

function renderPayments() {
  if (payments.length === 0) {
    els.paymentsWrap.innerHTML = `<div class="empty-state">No subscription payments logged yet.</div>`;
    return;
  }
  els.paymentsWrap.innerHTML = `
    <table>
      <thead><tr><th>Buyer</th><th>Month</th><th>Amount</th><th>Status</th><th></th></tr></thead>
      <tbody>
        ${payments
          .map(
            (p) => `
          <tr data-id="${p.id}">
            <td>${escapeHtml(buyerName(p.buyer_id))}</td>
            <td class="muted">${new Date(p.period_month).toLocaleDateString(undefined, { year: "numeric", month: "long" })}</td>
            <td class="num">$${Number(p.amount).toFixed(2)}</td>
            <td><span class="pill ${p.paid ? "paid" : "owed"}">${p.paid ? "Paid" : "Unpaid"}</span></td>
            <td><button class="btn secondary small" data-toggle="${p.id}">${p.paid ? "Mark unpaid" : "Mark paid"}</button></td>
          </tr>`
          )
          .join("")}
      </tbody>
    </table>
  `;
  els.paymentsWrap.querySelectorAll("[data-toggle]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const p = payments.find((x) => x.id === btn.dataset.toggle);
      const { error } = await supabase
        .from("subscription_payments")
        .update({ paid: !p.paid, paid_at: !p.paid ? new Date().toISOString() : null })
        .eq("id", p.id);
      if (error) return showError(els.errorBox, error);
      await loadPayments();
    });
  });
}

function renderCommissions() {
  if (commissions.length === 0) {
    els.commissionsWrap.innerHTML = `<div class="empty-state">No commissions yet — close a deal on the Deals page to create one.</div>`;
    return;
  }
  els.commissionsWrap.innerHTML = `
    <table>
      <thead><tr><th>Deal</th><th>Amount</th><th>Status</th></tr></thead>
      <tbody>
        ${commissions
          .map(
            (c) => `
          <tr data-id="${c.id}">
            <td>${escapeHtml(dealLabel(c.deal_id))}</td>
            <td class="num">$${Number(c.amount).toFixed(2)}</td>
            <td>
              <select data-status="${c.id}" style="width:auto;display:inline-block;">
                <option value="owed" ${c.status === "owed" ? "selected" : ""}>Owed</option>
                <option value="invoiced" ${c.status === "invoiced" ? "selected" : ""}>Invoiced</option>
                <option value="paid" ${c.status === "paid" ? "selected" : ""}>Paid</option>
              </select>
            </td>
          </tr>`
          )
          .join("")}
      </tbody>
    </table>
  `;
  els.commissionsWrap.querySelectorAll("[data-status]").forEach((sel) => {
    sel.addEventListener("change", async () => {
      const status = sel.value;
      const paid_at = status === "paid" ? new Date().toISOString() : null;
      const { error } = await supabase.from("commissions").update({ status, paid_at }).eq("id", sel.dataset.status);
      if (error) return showError(els.errorBox, error);
      await loadCommissions();
    });
  });
}

els.addPaymentBtn.addEventListener("click", () => {
  els.paymentForm.reset();
  els.paymentModalError.classList.add("hidden");
  els.paymentModalBackdrop.classList.remove("hidden");
});
els.paymentCancelBtn.addEventListener("click", () => els.paymentModalBackdrop.classList.add("hidden"));

els.paymentForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  els.paymentModalError.classList.add("hidden");
  const payload = {
    buyer_id: els.buyerSelect.value,
    period_month: `${els.periodMonth.value}-01`,
    amount: Number(els.amount.value),
    paid: els.paid.checked,
    paid_at: els.paid.checked ? new Date().toISOString() : null,
  };
  const { error } = await supabase.from("subscription_payments").insert(payload);
  if (error) return showError(els.paymentModalError, error);
  els.paymentModalBackdrop.classList.add("hidden");
  await loadPayments();
});

await loadLookups();
await loadPayments();
await loadCommissions();
