// "Rewrite with Claude" help panel for the review screen (collapsed by default).
import { escapeHtml } from "./clientForm.js";

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  const ta = document.createElement("textarea");
  ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { ok = false; }
  ta.remove();
  return ok;
}

export function claudeHelpHTML(listName) {
  const sentence = `Rewrite my held drafts in ${listName}`;
  return `<details class="cr-claude"><summary>Rewrite with Claude</summary>
    <div class="cr-claude-body">
      <p>Claude can rewrite the drafts that need fixing for you. It works on your own held drafts only, and its rewrites must pass the same checks as yours before they save.</p>
      <ol>
        <li>Open <b>Profile &gt; Connect Claude</b> and get your link (one time only).</li>
        <li>In Claude, ask: <span class="cr-claude-sentence">${escapeHtml(sentence)}</span></li>
      </ol>
      <button type="button" class="btn secondary cr-claude-copy" data-copy="${escapeHtml(sentence)}">Copy this sentence</button>
    </div></details>`;
}

export function wireClaudeHelp(root) {
  const b = root.querySelector(".cr-claude-copy");
  if (!b) return;
  b.onclick = async () => {
    const ok = await copyText(b.dataset.copy);
    b.textContent = ok ? "Copied" : "Couldn't copy - select the sentence above";
    setTimeout(() => { b.textContent = "Copy this sentence"; }, 2000);
  };
}
