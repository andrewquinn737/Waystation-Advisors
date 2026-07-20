import { supabase } from "./supabaseClient.js";
import { requireSession, showError } from "./auth.js";

const session = await requireSession();
if (!session) throw new Error("redirecting to login");
const { user, profile } = session;
const isLead = profile.role === "team_lead";

let sellers = [];
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
  form: document.getElementById("sellerForm"),
  sellerId: document.getElementById("sellerId"),
  businessName: document.getElementById("businessName"),
  industry: document.getElementById("industry"),
  status: document.getElementById("status"),
  contactName: document.getElementById("contactName"),
  contactEmail: document.getElementById("contactEmail"),
  contactPhone: document.getElementById("contactPhone"),
  notes: document.getElementById("notes"),
  leadOnlyFields: document.getElementById("leadOnlyFields"),
  askingPrice: document.getElementById("askingPrice"),
  assignedTo: document.getElementById("assignedTo"),
  deleteBtn: document.getElementById("deleteBtn"),
  cancelBtn: document.getElementById("cancelBtn"),
};

if (!isLead) {
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

async function loadSellers() {
  const { data, error } = await supabase
    .from("sellers")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) return showError(els.errorBox, error);
  sellers = data || [];
  renderTable();
}

function renderTable() {
  const q = els.search.value.trim().toLowerCase();
  const rows = sellers.filter(
    (s) => !q || s.business_name.toLowerCase().includes(q) || (s.industry || "").toLowerCase().includes(q)
  );
  els.countBadge.textContent = `${rows.length} lead${rows.length === 1 ? "" : "s"}`;

  if (rows.length === 0) {
    els.tableWrap.innerHTML = `<div class="empty-state">No seller leads yet — add one to get started.</div>`;
    return;
  }

  els.tableWrap.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Business</th><th>Industry</th><th>Status</th>
          ${isLead ? `<th>Asking price</th>` : ``}
          <th>Assigned</th><th></th>
        </tr>
      </thead>
      <tbody>
        ${rows
          .map(
            (s) => `
          <tr data-id="${s.id}">
            <td>${escapeHtml(s.business_name)}</td>
            <td class="muted">${escapeHtml(s.industry || "—")}</td>
            <td><span class="pill ${s.status}">${s.status}</span></td>
            ${isLead ? `<td class="num">${s.asking_price != null ? "$" + Number(s.asking_price).toFixed(2) : "—"}</td>` : ``}
            <td class="muted">${escapeHtml(internName(s.assigned_to))}</td>
            <td><button class="btn secondary small" data-edit="${s.id}">Edit</button></td>
          </tr>`
          )
          .join("")}
      </tbody>
    </table>
  `;

  els.tableWrap.querySelectorAll("[data-edit]").forEach((btn) => {
    btn.addEventListener("click", () => openModal(sellers.find((s) => s.id === btn.dataset.edit)));
  });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function openModal(seller) {
  els.modalError.classList.add("hidden");
  els.form.reset();
  els.sellerId.value = seller?.id || "";
  els.modalTitle.textContent = seller ? "Edit seller lead" : "New seller lead";
  els.businessName.value = seller?.business_name || "";
  els.industry.value = seller?.industry || "";
  els.status.value = seller?.status || "new";
  els.contactName.value = seller?.contact_name || "";
  els.contactEmail.value = seller?.contact_email || "";
  els.contactPhone.value = seller?.contact_phone || "";
  els.notes.value = seller?.notes || "";
  if (isLead) {
    els.askingPrice.value = seller?.asking_price ?? "";
    els.assignedTo.value = seller?.assigned_to || "";
  }
  els.deleteBtn.classList.toggle("hidden", !isLead || !seller);
  els.modalBackdrop.classList.remove("hidden");
}

function closeModal() {
  els.modalBackdrop.classList.add("hidden");
}

els.addBtn.addEventListener("click", () => openModal(null));
els.cancelBtn.addEventListener("click", closeModal);
els.search.addEventListener("input", renderTable);

els.form.addEventListener("submit", async (e) => {
  e.preventDefault();
  els.modalError.classList.add("hidden");

  const payload = {
    business_name: els.businessName.value.trim(),
    industry: els.industry.value.trim() || null,
    status: els.status.value,
    contact_name: els.contactName.value.trim() || null,
    contact_email: els.contactEmail.value.trim() || null,
    contact_phone: els.contactPhone.value.trim() || null,
    notes: els.notes.value.trim() || null,
  };
  if (isLead) {
    payload.asking_price = els.askingPrice.value === "" ? null : Number(els.askingPrice.value);
    payload.assigned_to = els.assignedTo.value || null;
  }

  const id = els.sellerId.value;
  let error;
  if (id) {
    ({ error } = await supabase.from("sellers").update(payload).eq("id", id));
  } else {
    // Interns can only insert leads they sourced themselves (enforced by RLS too).
    payload.found_by = user.id;
    if (!isLead) payload.assigned_to = user.id;
    ({ error } = await supabase.from("sellers").insert(payload));
  }

  if (error) return showError(els.modalError, error);
  closeModal();
  await loadSellers();
});

els.deleteBtn.addEventListener("click", async () => {
  const id = els.sellerId.value;
  if (!id || !confirm("Delete this seller lead? This cannot be undone.")) return;
  const { error } = await supabase.from("sellers").delete().eq("id", id);
  if (error) return showError(els.modalError, error);
  closeModal();
  await loadSellers();
});

await loadInterns();
await loadSellers();
