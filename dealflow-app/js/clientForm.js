// Shared "new / edit client" form builder — used by both clients.js (the
// Clients page itself) and dials.js (the "Create client" shortcut, which
// pre-fills this same form from a dial's info).

// Buyer support is temporarily hidden (not removed) — everything is treated
// as a seller for now. Flip this back to true to re-expose the Buyer/Seller
// choice and buyer-specific fields without touching any other code.
export const BUYERS_ENABLED = false;

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

export function lookingForLabel(type) {
  return type === "seller" ? "What they're looking for in a buyer" : "What they're looking for in a seller";
}

export function defaultClient(profile, overrides) {
  return Object.assign(
    {
      first_name: "", last_name: "", client_type: BUYERS_ENABLED ? "buyer" : "seller", city: "", state: "",
      email: "", phone: "", linkedin: "", company_name: "", industry: "",
      annual_revenue: null, employee_count: null, founded_year: null, founded_month: null,
      money_to_spend_min: null, money_to_spend_max: null, looking_for: "", other_notes: "",
      intern_name: profile?.full_name || "",
    },
    overrides || {}
  );
}

export function buildEditableSections(client) {
  const type = client.client_type || "buyer";
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
        <div class="${BUYERS_ENABLED ? "" : "hidden"}">
          <div class="field-label-row"><label for="f_client_type">Buyer / Seller</label><span class="field-required-msg hidden" data-field="client_type">required</span></div>
          <select id="f_client_type">
            <option value="buyer" ${type === "buyer" ? "selected" : ""}>Buyer</option>
            <option value="seller" ${type === "seller" ? "selected" : ""}>Seller</option>
          </select>
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
      <div class="accordion-header"><span>Company &amp; investment details</span><span class="chevron">&#9662;</span></div>
      <div class="accordion-body">
        <div class="seller-fields ${type === "seller" ? "" : "hidden"}">
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
        <div class="buyer-fields ${type === "buyer" ? "" : "hidden"}">
          <div class="section-title" style="margin-top:0;">Money to spend (range)</div>
          <div class="form-row">
            <div>
              <label for="f_money_min">Minimum ($)</label>
              <input id="f_money_min" type="number" step="0.1" min="0" value="${client.money_to_spend_min ?? ""}" />
            </div>
            <div>
              <label for="f_money_max">Maximum ($)</label>
              <input id="f_money_max" type="number" step="0.1" min="0" value="${client.money_to_spend_max ?? ""}" />
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="accordion-section" data-section="preferences">
      <div class="accordion-header"><span>Preferences</span><span class="chevron">&#9662;</span></div>
      <div class="accordion-body">
        <div class="field-label-row"><label for="f_looking_for" id="lookingForLabel">${lookingForLabel(type)}</label><span class="field-required-msg hidden" data-field="looking_for">required</span></div>
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
  const typeSel = container.querySelector("#f_client_type");
  const sellerFields = container.querySelector(".seller-fields");
  const buyerFields = container.querySelector(".buyer-fields");
  const lookingLabel = container.querySelector("#lookingForLabel");
  typeSel.addEventListener("change", () => {
    const v = typeSel.value;
    sellerFields.classList.toggle("hidden", v !== "seller");
    buyerFields.classList.toggle("hidden", v !== "buyer");
    lookingLabel.textContent = lookingForLabel(v);
  });
}

export function collectFormData(container) {
  const type = container.querySelector("#f_client_type").value;
  const data = {
    first_name: container.querySelector("#f_first_name").value.trim(),
    last_name: container.querySelector("#f_last_name").value.trim(),
    client_type: type,
    city: container.querySelector("#f_city").value.trim(),
    state: container.querySelector("#f_state").value,
    email: container.querySelector("#f_email").value.trim(),
    phone: container.querySelector("#f_phone").value.trim(),
    linkedin: container.querySelector("#f_linkedin").value.trim(),
    looking_for: container.querySelector("#f_looking_for").value.trim(),
    other_notes: container.querySelector("#f_other_notes").value.trim(),
    intern_name: container.querySelector("#f_intern_name").value.trim(),
  };
  if (type === "seller") {
    data.company_name = container.querySelector("#f_company_name").value.trim();
    data.industry = container.querySelector("#f_industry").value.trim();
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
    data.money_to_spend_min = null;
    data.money_to_spend_max = null;
  } else {
    data.company_name = null;
    data.industry = null;
    data.annual_revenue = null;
    data.employee_count = null;
    data.founded_year = null;
    data.founded_month = null;
    const min = container.querySelector("#f_money_min").value;
    const max = container.querySelector("#f_money_max").value;
    data.money_to_spend_min = min === "" ? null : Number(min);
    data.money_to_spend_max = max === "" ? null : Number(max);
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

  if (!data.client_type) { missing.push("client_type"); popupLabels.push("Buyer/Seller"); }

  if (data.client_type === "seller" && !data.company_name) { missing.push("company_name"); popupLabels.push("Company name"); }

  if (!data.email && !data.phone) { missing.push("contact"); popupLabels.push("Phone number and/or email"); }

  let locMissing = false;
  if (!data.city) { missing.push("city"); locMissing = true; }
  if (!data.state) { missing.push("state"); locMissing = true; }
  if (locMissing) popupLabels.push("Location");

  if (data.client_type === "seller" && !data.industry) { missing.push("industry"); popupLabels.push("Sector"); }

  if (!data.looking_for) { missing.push("looking_for"); popupLabels.push("What they're looking for"); }

  if (!data.intern_name) { missing.push("intern_name"); popupLabels.push("Intern's name"); }

  return { missing, popupLabels };
}
