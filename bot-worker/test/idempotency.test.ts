import test from "node:test";
import assert from "node:assert/strict";
import { DeliveryIdempotencyStore } from "../src/idempotency.js";

test("DeliveryIdempotencyStore stores and expires keys", async () => {
  const store = new DeliveryIdempotencyStore(25);
  store.add("k1");
  assert.equal(store.has("k1"), true);

  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(store.has("k1"), false);
});
