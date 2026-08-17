import test from "node:test";
import assert from "node:assert/strict";
import handler from "../api/lookup.js";

function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; }
  };
}

test("lookup rejects a null request body with a controlled response", async () => {
  const res = responseRecorder();
  await handler({ method: "POST", headers: { host: "localhost:3000" }, body: null }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /b_no/);
});

test("lookup rejects malformed numbers before calling the upstream API", async () => {
  const res = responseRecorder();
  await handler({ method: "POST", headers: { host: "localhost:3000" }, body: { b_no: [123] } }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /10자리 숫자 문자열/);
});

test("lookup does not grant CORS to a foreign origin", async () => {
  const res = responseRecorder();
  await handler({ method: "OPTIONS", headers: { host: "donggu-biz.vercel.app", origin: "https://example.com" } }, res);
  assert.equal(res.headers["Access-Control-Allow-Origin"], undefined);
});

test("lookup retries transient upstream failures", async () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.NTS_API_KEY;
  let attempts = 0;
  global.fetch = async (url) => {
    attempts += 1;
    assert.match(String(url), /returnType=JSON/);
    if (attempts < 3) return new Response('{"code":-5}', { status: 503 });
    return Response.json({ status_code: "OK", data: [{ b_no: "1208800767", b_stt_cd: "01" }] });
  };
  process.env.NTS_API_KEY = "test-key";

  try {
    const res = responseRecorder();
    await handler({ method: "POST", headers: { host: "localhost:3000" }, body: { b_no: ["1208800767"] } }, res);
    assert.equal(attempts, 3);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data[0].b_stt_cd, "01");
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.NTS_API_KEY;
    else process.env.NTS_API_KEY = originalKey;
  }
});

test("lookup reports a retryable error after repeated upstream failures", async () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.NTS_API_KEY;
  let attempts = 0;
  global.fetch = async () => {
    attempts += 1;
    return new Response('{"code":-5}', { status: 503 });
  };
  process.env.NTS_API_KEY = "test-key";

  try {
    const res = responseRecorder();
    await handler({ method: "POST", headers: { host: "localhost:3000" }, body: { b_no: ["1208800767"] } }, res);
    assert.equal(attempts, 4);
    assert.equal(res.statusCode, 503);
    assert.equal(res.headers["Retry-After"], "5");
    assert.match(res.body.error, /일시적으로 불안정/);
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.NTS_API_KEY;
    else process.env.NTS_API_KEY = originalKey;
  }
});
