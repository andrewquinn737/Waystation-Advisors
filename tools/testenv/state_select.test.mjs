// Regression: editing a dial whose state is a 2-letter code must not blank the state (round 4). Run: node state_select.test.mjs
import { stateToName, stateToCode, stateOptionsHTML } from "../../dealflow-app/js/clientForm.js";
let ok = 0, n = 0;
const check = (name, c) => { n++; if (c) ok++; console.log((c ? "PASS " : "FAIL ") + name); };
const sel = (html) => (html.match(/<option value="([^"]*)" selected>/) || [])[1];
const label = (html) => (html.match(/<option value="[^"]*" selected>([^<]*)</) || [])[1];
check("UT maps to Utah", stateToName("UT") === "Utah" && stateToName("ut") === "Utah" && stateToName(" tx ") === "Texas");
check("a full name stays, any case", stateToName("Utah") === "Utah" && stateToName("new york") === "New York");
check("a code selects its state but keeps the stored value (UT stays UT on save)", sel(stateOptionsHTML("UT")) === "UT" && label(stateOptionsHTML("UT")) === "Utah" && sel(stateOptionsHTML("TX")) === "TX" && label(stateOptionsHTML("TX")) === "Texas");
check("the select preselects a full name and saves it as the 2-letter code (round 5: one location format)", sel(stateOptionsHTML("Texas")) === "TX" && label(stateOptionsHTML("Texas")) === "Texas");
check("a value that matches nothing (Ontario, DC) is kept as its own selected option (never saved as blank)", sel(stateOptionsHTML("Ontario")) === "Ontario" && sel(stateOptionsHTML("DC")) === "DC" && sel(stateOptionsHTML("Not in the US")) === "Not in the US");
check("empty stays empty", sel(stateOptionsHTML("")) === undefined && sel(stateOptionsHTML(null)) === undefined);
check("every 2-letter code on the map resolves to a listed state", ["AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY"].every((c) => sel(stateOptionsHTML(c)) === c && label(stateOptionsHTML(c)) === stateToName(c) && stateToName(c).length > 2));
check("stateToCode: names and codes become the code, anything else is kept", stateToCode("Utah") === "UT" && stateToCode("ut") === "UT" && stateToCode("new york") === "NY" && stateToCode("Ontario") === "Ontario" && stateToCode("") === "");
console.log(`\n${ok}/${n} passed`);
process.exit(ok === n ? 0 : 1);
