import { supabase } from "./supabaseClient.js";
import { requireSession, showError } from "./auth.js";

const session = await requireSession();
if (!session) throw new Error("redirecting to login");
const { profile } = session;
const isLead = profile.role === "team_lead";

let deals = [];
let sellers = [];
let buyers = [];

const els = {
  errorBox: document.getElementById("errorBox"),
  tableWrap: document.getElementById("tableWrap"),
  statusFilter: document.getElementById("statusFilter"),
  countBadge: document.getElementById("countBadge"),
  addBtn: document.getElementById("addBtn"),
  modalBackdrop: document.getElementById("modalBackdrop"),
  modalTitle: document.getElementById("modalTitle"),
  modalError: document.getElementById("modalError"),
  form: document.getElementById("dealForm"),
  dealId: document.getElementById("dealId"),
  sellerSelect: document.getElementById("sellerSelect"),
  buyerSelect: document.getElementById("buyerSelect"),
  status: document.getElementById("status"),
  closingFields: document.getElementById("closingFields"),
  salePrice: document.getElementById("salePrice"),
  commissionRate: document.getElementById("commissionRate"),
  closedWonOpt: document.getElementById("closedWonOpt"),
  closedLostOpt: document.getElementById("closedLostOpt"),
  deleteBtn: document.getElementById("deleteBtn"),
  cancelBtn: document.getElementById("cancelBtn"),
};

// Interns can move a deal through the early pipeline but only a team lead
// can close it (matches the DB trigger `protect_deal_closing`).
if (!isLead) {
  els.closedWonOpt.disabled = true;
  els.closedLostOpt.disabled = true;
}

function sellerName(id) {
  const s = sellers.find((x) => x.id === id);
  return s ? s.business_name : "—";
}
function buyerName(id) {
  const b = buyers.find((x) => x.id === id);
  return b ? b.company_name : "—";
}

async function loadLookups() {
  const [sRes, bRes] = await Promise.all([
    supabase.from("sellers").select("id, business_name"),
    supabase.from("buyers").select("id, company_name"),
  ]);
  if (sRes.error) return showError(els.errorBox, sRes.error);
  if (bRes.error) return showError(els.errorBox, bRes.error);
  sellers = sRes.data || [];
  buyers = bRes.data || [];
  els.sellerSelect.innerHTML = sellers.map((s) => `<option value="${s.id}">${s.business_name}</option>`).join("");
  els.buyerSelect.innerHTML = buyers.map((b) => `<option value="${b.id}">${b.company_name}</option>`).join("");
}

async function loadDeals() {
  const { data, error } = await supabase.from("deals").select("*").order("created_at", { ascending: false });
  if (error) return showError(els.errorBox, error);
  deals = data || [];
  renderTable();
}

function renderTable() {
  const filter = els.statusFilter.value;
  const rows = deals.filter((d) => !filter || d.status === filter);
  els.countBadge.textContent = `${rows.length} deal${rows.length === 1 ? "" : "s"}`;

  if (rows.length === 0) {
    els.tableWrap.innerHTML = `<div class="empty-state">No deals yet — pitch a seller lead to a buyer to create one.</div>`;
    return;
  }

  els.tableWrap.innerHTML = `
    <table>
      <thead>
        <tr><th>Seller</th><th>Buyer</th><th>Status</th><th>Sale price</th><th></th></tr>
      </thead>
      <tbody>
        ${rows
          .map(
            (d) => `
          <tr data-id="${d.id}">
            <td>${escapeHtml(sellerName(d.seller_id))}</td>
            <td>${escapeHtml(buyerName(d.buyer_id))}</td>
            <td><span class="pill ${d.status}">${d.status.replace("_", " ")}</span></td>
            <td class="num">${d.sale_price != null ? "$" + Number(d.sale_price).toFixed(2) : "—"}</td>
            <td><button class="btn secondary small" data-edit="${d.id}">Edit</button></td>
          </tr>`
          )
          .join("")}
      </tbody>
    </table>
  `;

  els.tableWrap.querySelectorAll("[data-edit]").forEach((btn) => {
    btn.addEventListener("click", () => openModal(deals.find((d) => d.id === btn.dataset.edit)));
  });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function updateClosingVisibility() {
  const closing = els.status.value === "closed_won" || els.status.value === "closed_lost";
  els.closingFields.classList.toggle("hidden", !closing || !isLead);
}
els.status.addEventListener("change", updateClosingVisibility);

function openModal(deal) {
  els.modalError.classList.add("hidden");
  els.form.reset();
  els.dealId.value = deal?.id || "";
  els.modalTitle.textContent = deal ? "Edit deal" : "New deal";
  els.sellerSelect.value = deal?.seller_id || (sellers[0]?.id ?? "");
  els.buyerSelect.value = deal?.buyer_id || (buyers[0]?.id ?? "");
  els.sellerSelect.disabled = !!deal; // don't let people repoint an existing deal to a different lead/buyer
  els.buyerSelect.disabled = !!deal;
  els.status.value = deal?.status || "pitched";
  els.salePrice.value = deal?.sale_price ?? "";
  els.commissionRate.value = deal?.commission_rate != null ? deal.commission_rate * 100 : "";
  updateClosingVisibility();
  els.deleteBtn.classList.toggle("hidden", !isLead || !deal);
  els.modalBackdrop.classList.remove("hidden");
}

function closeModal() {
  els.modalBackdrop.classList.add("hidden");
}

els.addBtn.addEventListener("click", () => {
  if (sellers.length === 0 || buyers.length === 0) {
    showError(els.errorBox, { message: "Add at least one seller lead and one buyer before creating a deal." });
    return;
  }
  openModal(null);
});
els.cancelBtn.addEventListener("click", closeModal);
els.statusFilter.addEventListener("change", renderTable);

els.form.addEventListener("submit", async (e) => {
  e.preventDefault();
  els.modalError.classList.add("hidden");

  const id = els.dealId.value;
  const status = els.status.value;
  const isClosing = status === "closed_won" || status === "closed_lost";

  const payload = { status };
  if (isLead && isClosing) {
    payload.sale_price = els.salePrice.value === "" ? null : Number(els.salePrice.value);
    payload.commission_rate = els.commissionRate.value === "" ? null : Number(els.commissionRate.value) / 100;
    payload.closed_at = new Date().toISOString();
  }

  let error, dealRow;
  if (id) {
    ({ data: dealRow, error } = await supabase.from("deals").update(payload).eq("id", id).select().single());
  } else {
    payload.seller_id = els.sellerSelect.value;
    payload.buyer_id = els.buyerSelect.value;
    ({ data: dealRow, error } = await supabase.from("deals").insert(payload).select().single());
  }

  if (error) return showError(els.modalError, error);

  // Auto-create the commission record when a lead closes a deal as won.
  if (isLead && status === "closed_won" && dealRow?.sale_price != null && dealRow?.commission_rate != null) {
    const { data: existing } = await supabase.from("commissions").select("id").eq("deal_id", dealRow.id).maybeSingle();
    if (!existing) {
      await supabase.from("commissions").insert({
        deal_id: dealRow.id,
        amount: Number(dealRow.sale_price) * Number(dealRow.commission_rate),
        status: "owed",
      });
    }
  }

  closeModal();
  await loadDeals();
});

els.deleteBtn.addEventListener("click", async () => {
  const id = els.dealId.value;
  if (!id || !confirm("Delete this deal? This cannot be undone.")) return;
  const { error } = await supabase.from("deals").delete().eq("id", id);
  if (error) return showError(els.modalError, error);
  closeModal();
  await loadDeals();
});

await loadLookups();
await loadDeals();
