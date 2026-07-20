import { supabase } from "./supabaseClient.js";
import { requireSession, showError } from "./auth.js";

const session = await requireSession();
if (!session) throw new Error("redirecting to login");
const { profile } = session;
const isLead = profile.role === "team_lead";

let buyers = [];
let interns = [];

const els = {
  errorBox: document.getElementById("errorBox"),
  tableWrap: document.getElementById("tableWrap"),
  search: document.getElementById("search"),
  countBadge: document.getElementById("countBadge"),
  addBtn: document.getElementById("addBtn"),
  modalBackdrop: document.getElementById("modalBackdrop"),
  modalTitle: document.getElementById("modalTitle"),
  modalError: document.getElementById("modalError"),
  form: document.getElementById("buyerForm"),
  buyerId: document.getElementById("buyerId"),
  companyName: document.getElementById("companyName"),
  contactName: document.getElementById("contactName"),
  contactEmail: document.getElementById("contactEmail"),
  contactPhone: document.getElementById("contactPhone"),
  notes: document.getElementById("notes"),
  leadOnlyFields: document.getElementById("leadOnlyFields"),
  subscriptionStatus: document.getElementById("subscriptionStatus"),
  monthlyFee: document.getElementById("monthlyFee"),
  assignedTo: document.getElementById("assignedTo"),
  deleteBtn: document.getElementById("deleteBtn"),
  cancelBtn: document.getElementById("cancelBtn"),
};

if (isLead) {
  els.addBtn.classList.remove("hidden");
  els.deleteBtn.classList.remove("hidden");
} else {
  els.leadOnlyFields.classList.add("hidden");
}

async function loadInterns() {
  const { data, error } = await supabase.from("profiles").select("id, full_name, role");
  if (error) return showError(els.errorBox, error);
  interns = data || [];
  els.assignedTo.innerHTML =
    `<option value="">Unassigned</option>` +
    interns.map((p) => `<option value="${p.id}">${p.full_name} (${p.role})</option>`).join("");
}

function internName(id) {
  const p = interns.find((i) => i.id === id);
  return p ? p.full_name : "—";
}

async function loadBuyers() {
  const { data, error } = await supabase
    .from("buyers")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) return showError(els.errorBox, error);
  buyers = data || [];
  renderTable();
}

function renderTable() {
  const q = els.search.value.trim().toLowerCase();
  const rows = buyers.filter(
    (b) =>
      !q ||
      b.company_name.toLowerCase().includes(q) ||
      (b.contact_name || "").toLowerCase().includes(q)
  );
  els.countBadge.textContent = `${rows.length} buyer${rows.length === 1 ? "" : "s"}`;

  if (rows.length === 0) {
    els.tableWrap.innerHTML = `<div class="empty-state">No buyers yet.</div>`;
    return;
  }

  const financeCols = isLead
    ? `<th>Subscription</th><th>Monthly fee</th><th>Assigned</th>`
    : ``;

  els.tableWrap.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Company</th><th>Contact</th>${financeCols}<th></th>
        </tr>
      </thead>
      <tbody>
        ${rows
          .map(
            (b) => `
          <tr data-id="${b.id}">
            <td>${escapeHtml(b.company_name)}</td>
            <td class="muted">${escapeHtml(b.contact_name || "—")}<br/><span style="font-size:12px">${escapeHtml(b.contact_email || "")}</span></td>
            ${
              isLead
                ? `<td><span class="pill ${b.subscription_status}">${b.subscription_status}</span></td>
                   <td class="num">$${Number(b.monthly_fee).toFixed(2)}</td>
                   <td class="muted">${escapeHtml(internName(b.assigned_to))}</td>`
                : ``
            }
            <td><button class="btn secondary small" data-edit="${b.id}">Edit</button></td>
          </tr>`
          )
          .join("")}
      </tbody>
    </table>
  `;

  els.tableWrap.querySelectorAll("[data-edit]").forEach((btn) => {
    btn.addEventListener("click", () => openModal(buyers.find((b) => b.id === btn.dataset.edit)));
  });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function openModal(buyer) {
  els.modalError.classList.add("hidden");
  els.form.reset();
  els.buyerId.value = buyer?.id || "";
  els.modalTitle.textContent = buyer ? "Edit buyer" : "New buyer";
  els.companyName.value = buyer?.company_name || "";
  els.contactName.value = buyer?.contact_name || "";
  els.contactEmail.value = buyer?.contact_email || "";
  els.contactPhone.value = buyer?.contact_phone || "";
  els.notes.value = buyer?.notes || "";
  if (isLead) {
    els.subscriptionStatus.value = buyer?.subscription_status || "active";
    els.monthlyFee.value = buyer?.monthly_fee ?? 0;
    els.assignedTo.value = buyer?.assigned_to || "";
  }
  els.deleteBtn.classList.toggle("hidden", !isLead || !buyer);
  els.modalBackdrop.classList.remove("hidden");
}

function closeModal() {
  els.modalBackdrop.classList.add("hidden");
}

els.addBtn?.addEventListener("click", () => openModal(null));
els.cancelBtn.addEventListener("click", closeModal);
els.search.addEventListener("input", renderTable);

els.form.addEventListener("submit", async (e) => {
  e.preventDefault();
  els.modalError.classList.add("hidden");

  const payload = {
    company_name: els.companyName.value.trim(),
    contact_name: els.contactName.value.trim() || null,
    contact_email: els.contactEmail.value.trim() || null,
    contact_phone: els.contactPhone.value.trim() || null,
    notes: els.notes.value.trim() || null,
  };
  if (isLead) {
    payload.subscription_status = els.subscriptionStatus.value;
    payload.monthly_fee = Number(els.monthlyFee.value) || 0;
    payload.assigned_to = els.assignedTo.value || null;
  }

  const id = els.buyerId.value;
  let error;
  if (id) {
    ({ error } = await supabase.from("buyers").update(payload).eq("id", id));
  } else {
    ({ error } = await supabase.from("buyers").insert(payload));
  }

  if (error) return showError(els.modalError, error);
  closeModal();
  await loadBuyers();
});

els.deleteBtn.addEventListener("click", async () => {
  const id = els.buyerId.value;
  if (!id || !confirm("Delete this buyer? This cannot be undone.")) return;
  const { error } = await supabase.from("buyers").delete().eq("id", id);
  if (error) return showError(els.modalError, error);
  closeModal();
  await loadBuyers();
});

await loadInterns();
await loadBuyers();
