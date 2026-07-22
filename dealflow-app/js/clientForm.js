// Shared "new / edit client" form builder — used by both clients.js (the
// Clients page itself) and dials.js (the "Create client" shortcut, which
// pre-fills this same form from a dial's info).
//
// Buyer support has been removed (not just hidden) — the app is sellers-only
// for now. The underlying `clients.client_type` column still exists in the
// database (always set to "seller" below) since dropping it isn't necessary,
// but there's no more buyer-facing UI, fields, or branching logic.

export const STATES = [
  "Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado", "Connecticut", "Delaware",
  "Florida", "Georgia", "Hawaii", "Idaho", "Illinois", "Indiana", "Iowa", "Kansas", "Kentucky",
  "Louisiana", "Maine", "Maryland", "Massachusetts", "Michigan", "Minnesota", "Mississippi", "Missouri",
  "Montana", "Nebraska", "Nevada", "New Hampshire", "New Jersey", "New Mexico", "New York",
  "North Carolina", "North Dakota", "Ohio", "Oklahoma", "Oregon", "Pennsylvania", "Rhode Island",
  "South Carolina", "South Dakota", "Tennessee", "Texas", "Utah", "Vermont", "Virginia", "Washington",
  "West Virginia", "Wisconsin", "Wyoming", "Not in the US",
];

export function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function lookingForLabel() {
  return "What they're looking for in a buyer";
}

export function defaultClient(profile, overrides) {
  return Object.assign(
    {
      first_name: "", last_name: "", client_type: "seller", city: "", state: "",
      email: "", phone: "", linkedin: "", company_name: "", industry: "",
      annual_revenue: null, employee_count: null, founded_year: null, founded_month: null,
      looking_for: "", other_notes: "",
      intern_name: profile?.full_name || "",
    },
    overrides || {}
  );
}

export function buildEditableSections(client) {
  const founded = client.founded_year ? `${client.founded_year}-${String(client.founded_month || 1).padStart(2, "0")}` : "";
  return `
    <div class="accordion-section open" data-section="personal">
      <div class="accordion-header"><span>Personal information</span><span class="chevron">&#9662;</span></div>
      <div class="accordion-body">
        <div class="form-row">
          <div>
            <div class="field-label-row"><label for="f_first_name">First name</label><span class="field-required-msg hidden" data-field="first_name">required</span></div>
            <input id="f_first_name" value="${escapeHtml(client.first_name)}" />
          </div>
          <div>
            <div class="field-label-row"><label for="f_last_name">Last name</label><span class="field-required-msg hidden" data-field="last_name">required</span></div>
            <input id="f_last_name" value="${escapeHtml(client.last_name)}" />
          </div>
        </div>
        <div class="form-row">
          <div>
            <div class="field-label-row"><label for="f_city">City</label><span class="field-required-msg hidden" data-field="city">required</span></div>
            <input id="f_city" value="${escapeHtml(client.city)}" />
          </div>
          <div>
            <div class="field-label-row"><label for="f_state">State</label><span class="field-required-msg hidden" data-field="state">required</span></div>
            <select id="f_state">
              <option value="">Select a state...</option>
              ${STATES.map((s) => `<option value="${s}" ${client.state === s ? "selected" : ""}>${s}</option>`).join("")}
            </select>
          </div>
        </div>
        <div class="field-label-row"><label for="f_intern_name">Intern's name</label><span class="field-required-msg hidden" data-field="intern_name">required</span></div>
        <input id="f_intern_name" value="${escapeHtml(client.intern_name)}" readonly style="background:var(--bg); color:var(--text-muted);" />
      </div>
    </div>

    <div class="accordion-section" data-section="contact">
      <div class="accordion-header"><span>Contact information</span><span class="chevron">&#9662;</span></div>
      <div class="accordion-body">
        <div class="field-label-row"><label for="f_email">Email</label><span class="field-required-msg hidden" data-field="contact">required</span></div>
        <input id="f_email" type="email" value="${escapeHtml(client.email)}" />
        <label for="f_phone">Phone number</label>
        <input id="f_phone" type="tel" value="${escapeHtml(client.phone)}" />
        <label for="f_linkedin">LinkedIn</label>
        <input id="f_linkedin" value="${escapeHtml(client.linkedin)}" />
      </div>
    </div>

    <div class="accordion-section" data-section="company">
      <div class="accordion-header"><span>Company details</span><span class="chevron">&#9662;</span></div>
      <div class="accordion-body">
        <div class="field-label-row"><label for="f_company_name">Company name</label><span class="field-required-msg hidden" data-field="company_name">required</span></div>
        <input id="f_company_name" value="${escapeHtml(client.company_name)}" />
        <div class="field-label-row"><label for="f_industry">Industry sector</label><span class="field-required-msg hidden" data-field="industry">required</span></div>
        <input id="f_industry" value="${escapeHtml(client.industry)}" />
        <div class="form-row">
          <div>
            <label for="f_revenue">Annual revenue ($)</label>
            <input id="f_revenue" type="number" step="0.1" min="0" value="${client.annual_revenue ?? ""}" />
          </div>
          <div>
            <label for="f_employees">Employees</label>
            <input id="f_employees" type="number" step="1" min="0" value="${client.employee_count ?? ""}" />
          </div>
        </div>
        <label for="f_founded">Founded (year / month)</label>
        <input id="f_founded" type="month" value="${founded}" />
      </div>
    </div>

    <div class="accordion-section" data-section="preferences">
      <div class="accordion-header"><span>Preferences</span><span class="chevron">&#9662;</span></div>
      <div class="accordion-body">
        <div class="field-label-row"><label for="f_looking_for">${lookingForLabel()}</label><span class="field-required-msg hidden" data-field="looking_for">required</span></div>
        <textarea id="f_looking_for">${escapeHtml(client.looking_for || "")}</textarea>
      </div>
    </div>

    <div class="accordion-section" data-section="notes">
      <div class="accordion-header"><span>Other notes</span><span class="chevron">&#9662;</span></div>
      <div class="accordion-body">
        <textarea id="f_other_notes">${escapeHtml(client.other_notes || "")}</textarea>
      </div>
    </div>
  `;
}

// container = the element the form HTML above was injected into (so multiple
// instances of this form — e.g. one on Clients, one on Dials — don't clash).
export function wireEditableFormEvents(container) {
  container.querySelectorAll(".accordion-header").forEach((header) => {
    header.addEventListener("click", () => header.parentElement.classList.toggle("open"));
  });
}

export function collectFormData(container) {
  const data = {
    first_name: container.querySelector("#f_first_name").value.trim(),
    last_name: container.querySelector("#f_last_name").value.trim(),
    client_type: "seller",
    city: container.querySelector("#f_city").value.trim(),
    state: container.querySelector("#f_state").value,
    email: container.querySelector("#f_email").value.trim(),
    phone: container.querySelector("#f_phone").value.trim(),
    linkedin: container.querySelector("#f_linkedin").value.trim(),
    looking_for: container.querySelector("#f_looking_for").value.trim(),
    other_notes: container.querySelector("#f_other_notes").value.trim(),
    intern_name: container.querySelector("#f_intern_name").value.trim(),
    company_name: container.querySelector("#f_company_name").value.trim(),
    industry: container.querySelector("#f_industry").value.trim(),
  };
  const rev = container.querySelector("#f_revenue").value;
  const emp = container.querySelector("#f_employees").value;
  data.annual_revenue = rev === "" ? null : Number(rev);
  data.employee_count = emp === "" ? null : Number(emp);
  const founded = container.querySelector("#f_founded").value;
  if (founded) {
    const [y, m] = founded.split("-");
    data.founded_year = Number(y);
    data.founded_month = Number(m);
  } else {
    data.founded_year = null;
    data.founded_month = null;
  }
  return data;
}

export function getMissingFields(data) {
  const missing = [];
  const popupLabels = [];

  let nameMissing = false;
  if (!data.first_name) { missing.push("first_name"); nameMissing = true; }
  if (!data.last_name) { missing.push("last_name"); nameMissing = true; }
  if (nameMissing) popupLabels.push("Name");

  if (!data.company_name) { missing.push("company_name"); popupLabels.push("Company name"); }

  if (!data.email && !data.phone) { missing.push("contact"); popupLabels.push("Phone number and/or email"); }

  let locMissing = false;
  if (!data.city) { missing.push("city"); locMissing = true; }
  if (!data.state) { missing.push("state"); locMissing = true; }
  if (locMissing) popupLabels.push("Location");

  if (!data.industry) { missing.push("industry"); popupLabels.push("Sector"); }

  if (!data.looking_for) { missing.push("looking_for"); popupLabels.push("What they're looking for"); }

  if (!data.intern_name) { missing.push("intern_name"); popupLabels.push("Intern's name"); }

  return { missing, popupLabels };
}
