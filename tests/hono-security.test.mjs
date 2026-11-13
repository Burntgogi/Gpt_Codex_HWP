import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { request } from "node:http";
import { createRequire } from "node:module";
import { connect } from "node:net";
import test from "node:test";

const requireSource = createRequire(new URL("../packages/gpt-codex-hwp/package.json", import.meta.url));
const { createAdaptorServer } = requireSource("@hono/node-server");

test("Hono rejects raw backslashes before application dispatch and preserves valid paths", { timeout: 10_000 }, async (t) => {
  const dispatched = [];
  const server = createAdaptorServer({
    overrideGlobalObjects: false,
    fetch: (incoming) => {
      dispatched.push(incoming.url);
      return new Response("ok");
    },
  });
  const port = await listen(t, server);

  for (const path of ["/admin\\secret", "/public\\..\\admin/secret"]) {
    assert.equal(await statusFor(port, path), 400, path);
  }
  assert.deepEqual(dispatched, [], "ambiguous paths must not reach application routing");

  for (const path of ["/public", "/public%5Cfile", "/public?value=\\"]) {
    assert.equal(await statusFor(port, path), 200, path);
    assert.equal(new URL(dispatched.at(-1)).pathname + new URL(dispatched.at(-1)).search, path);
  }
  assert.equal(dispatched.length, 3);
});

test("Hono handles socket reset while an asynchronous WebSocket request is pending", { timeout: 10_000 }, async (t) => {
  const pending = Promise.withResolvers();
  const observed = Promise.withResolvers();
  let dispatched = false;
  const websocket = Object.assign(new EventEmitter(), {
    options: { noServer: true },
    close() {},
    handleUpgrade() { assert.fail("a reset request must not complete the handshake"); },
  });
  const server = createAdaptorServer({
    overrideGlobalObjects: false,
    websocket: { server: websocket },
    fetch: () => {
      dispatched = true;
      return pending.promise;
    },
  });
  server.on("upgrade", (_request, socket) => {
    let unhandled = null;
    try {
      // Deliver ECONNRESET on the real server socket while application work is
      // deliberately pending. This avoids relying on TCP reset timing.
      socket.emit("error", Object.assign(new Error("simulated reset"), { code: "ECONNRESET" }));
    } catch (error) {
      unhandled = error.code;
    } finally {
      socket.destroy();
      pending.resolve(new Response(null, { status: 403 }));
      observed.resolve({ dispatched, unhandled });
    }
  });
  const port = await listen(t, server);
  const client = connect({ host: "127.0.0.1", port });
  t.after(() => client.destroy());
  client.on("error", () => {});
  await once(client, "connect");
  client.write("GET /ws HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");

  assert.deepEqual(await observed.promise, { dispatched: true, unhandled: null });
  assert.equal(await statusFor(port, "/health"), 403, "the server must still accept requests");
});

async function listen(t, server) {
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function statusFor(port, path) {
  return new Promise((resolve, reject) => {
    const outgoing = request({ host: "127.0.0.1", port, path, agent: false }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
      response.once("error", reject);
    });
    outgoing.once("error", reject);
    outgoing.setTimeout(5_000, () => outgoing.destroy(new Error("request timed out")));
    outgoing.end();
  });
}
