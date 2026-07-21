import { requireSession } from "./auth.js";

const session = await requireSession();
if (!session) throw new Error("redirecting to login");

// Dials is intentionally blank for now — more to come.
