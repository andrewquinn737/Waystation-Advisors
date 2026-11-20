import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      };

      function jsonResponse(body: unknown, status = 200) {
        return new Response(JSON.stringify(body), {
            status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
              });
              }

              Deno.serve(async (req: Request) => {
                if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
                  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

                    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
                      const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
                        if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
                            return jsonResponse({ error: "Server isn't configured yet (missing Supabase service credentials)." }, 500);
                              }

                                const authHeader = req.headers.get("Authorization") || "";
                                  const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
                                    if (!jwt) return jsonResponse({ error: "Missing authorization." }, 401);

                                      const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

                                        const { data: callerData, error: callerErr } = await admin.auth.getUser(jwt);
                                          if (callerErr || !callerData?.user) {
                                              return jsonResponse({ error: "Your session isn't valid - please sign in again." }, 401);
                                                }
                                                  const callerId = callerData.user.id;

                                                    const { data: callerProfile, error: callerProfileErr } = await admin
                                                        .from("profiles").select("role").eq("id", callerId).single();
                                                          if (callerProfileErr || callerProfile?.role !== "admin") {
                                                              return jsonResponse({ error: "Only admins can remove accounts." }, 403);
                                                                }

                                                                  let body: { user_id?: string };
                                                                    try { body = await req.json(); } catch { return jsonResponse({ error: "Invalid request body." }, 400); }
                                                                      const targetId = body.user_id;
                                                                        if (!targetId) return jsonResponse({ error: "Missing user_id." }, 400);
                                                                          if (targetId === callerId) return jsonResponse({ error: "You can't remove your own account from here." }, 400);

                                                                            const reassignments: Array<Promise<{ error: { message: string } | null }>> = [
                                                                                admin.from("clients").update({ created_by: callerId }).eq("created_by", targetId),
                                                                                    admin.from("clients").update({ assigned_to: callerId }).eq("assigned_to", targetId),
                                                                                        admin.from("client_events").update({ created_by: callerId }).eq("created_by", targetId),
                                                                                            admin.from("dial_lists").update({ created_by: callerId }).eq("created_by", targetId),
                                                                                                admin.from("dials").update({ created_by: callerId }).eq("created_by", targetId),
                                                                                                  ];
                                                                                                    for (const p of reassignments) {
                                                                                                        const { error } = await p;
                                                                                                            if (error) return jsonResponse({ error: `Couldn't reassign their records first: ${error.message}` }, 500);
                                                                                                              }

                                                                                                                const { error: deleteErr } = await admin.auth.admin.deleteUser(targetId);
                                                                                                                  if (deleteErr) return jsonResponse({ error: deleteErr.message }, 500);

                                                                                                                    return jsonResponse({ ok: true });
                                                                                                                    });
                                                                                                                    