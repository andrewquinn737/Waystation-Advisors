// Leaving the page while an in-app call is live (Back, a nav tap, closing the tab): ask first, and if the page goes anyway close the call row.
//  isFinished() -> bool          the call is already over, nothing to guard
//  hangup()                      end the call on the line
//  closeRow()                    best effort write of the call's end (keepalive request: it survives the page going away)
// Returns remove(): call it when the call ends.
import { confirmBox } from "./copyCommon.js";

export function installLeaveGuard({ isFinished, hangup, closeRow }) {
  const onBeforeUnload = (e) => { if (isFinished()) return; e.preventDefault(); e.returnValue = ""; };
  const onPageHide = () => { if (isFinished()) return; try { hangup(); } catch { /* ignore */ } try { closeRow(); } catch { /* ignore */ } };
  let asking = false;
  const onNavClick = async (e) => {
    if (isFinished() || asking) return;
    const a = e.target.closest?.("a[href]");
    if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
    const raw = a.getAttribute("href") || "";
    if (!raw || raw.startsWith("#") || /^(tel|mailto|sms|javascript):/i.test(raw)) return;
    let u; try { u = new URL(a.href, location.href); } catch { return; }
    if (u.origin === location.origin && u.pathname === location.pathname && u.search === location.search) return;
    e.preventDefault(); e.stopPropagation();
    asking = true;
    const yes = await confirmBox({ title: "End the call?", body: "Leaving this page hangs up the call.", yes: "End call", danger: true });
    asking = false;
    if (!yes) return;
    onPageHide();
    location.href = a.href;
  };
  window.addEventListener("beforeunload", onBeforeUnload);
  window.addEventListener("pagehide", onPageHide);
  document.addEventListener("click", onNavClick, true);
  return () => { window.removeEventListener("beforeunload", onBeforeUnload); window.removeEventListener("pagehide", onPageHide); document.removeEventListener("click", onNavClick, true); };
}
