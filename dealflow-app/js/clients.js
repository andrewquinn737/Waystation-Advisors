import { supabase } from "./supabaseClient.js";
import { requireSession, showError } from "./auth.js";

const session = await requireSession();
if (!session) throw new Error("redirecting to login");
const { profile } = session;
const isLead = profile.role === "team_lead";

let clients = [];

const els = {
  errorBox: document.getElementById("errorBox"),
  tableWrap: document.getElementById("tableWrap"),
  search: document.getElementById("search"),
  countBadge: document.getElementById("countBadge"),
  addBtn: document.getElementById("addBtn"),
  modalBackdrop: document.getElementById("modalBackdrop"),
  modalTitle: document.getElementById("modalTitle"),
  modalError: document.getElementById("modalError"),
  form: document.getElementById("clientForm"),
  clientId: document.getElementById("clientId"),
  name: document.getElementById("name"),
  clientType: document.getElementById("clientType"),
  companyNameField: document.getElementById("companyNameField"),
  companyName: document.getElementById("companyName"),
  contactInfo: document.getElementById("contactInfo"),
  industry: document.getElementById("industry"),
  location: document.getElementById("location"),
  revenue: document.getElementById("revenue"),
  employees: document.getElementById("employees"),
  founded: document.getElementById("founded"),
  lookingFor: document.getElementById("lookingFor"),
  internName: document.getElementById("internName"),
  deleteBtn: document.getElementById("deleteBtn"),
  cancelBtn: document.getElementById("cancelBtn"),
};

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function updateCompanyFieldVisibility() {
  els.companyNameField.classList.toggle("hidden", els.clientType.value !== "seller");
}
els.clientType.addEventListener("change", updateCompanyFieldVisibility);

async function loadClients() {
  const { data, error } = await supabase.from("clients").select("*").order("created_at", { ascending: false });
  if (error) return showError(els.errorBox, error);
  clients = data || [];
  renderTable();
}

function renderTable() {
  const q = els.search.value.trim().toLowerCase();
  const rows = clients.filter(
    (c) =>
      !q ||
      c.name.toLowerCase().includes(q) ||
      (c.company_name || "").toLowerCase().includes(q) ||
      (c.industry || "").toLowerCase().includes(q)
  );
  els.countBadge.textContent = `${rows.length} client${rows.length === 1 ? "" : "s"}`;

  if (rows.length === 0) {
    els.tableWrap.innerHTML = `<div class="empty-state">No clients yet — tap + to add one.</div>`;
    return;
  }

  els.tableWrap.innerHTML = `
    <table>
      <thead>
        <tr><th>Name</th><th>Type</th><th>Industry</th><th>Location</th><th>Intern/contractor</th></tr>
      </thead>
      <tbody>
        ${rows
          .map(
            (c) => `
          <tr class="clickable-row" data-id="${c.id}">
            <td>${escapeHtml(c.name)}${c.company_name ? `<br/><span class="muted" style="font-size:12px">${escapeHtml(c.company_name)}</span>` : ""}</td>
            <td><span class="pill ${c.client_type === "buyer" ? "active" : "new"}">${c.client_type}</span></td>
            <td class="muted">${escapeHtml(c.industry || "—")}</td>
            <td class="muted">${escapeHtml(c.location || "—")}</td>
            <td class="muted">${escapeHtml(c.intern_name || "—")}</td>
          </tr>`
          )
          .join("")}
      </tbody>
    </table>
  `;

  els.tableWrap.querySelectorAll("[data-id]").forEach((row) => {
    row.addEventListener("click", () => openModal(clients.find((c) => c.id === row.dataset.id)));
  });
}

function openModal(client) {
  els.modalError.classList.add("hidden");
  els.form.reset();
  els.clientId.value = client?.id || "";
  els.modalTitle.textContent = client ? client.name : "New client";
  els.name.value = client?.name || "";
  els.clientType.value = client?.client_type || "buyer";
  els.companyName.value = client?.company_name || "";
  els.contactInfo.value = client?.contact_info || "";
  els.industry.value = client?.industry || "";
  els.location.value = client?.location || "";
  els.revenue.value = client?.annual_revenue ?? "";
  els.employees.value = client?.employee_count ?? "";
  if (client?.founded_year) {
    const mm = String(client.founded_month || 1).padStart(2, "0");
    els.founded.value = `${client.founded_year}-${mm}`;
  } else {
    els.founded.value = "";
  }
  els.lookingFor.value = client?.looking_for || "";
  els.internName.value = client?.intern_name || "";
  updateCompanyFieldVisibility();
  els.deleteBtn.classList.toggle("hidden", !isLead || !client);
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

  let foundedYear = null;
  let foundedMonth = null;
  if (els.founded.value) {
    const [y, m] = els.founded.value.split("-");
    foundedYear = Number(y);
    foundedMonth = Number(m);
  }

  const payload = {
    name: els.name.value.trim(),
    client_type: els.clientType.value,
    company_name: els.clientType.value === "seller" ? els.companyName.value.trim() || null : null,
    contact_info: els.contactInfo.value.trim() || null,
    industry: els.industry.value.trim() || null,
    location: els.location.value.trim() || null,
    annual_revenue: els.revenue.value === "" ? null : Number(els.revenue.value),
    employee_count: els.employees.value === "" ? null : Number(els.employees.value),
    founded_year: foundedYear,
    founded_month: foundedMonth,
    looking_for: els.lookingFor.value.trim() || null,
    intern_name: els.internName.value.trim() || null,
  };

  const id = els.clientId.value;
  let error;
  if (id) {
    ({ error } = await supabase.from("clients").update(payload).eq("id", id));
  } else {
    ({ error } = await supabase.from("clients").insert(payload));
  }

  if (error) return showError(els.modalError, error);
  closeModal();
  await loadClients();
});

els.deleteBtn.addEventListener("click", async () => {
  const id = els.clientId.value;
  if (!id || !confirm("Delete this client? This cannot be undone.")) return;
  const { error } = await supabase.from("clients").delete().eq("id", id);
  if (error) return showError(els.modalError, error);
  closeModal();
  await loadClients();
});

await loadClients();
