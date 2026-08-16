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
