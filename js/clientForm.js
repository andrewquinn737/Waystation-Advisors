// Shared "new / edit client" form builder — used by both clients.js (the
// Clients page itself) and dials.js (the "Create client" shortcut, which
// pre-fills this same form from a dial's info).
//
// Buyer-specific fields are back (Round G): a buyer client gets NO "Company
// details" section at all (that's a seller-only concept), and its
// Preferences/Other notes sections collapse into a single "Notes" section
// containing Price range desired (money_to_spend_min/max) + the looking_for
// textarea + Other notes. Every function below that behaves differently per
// side takes/derives a clientType ("buyer" | "seller") rather than assuming
// "seller" like before.

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

// Briefly merged into a single "Notes" box (see project history) — reverted
// back to two separate boxes per feedback. "What they're looking for in a
// buyer" is a seller client's own counterpart; a buyer client (see
// js/dealSide.js's Sellers/Buyers toggle, admin-only) is looking for a
// seller instead, so the label flips based on client.client_type.
export function lookingForLabel(clientType) {
  return clientType === "buyer" ? "What they're looking for in a seller" : "What they're looking for in a buyer";
}

export function defaultClient(profile, overrides) {
  return Object.assign(
    {
      first_name: "", last_name: "", client_type: "seller", city: "", state: "",
      email: "", mobile_phone: "", company_phone: "", linkedin: "", company_name: "", industry: "",
      annual_revenue: null, employee_count: null, founded_year: null, founded_month: null,
      money_to_spend_min: null, money_to_spend_max: null,
      looking_for: "", other_notes: "",
      intern_name: profile?.full_name || "",
    },
    overrides || {}
  );
}

// Used only for the two "Founded" <select>s below — separate from month/year
// selects so a year can be picked without being forced to also pick a month
// (see buildEditableSections). Index 0 is left blank on purpose (months are
// 1-12), matching how founded_month is stored in the database.
const FOUNDED_MONTH_NAMES = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function foundedYearOptions(selectedYear) {
  const currentYear = new Date().getFullYear();
  const years = [];
  for (let y = currentYear; y >= 1900; y--) years.push(y);
  return years.map((y) => `<option value="${y}" ${selectedYear === y ? "selected" : ""}>${y}</option>`).join("");
}

// Personal information + Contact information — identical for both sides, so
// factored out and shared by both branches of buildEditableSections below.
function personalAndContactSectionsHTML(client) {
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
        <label for="f_mobile_phone">Mobile number</label>
        <input id="f_mobile_phone" type="tel" value="${escapeHtml(client.mobile_phone)}" />
        <label for="f_company_phone">Company number</label>
        <input id="f_company_phone" type="tel" value="${escapeHtml(client.company_phone)}" />
        <label for="f_linkedin">LinkedIn</label>
        <input id="f_linkedin" value="${escapeHtml(client.linkedin)}" />
      </div>
    </div>
  `;
}

export function buildEditableSections(client) {
  if (client.client_type === "buyer") {
    // Buyer clients get no "Company details" section at all (that's a
    // seller-only concept) — Preferences and Other notes also collapse into
    // one combined "Notes" section, with money_to_spend_min/max ("Price
    // range desired") added alongside looking_for/other_notes.
    return `
      ${personalAndContactSectionsHTML(client)}
      <div class="accordion-section" data-section="notes">
        <div class="accordion-header"><span>Notes</span><span class="chevron">&#9662;</span></div>
        <div class="accordion-body">
          <div class="form-row">
            <div>
              <label for="f_money_min">Price range desired (min $)</label>
              <input id="f_money_min" type="number" step="0.1" min="0" value="${client.money_to_spend_min ?? ""}" />
            </div>
            <div>
              <label for="f_money_max">Price range desired (max $)</label>
              <input id="f_money_max" type="number" step="0.1" min="0" value="${client.money_to_spend_max ?? ""}" />
            </div>
          </div>
          <div class="field-label-row"><label for="f_looking_for">${lookingForLabel(client.client_type)}</label><span class="field-required-msg hidden" data-field="looking_for">required</span></div>
          <textarea id="f_looking_for">${escapeHtml(client.looking_for || "")}</textarea>
          <label for="f_other_notes">Other notes</label>
          <textarea id="f_other_notes">${escapeHtml(client.other_notes || "")}</textarea>
        </div>
      </div>
    `;
  }

  return `
    ${personalAndContactSectionsHTML(client)}

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
        <div class="form-row">
          <div>
            <label for="f_founded_month">Founded month</label>
            <select id="f_founded_month">
              <option value="">—</option>
              ${FOUNDED_MONTH_NAMES.map((name, i) => (i === 0 ? "" : `<option value="${i}" ${client.founded_month === i ? "selected" : ""}>${name}</option>`)).join("")}
            </select>
          </div>
          <div>
            <label for="f_founded_year">Founded year</label>
            <select id="f_founded_year">
              <option value="">—</option>
              ${foundedYearOptions(client.founded_year)}
            </select>
          </div>
        </div>
      </div>
    </div>

    <div class="accordion-section" data-section="preferences">
      <div class="accordion-header"><span>Preferences</span><span class="chevron">&#9662;</span></div>
      <div class="accordion-body">
        <div class="field-label-row"><label for="f_looking_for">${lookingForLabel(client.client_type)}</label><span class="field-required-msg hidden" data-field="looking_for">required</span></div>
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

// clientType ("buyer" | "seller") tells this which set of fields actually
// exist in `container` right now (see buildEditableSections) — a buyer form
// has no #f_company_name/#f_industry/#f_revenue/etc at all, and has
// #f_money_min/#f_money_max instead, which a seller form doesn't. Passed
// explicitly rather than read back off the DOM so callers (validateAndCollect
// in clients.js) can supply it once from whichever is authoritative: the
// deal-side toggle while creating, or the existing client's own client_type
// while editing (never re-derived from the form itself, since editing must
// never change what side a client is on).
export function collectFormData(container, clientType) {
  const isBuyer = clientType === "buyer";
  const data = {
    first_name: container.querySelector("#f_first_name").value.trim(),
    last_name: container.querySelector("#f_last_name").value.trim(),
    client_type: clientType,
    city: container.querySelector("#f_city").value.trim(),
    state: container.querySelector("#f_state").value,
    email: container.querySelector("#f_email").value.trim(),
    mobile_phone: container.querySelector("#f_mobile_phone").value.trim(),
    company_phone: container.querySelector("#f_company_phone").value.trim(),
    linkedin: container.querySelector("#f_linkedin").value.trim(),
    looking_for: container.querySelector("#f_looking_for").value.trim(),
    other_notes: container.querySelector("#f_other_notes").value.trim(),
    intern_name: container.querySelector("#f_intern_name").value.trim(),
  };
  if (isBuyer) {
    const min = container.querySelector("#f_money_min").value;
    const max = container.querySelector("#f_money_max").value;
    data.money_to_spend_min = min === "" ? null : Number(min);
    data.money_to_spend_max = max === "" ? null : Number(max);
    // Seller-only columns — explicitly nulled rather than left untouched, so
    // switching company-details data never lingers on a client that no
    // longer has anywhere in the UI to show or edit it.
    data.company_name = null;
    data.industry = null;
    data.annual_revenue = null;
    data.employee_count = null;
    data.founded_year = null;
    data.founded_month = null;
  } else {
    data.company_name = container.querySelector("#f_company_name").value.trim();
    data.industry = container.querySelector("#f_industry").value.trim();
    const rev = container.querySelector("#f_revenue").value;
    const emp = container.querySelector("#f_employees").value;
    data.annual_revenue = rev === "" ? null : Number(rev);
    data.employee_count = emp === "" ? null : Number(emp);
    // Month and year are independent selects now (see buildEditableSections) —
    // a year can be saved on its own with no month chosen, unlike the old
    // single <input type="month"> which forced both or neither.
    const foundedMonth = container.querySelector("#f_founded_month").value;
    const foundedYear = container.querySelector("#f_founded_year").value;
    data.founded_year = foundedYear ? Number(foundedYear) : null;
    data.founded_month = foundedMonth ? Number(foundedMonth) : null;
    // money_to_spend_min/max are buyer-only — nulled here for the same
    // reason company_name/etc are nulled in the buyer branch above.
    data.money_to_spend_min = null;
    data.money_to_spend_max = null;
  }
  return data;
}

export function getMissingFields(data) {
  const missing = [];
  const popupLabels = [];
  const isBuyer = data.client_type === "buyer";

  let nameMissing = false;
  if (!data.first_name) { missing.push("first_name"); nameMissing = true; }
  if (!data.last_name) { missing.push("last_name"); nameMissing = true; }
  if (nameMissing) popupLabels.push("Name");

  // Company name/industry only exist on a seller's form at all (see
  // buildEditableSections) — never required for a buyer.
  if (!isBuyer && !data.company_name) { missing.push("company_name"); popupLabels.push("Company name"); }

  if (!data.email && !data.mobile_phone && !data.company_phone) { missing.push("contact"); popupLabels.push("Phone number and/or email"); }

  let locMissing = false;
  if (!data.city) { missing.push("city"); locMissing = true; }
  if (!data.state) { missing.push("state"); locMissing = true; }
  if (locMissing) popupLabels.push("Location");

  if (!isBuyer && !data.industry) { missing.push("industry"); popupLabels.push("Sector"); }

  if (!data.looking_for) { missing.push("looking_for"); popupLabels.push("What they're looking for"); }

  if (!data.intern_name) { missing.push("intern_name"); popupLabels.push("Intern's name"); }

  return { missing, popupLabels };
}
