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
  globalThis.fetch = async (url, init) => {
    fetchCalls++;
    if (url === "https://console.upstage.ai/playground/chat" && !init) {
      return new Response('<script src="/_next/static/chunks/1234-abcd.js"></script>');
    }
    if (url === "https://console.upstage.ai/_next/static/chunks/1234-abcd.js") {
      return new Response('let x={one:{apiName:"model-a",shortDescription:"A"},hidden:{apiName:"hidden",shortDescription:"H",privateRoles:["x"]},two:{apiName:"model-b",shortDescription:"B",isDefault:!0},doc:{apiName:"doc",shortDescription:"D",isDocev:!0}}');
    }
    if (url === "https://console.upstage.ai/playground/chat") {
      assert.equal(init.headers["next-action"], "3931343b1f9fe526d1cb0cfbe42efc9383d3db34");
      return new Response('1:{"token":"fresh-csrf"}\n', {
        headers: { "content-type": "text/x-component" },
      });
    }
    const body = JSON.parse(init.body);
    assert.match(url, /include_think=false$/);
    assert.equal(init.headers["x-csrf-token"], "fresh-csrf");
    assert.match(init.headers["x-session-id"], /^[0-9a-f-]{36}$/);
    assert.equal(body.model, "model-b");
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
    assert.equal(fetchCalls, 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
