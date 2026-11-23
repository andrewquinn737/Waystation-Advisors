// Resuming something the system paused because of bounces asks first and says how bad it was (round 5).
import { confirmBox } from "./copyCommon.js";

// reason looks like "Auto-paused: bounce rate 7.2% (9 of 125 sends bounced)"; shown as written, without the prefix.
export function confirmResume(title, reason) {
  const why = String(reason || "bounce rate").replace(/^Auto-paused:\s*/i, "");
  return confirmBox({
    title,
    body: `It was paused automatically: ${why}. A high bounce rate hurts the sending domain's reputation, so resuming without cleaning the list can make it worse. Resume anyway?`,
    yes: "Resume anyway",
    danger: true,
  });
}
