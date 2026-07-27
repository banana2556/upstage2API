const UPSTREAM =
  "https://ap-northeast-2.apistage.ai/v1/web/demo/chat/completions";
const CSRF_ACTION_URL = "https://console.upstage.ai/playground/chat";
let sessionId;
let metadataPromise;
let metadataExpiresAt = 0;
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

async function getPlaygroundMetadata(refresh = false) {
  if (refresh) metadataPromise = undefined;
  if (!metadataPromise || Date.now() >= metadataExpiresAt) {
    metadataExpiresAt = Date.now() + 300_000;
    metadataPromise = (async () => {
      const page = await fetch(CSRF_ACTION_URL);
      if (!page.ok) throw new Error("Unable to load Upstage Playground");
      const html = await page.text();
      const scripts = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/g)]
        .map((match) => new URL(match[1], CSRF_ACTION_URL).href)
        .filter((url) => /^\d+-[a-f0-9]+\.js$/.test(url.split("/").at(-1)));
      const chunks = await Promise.all(scripts.map(async (url) => {
        const response = await fetch(url);
        return response.ok ? response.text() : "";
      }));
      const modelChunk = chunks.find((text) => text.includes("apiName:") && text.includes("isDefault:!0")) || "";
      const records = [...modelChunk.matchAll(/(?:^|[,{])(?:"([^"]+)"|([\w-]+)):\{([^{}]*?apiName:"([^"]+)"[^{}]*?)\}(?=,|})/g)];
      const configs = new Map([...modelChunk.matchAll(/(?:^|[,{])(?:"([^"]+)"|([\w-]+)):\{([^{}]*(?:reasoningEffort|temperature):[^{}]*)\}(?=,|})/g)]
        .map(([, quotedName, name, config]) => [quotedName || name, config]));
      const models = [...new Map(records
        .filter(([, , , record]) => record.includes("shortDescription:")
          && !record.includes("privateRoles:")
          && !record.includes("isDocev:")
          && !record.includes("demoUrl:"))
        .map(([, quotedName, name, record, apiName]) => {
          const config = configs.get(quotedName || name) || "";
          const options = config.match(/reasoningEffortOptions:\[([^\]]*)\]/)?.[1] || "";
          const reasoningEfforts = [...options.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
          const temperature = config.match(/temperature:(\.?\d+(?:\.\d+)?)/)?.[1];
          return [apiName, {
            id: apiName,
            isReasoning: record.includes("isReasoning:!0"),
            reasoningEffort: config.match(/reasoningEffort:"([^"]+)"/)?.[1] || "low",
            reasoningEfforts: reasoningEfforts.length ? reasoningEfforts : ["low", "high"],
            temperature: temperature === undefined ? 0.7 : Number(temperature),
          }];
        })).values()];
      // ponytail: parse the live bundle; UPSTAGE_CSRF_ACTION_ID is the fallback if its shape changes.
      const actionChunk = chunks.find((text) => text.includes("aQ:function(){return ")) || "";
      const actionStart = actionChunk.indexOf("aQ:function(){return ");
      const actionSnippet = actionChunk.slice(actionStart, actionStart + 1500);
      const actionVariable = actionSnippet.match(/aQ:function\(\)\{return ([\w$]+)\}/)?.[1];
      const declarationStart = actionVariable
        ? [`var ${actionVariable}=`, `,${actionVariable}=`]
          .map((marker) => actionSnippet.indexOf(marker))
          .find((index) => index >= 0)
        : -1;
      const csrfActionId = declarationStart >= 0
        ? actionSnippet.slice(declarationStart, declarationStart + 200).match(/"([a-f0-9]{40})"/)?.[1]
        : undefined;
      return { models, csrfActionId };
    })();
  }
  try {
    return await metadataPromise;
  } catch (error) {
    metadataPromise = undefined;
    metadataExpiresAt = 0;
    throw error;
  }
}

async function getCsrfActionId(env, refresh = false) {
  const actionId = (await getPlaygroundMetadata(refresh)).csrfActionId
    || env.UPSTAGE_CSRF_ACTION_ID;
  if (!actionId) throw new Error("Unable to find Upstage CSRF action");
  return actionId;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return json({ status: "ok" });
    }

    if (!env.API_KEY) {
      return error("Worker secret API_KEY is not configured", 500, "server_error");
    }

    if (request.headers.get("authorization") !== `Bearer ${env.API_KEY}`) {
      return error("Invalid API key", 401, "invalid_api_key");
    }

    if (request.method === "GET" && url.pathname === "/v1/models") {
      try {
        const { models } = await getPlaygroundMetadata();
        if (!models.length) throw new Error("No Upstage models found");
        return json({
          object: "list",
          data: models.map(({ id }) => ({ id, object: "model", created: 0, owned_by: "upstage" })),
        });
      } catch {
        return error("Unable to load Upstage models", 502, "upstream_error");
      }
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
    if (typeof body.model !== "string" || !body.model.trim()) {
      return error("model must be a non-empty string", 400, "invalid_request_error");
    }
    body.model = body.model.trim();

    let model;
    try {
      model = (await getPlaygroundMetadata()).models.find(({ id }) => id === body.model);
    } catch {
      return error("Unable to load Upstage models", 502, "upstream_error");
    }
    if (!model) return error("The requested model is not available", 400, "invalid_model");

    body.temperature ??= model.temperature;
    if (typeof body.temperature !== "number"
      || !Number.isFinite(body.temperature)
      || body.temperature < 0
      || body.temperature > 1) {
      return error("temperature must be a number between 0 and 1", 400, "invalid_request_error");
    }
    if (model.isReasoning) {
      body.reasoning_effort ??= model.reasoningEffort;
      if (!model.reasoningEfforts.includes(body.reasoning_effort)) {
        return error(`reasoning_effort must be one of: ${model.reasoningEfforts.join(", ")}`, 400, "invalid_request_error");
      }
    } else {
      delete body.reasoning_effort;
    }

    const includeThink = model.isReasoning
      && body.include_think !== false
      && url.searchParams.get("include_think") !== "false";
    delete body.include_think;
    body.stream ??= false;
    body.log_enabled ??= true;
    if (typeof body.conversation_id !== "string" || !body.conversation_id) {
      body.conversation_id = crypto.randomUUID();
    }

    let csrfToken;
    try {
      try {
        csrfToken = await getCsrfToken(await getCsrfActionId(env));
      } catch {
        csrfToken = await getCsrfToken(await getCsrfActionId(env, true));
      }
    } catch {
      return error("Unable to initialize Upstage session", 502, "upstream_error");
    }

    let upstream;
    try {
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
