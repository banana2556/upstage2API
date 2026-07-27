const MODEL = "solar-pro3";
const UPSTREAM =
  "https://ap-northeast-2.apistage.ai/v1/web/demo/chat/completions";
const CSRF_ACTION_URL = "https://console.upstage.ai/playground/chat";
const CSRF_ACTION_ID = "3931343b1f9fe526d1cb0cfbe42efc9383d3db34";
let sessionId;
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: { ...CORS, "cache-control": "no-store" },
  });
}

function error(message, status, code) {
  return json({ error: { message, type: code, code } }, status);
}

async function getCsrfToken(actionId) {
  const response = await fetch(CSRF_ACTION_URL, {
    method: "POST",
    headers: {
      accept: "text/x-component",
      "content-type": "text/plain;charset=UTF-8",
      "next-action": actionId,
      origin: "https://console.upstage.ai",
      referer: CSRF_ACTION_URL,
    },
    body: "[]",
  });
  const text = await response.text();
  const token = text.match(/"token":"([^"]+)"/)?.[1];
  if (!response.ok || !token) throw new Error("Unable to obtain Upstage CSRF token");
  return token;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return json({ status: "ok", model: MODEL });
    }

    if (!env.API_KEY) {
      return error("Worker secret API_KEY is not configured", 500, "server_error");
    }

    if (request.headers.get("authorization") !== `Bearer ${env.API_KEY}`) {
      return error("Invalid API key", 401, "invalid_api_key");
    }

    if (request.method === "GET" && url.pathname === "/v1/models") {
      return json({
        object: "list",
        data: [{ id: MODEL, object: "model", created: 0, owned_by: "upstage" }],
      });
    }

    if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
      return error("Not found", 404, "not_found");
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return error("Request body must be valid JSON", 400, "invalid_request_error");
    }

    if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
      return error("messages must be a non-empty array", 400, "invalid_request_error");
    }

    const includeThink = body.include_think !== false && url.searchParams.get("include_think") !== "false";
    delete body.include_think;
    body.model = MODEL;
    body.stream ??= false;
    body.log_enabled ??= true;
    body.reasoning_effort ??= "medium";
    if (typeof body.conversation_id !== "string" || !body.conversation_id) {
      body.conversation_id = crypto.randomUUID();
    }

    let upstream;
    try {
      const csrfToken = await getCsrfToken(env.UPSTAGE_CSRF_ACTION_ID || CSRF_ACTION_ID);
      upstream = await fetch(`${UPSTREAM}?include_think=${includeThink}`, {
        method: "POST",
        headers: {
          accept: body.stream ? "text/event-stream" : "application/json",
          "content-type": "application/json",
          origin: "https://console.upstage.ai",
          referer: "https://console.upstage.ai/",
          "user-agent": "Mozilla/5.0",
          "x-csrf-token": csrfToken,
          "x-session-id": sessionId ??= crypto.randomUUID(),
          "x-upstage-logging-enabled": String(body.log_enabled),
        },
        body: JSON.stringify(body),
      });
    } catch {
      return error("Upstage upstream is unavailable", 502, "upstream_error");
    }

    const response = new Response(upstream.body, upstream);
    for (const [name, value] of Object.entries(CORS)) response.headers.set(name, value);
    response.headers.set("cache-control", "no-store");
    response.headers.delete("set-cookie");
    return response;
  },
};
