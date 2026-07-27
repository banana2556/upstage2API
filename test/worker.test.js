import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.js";

const env = {
  API_KEY: "worker-key",
};

const request = (path, init = {}) =>
  new Request(`https://worker.test${path}`, {
    ...init,
    headers: { authorization: "Bearer worker-key", ...init.headers },
  });

test("routes, validation, and streaming proxy", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  let metadataLoads = 0;
  const staleAction = "a".repeat(40);
  const freshAction = "b".repeat(40);
  globalThis.fetch = async (url, init) => {
    fetchCalls++;
    if (url === "https://console.upstage.ai/playground/chat" && !init) {
      return new Response('<script src="/_next/static/chunks/1234-abcd.js"></script>');
    }
    if (url === "https://console.upstage.ai/_next/static/chunks/1234-abcd.js") {
      metadataLoads++;
      const action = metadataLoads === 1 ? staleAction : freshAction;
      return new Response(`let x={one:{apiName:"model-a",shortDescription:"A"},hidden:{apiName:"hidden",shortDescription:"H",privateRoles:["x"]},two:{apiName:"model-b",shortDescription:"B",isDefault:!0,isReasoning:!0},doc:{apiName:"doc",shortDescription:"D",isDocev:!0}},d={two:{reasoningEffort:"high",reasoningEffortOptions:["low","high"],temperature:.8}};aQ:function(){return o};var r=x,o=(0,r.$)("${action}")`);
    }
    if (url === "https://console.upstage.ai/playground/chat") {
      if (init.headers["next-action"] === staleAction) return new Response("<html></html>");
      assert.equal(init.headers["next-action"], freshAction);
      return new Response('1:{"token":"fresh-csrf"}\n', {
        headers: { "content-type": "text/x-component" },
      });
    }
    const body = JSON.parse(init.body);
    assert.match(url, /include_think=false$/);
    assert.equal(init.headers["x-csrf-token"], "fresh-csrf");
    assert.match(init.headers["x-session-id"], /^[0-9a-f-]{36}$/);
    if (body.model === "model-b") {
      assert.equal(body.temperature, 0.8);
      assert.equal(body.reasoning_effort, "high");
    } else {
      assert.equal(body.model, "model-a");
      assert.equal(body.temperature, 0.7);
      assert.equal("reasoning_effort" in body, false);
    }
    assert.match(body.conversation_id, /^[0-9a-f-]{36}$/);
    return new Response("data: [DONE]\n\n", {
      headers: { "content-type": "text/event-stream", "set-cookie": "secret=1" },
    });
  };

  try {
    assert.equal((await worker.fetch(request("/health"), {})).status, 200);
    assert.equal((await worker.fetch(new Request("https://worker.test/v1/models"), env)).status, 401);

    const models = await worker.fetch(request("/v1/models"), env);
    assert.deepEqual((await models.json()).data.map(({ id }) => id), ["model-a", "model-b"]);

    const invalid = await worker.fetch(
      request("/v1/chat/completions", { method: "POST", body: "{}" }),
      env,
    );
    assert.equal(invalid.status, 400);

    const invalidTemperature = await worker.fetch(
      request("/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "model-b", messages: [{ role: "user", content: "Hi" }], temperature: 2 }),
      }),
      env,
    );
    assert.equal(invalidTemperature.status, 400);

    const invalidReasoning = await worker.fetch(
      request("/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "model-b", messages: [{ role: "user", content: "Hi" }], reasoning_effort: "medium" }),
      }),
      env,
    );
    assert.equal(invalidReasoning.status, 400);

    const response = await worker.fetch(
      request("/v1/chat/completions?include_think=false", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "model-b", messages: [{ role: "user", content: "Hi" }], stream: true }),
      }),
      env,
    );
    assert.equal(await response.text(), "data: [DONE]\n\n");
    assert.equal(response.headers.get("set-cookie"), null);

    const nonReasoning = await worker.fetch(
      request("/v1/chat/completions?include_think=false", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "model-a", messages: [{ role: "user", content: "Hi" }], stream: true, reasoning_effort: "high" }),
      }),
      env,
    );
    assert.equal(await nonReasoning.text(), "data: [DONE]\n\n");
    assert.equal(metadataLoads, 2);
    assert.equal(fetchCalls, 9);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
