// Admin page: Campaigns, Email accounts, Do not email, Settings (admin only). Tabs on desktop, stacked sections on phones.
import { requireSession } from "./auth.js";
import { initCampaigns } from "./adminCampaigns.js";
import { initAccounts } from "./adminAccounts.js";
import { initSettings } from "./adminSettings.js";
import { initSuppression } from "./adminSuppression.js";
import "./aiChat.js"; // mounts "Edit with Claude" into #aiChatMount when a campaign review opens

const $ = (id) => document.getElementById(id);
const { profile } = await requireSession();

if (profile.role !== "admin") $("adDenied").classList.remove("hidden");
else {
  $("adApp").classList.remove("hidden");
  const loaded = {};
  const inits = { campaigns: initCampaigns, accounts: initAccounts, suppression: initSuppression, settings: () => initSettings(profile) };
  const route = () => {
    const tab = ["campaigns", "accounts", "suppression", "settings"].includes(location.hash.slice(1)) ? location.hash.slice(1) : "campaigns";
    document.getElementById("adApp").classList.add("js-tabs");
    document.querySelectorAll(".ad-sec").forEach((s) => s.classList.toggle("on", s.dataset.sec === tab));
    document.querySelectorAll("#adTabs a[data-tab]").forEach((a) => a.classList.toggle("active", a.dataset.tab === tab));
    if (!loaded[tab]) { loaded[tab] = true; inits[tab](); }
  };
  // On phones every section is visible (stacked), so all of them load; on desktop each loads when its tab opens.
  const phone = window.matchMedia("(max-width: 720px)").matches;
  window.addEventListener("hashchange", route);
  route();
  if (phone) for (const k of Object.keys(inits)) if (!loaded[k]) { loaded[k] = true; inits[k](); }
}
