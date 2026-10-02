/**
 * The poll worker (spec 3.7, 3.8, FIG.3).
 *
 * Two things are worth testing here and they are both about failure.
 *
 * The first is the dialect difference. Kitaqsign polls `/messages/poll` and
 * acks with `POST /messages/{id}/ack`; Kitaqnic polls `/messages` and acks
 * with `DELETE /messages/{id}`. The stub speaks both, so these tests fail if
 * the BRIDGE layer ever leaks one registry's spelling into the other.
 *
 * The second is the ordering: persist, then ack, then handle. A message must
 * never be acked before it is durable, and a broken handler must never stop
 * the queue — an unacked message blocks every later notification.
 */
import {after, before, beforeEach, describe, it} from "node:test";
import assert from "node:assert/strict";
import {
  HAS_EMULATOR,
  SKIP_REASON,
  requireEmulator,
  useStubRegistries,
} from "../helpers/testEnv";
import {StubRegistry, TRANSFER_MSG_TYPE} from "../helpers/stubRegistry";
import {
  cleanupTestData,
  snapshotCounters,
  type CounterSnapshot,
} from "../helpers/firestoreCleanup";
import {
  clearPollHandlers,
  drainAllQueues,
  drainRegistryQueue,
  pollMessageDocId,
  registerPollHandler,
} from "../../src/domain/pollWorker";
import {resetTldCache} from "../../src/bridge/registryRouter";
import {COLLECTIONS, db} from "../../src/config/firebase";

describe("pollWorker", {skip: HAS_EMULATOR ? false : SKIP_REASON}, () => {
  const sign = new StubRegistry("KQSGN", [".com", ".net"]);
  const nic = new StubRegistry("KQNIC", [".shop"]);
  let counters: CounterSnapshot;

  before(async () => {
    await requireEmulator();
    useStubRegistries(await sign.start(), await nic.start());
    counters = await snapshotCounters();
    // Each stub speaks its own registry's dialect (spec 3.8).
    sign.dialect = "kitaqsign";
    nic.dialect = "kitaqnic";
  });

  after(async () => {
    await clearStoredMessages();
    await cleanupTestData([], counters);
    await sign.stop();
    await nic.stop();
  });

  beforeEach(async () => {
    const signDialect = sign.dialect;
    const nicDialect = nic.dialect;
    sign.reset();
    nic.reset();
    sign.dialect = signDialect;
    nic.dialect = nicDialect;
    clearPollHandlers();
    resetTldCache();
    await clearStoredMessages();
  });

  /**
   * Removes every stored poll message. The collection is only ever written by
   * this worker, and the tests are the only thing running it here.
   *
   * @return {Promise<void>} Resolves once cleared.
   */
  async function clearStoredMessages(): Promise<void> {
    const stored = await db().collection(COLLECTIONS.pollMessages).get();
    await Promise.all(stored.docs.map((doc) => doc.ref.delete()));
  }

  /**
   * Reads a stored poll message.
   *
   * @param {string} registry Registry the message came from.
   * @param {string} id Registry-assigned message id.
   * @return {Promise<FirebaseFirestore.DocumentData | undefined>} The record.
   */
  async function storedMessage(
    registry: "kitaqsign" | "kitaqnic",
    id: string,
  ): Promise<FirebaseFirestore.DocumentData | undefined> {
    const doc = await db()
      .collection(COLLECTIONS.pollMessages)
      .doc(pollMessageDocId(registry, id))
      .get();
    return doc.data();
  }

  describe("an empty queue", () => {
    it("reports nothing to do without acking anything", async () => {
      const result = await drainRegistryQueue("kitaqsign");

      assert.equal(result.polled, 0);
      assert.equal(result.acked, 0);
      assert.equal(result.remaining, 0);
      assert.equal(result.stoppedBecause, "empty");
    });

    it("polls once and stops", async () => {
      await drainRegistryQueue("kitaqsign");
      assert.equal(sign.countCalls("GET", "/messages/poll"), 1);
    });
  });

  describe("draining a queue", () => {
    it("takes every message and empties the queue", async () => {
      sign.enqueueMessage(TRANSFER_MSG_TYPE, {op: "request", domain: "a.com"});
      sign.enqueueMessage(TRANSFER_MSG_TYPE, {op: "approve", domain: "b.com"});
      sign.enqueueMessage(TRANSFER_MSG_TYPE, {op: "reject", domain: "c.com"});

      const result = await drainRegistryQueue("kitaqsign");

      assert.equal(result.polled, 3);
      assert.equal(result.acked, 3);
      assert.equal(result.remaining, 0);
      assert.equal(result.stoppedBecause, "empty");
      assert.equal(sign.queueLength(), 0);
    });

    it("takes the oldest message first (spec 3.7 FIFO)", async () => {
      const first = sign.enqueueMessage("first", {});
      const second = sign.enqueueMessage("second", {});

      await drainRegistryQueue("kitaqsign");

      const a = await storedMessage("kitaqsign", first);
      const b = await storedMessage("kitaqsign", second);
      assert.equal(a?.msgType, "first");
      assert.equal(b?.msgType, "second");
      // The count reported alongside the first message includes itself.
      assert.equal(a?.queueSize, 2);
      assert.equal(b?.queueSize, 1);
    });

    it("stores the payload verbatim", async () => {
      const id = sign.enqueueMessage(TRANSFER_MSG_TYPE, {
        op: "request",
        domain: "wanted.com",
        counterpartyRegistrar: "OTHER-REG",
        nested: {authInfo: "masked"},
      });

      await drainRegistryQueue("kitaqsign");

      const stored = await storedMessage("kitaqsign", id);
      assert.deepEqual(stored?.payload, {
        op: "request",
        domain: "wanted.com",
        counterpartyRegistrar: "OTHER-REG",
        nested: {authInfo: "masked"},
      });
      assert.equal(stored?.qdate, "2026-08-25T10:00:01Z");
    });

    it("records the ack on the stored message", async () => {
      const id = sign.enqueueMessage("transfer.request", {});

      await drainRegistryQueue("kitaqsign");

      const stored = await storedMessage("kitaqsign", id);
      assert.equal(stored?.acked, true);
      assert.ok(stored?.ackedAt);
    });

    it("stops at the per-run cap and says so", async () => {
      for (let i = 0; i < 5; i++) sign.enqueueMessage("noise", {});

      const result = await drainRegistryQueue("kitaqsign", {maxMessages: 2});

      assert.equal(result.polled, 2);
      assert.equal(result.acked, 2);
      assert.equal(result.stoppedBecause, "limit");
      assert.equal(result.remaining, 3, "残りを黙って捨てないこと");
      assert.equal(sign.queueLength(), 3);
    });
  });

  describe("the two dialects (spec 3.8)", () => {
    it("acks Kitaqsign with POST /messages/{id}/ack", async () => {
      const id = sign.enqueueMessage("transfer.request", {});

      await drainRegistryQueue("kitaqsign");

      assert.equal(sign.countCalls("POST", `/messages/${id}/ack`), 1);
      assert.equal(sign.countCalls("DELETE", `/messages/${id}`), 0);
    });

    it("acks Kitaqnic with DELETE /messages/{id}", async () => {
      const id = nic.enqueueMessage("transfer.request", {});

      await drainRegistryQueue("kitaqnic");

      assert.equal(nic.countCalls("DELETE", `/messages/${id}`), 1);
      assert.equal(nic.countCalls("POST", `/messages/${id}/ack`), 0);
    });

    it("polls each registry at its own path", async () => {
      sign.enqueueMessage("x", {});
      nic.enqueueMessage("y", {});

      await drainRegistryQueue("kitaqsign");
      await drainRegistryQueue("kitaqnic");

      assert.ok(sign.countCalls("GET", "/messages/poll") >= 1);
      assert.equal(sign.countCalls("GET", "/messages"), 0);
      assert.ok(nic.countCalls("GET", "/messages") >= 1);
      assert.equal(nic.countCalls("GET", "/messages/poll"), 0);
    });

    it("hands both dialects up as the same shape", async () => {
      const signId = sign.enqueueMessage("transfer.request", {who: "sign"});
      const nicId = nic.enqueueMessage("transfer.request", {who: "nic"});

      await drainRegistryQueue("kitaqsign");
      await drainRegistryQueue("kitaqnic");

      const a = await storedMessage("kitaqsign", signId);
      const b = await storedMessage("kitaqnic", nicId);
      assert.equal(a?.msgType, b?.msgType);
      assert.equal(a?.registry, "kitaqsign");
      assert.equal(b?.registry, "kitaqnic");
      assert.deepEqual(Object.keys(a ?? {}).sort(),
        Object.keys(b ?? {}).sort());
    });

    it("keeps the two queues in separate documents", async () => {
      sign.enqueueMessage("same-id-different-registry", {});
      nic.enqueueMessage("same-id-different-registry", {});

      await drainRegistryQueue("kitaqsign");
      await drainRegistryQueue("kitaqnic");

      // Both registries numbered their first message 1.
      assert.ok(await storedMessage("kitaqsign", "1"));
      assert.ok(await storedMessage("kitaqnic", "1"));
      const stored = await db().collection(COLLECTIONS.pollMessages).get();
      assert.equal(stored.size, 2);
    });
  });

  describe("handlers", () => {
    it("runs the handler registered for the message type", async () => {
      const seen: string[] = [];
      registerPollHandler("transfer.request", async (message) => {
        seen.push(String(message.payload.domain));
      });
      sign.enqueueMessage("transfer.request", {domain: "handled.com"});

      const result = await drainRegistryQueue("kitaqsign");

      assert.deepEqual(seen, ["handled.com"]);
      assert.equal(result.handlerFailures, 0);
    });

    it("marks a type nobody handles rather than dropping it", async () => {
      const id = sign.enqueueMessage("something.new", {});

      const result = await drainRegistryQueue("kitaqsign");

      assert.equal(result.acked, 1);
      assert.equal(result.handlerFailures, 0);
      const stored = await storedMessage("kitaqsign", id);
      assert.equal(stored?.handled, "unhandled");
      assert.equal(stored?.msgType, "something.new");
    });

    it("does not run one type's handler for another type", async () => {
      let called = false;
      registerPollHandler("transfer.approve", async () => {
        called = true;
      });
      sign.enqueueMessage("transfer.reject", {});

      await drainRegistryQueue("kitaqsign");

      assert.equal(called, false);
    });

    it("keeps the queue moving when a handler throws", async () => {
      let ranAfterTheFailures = false;
      registerPollHandler("boom", async () => {
        throw new Error("handler exploded");
      });
      registerPollHandler("fine", async () => {
        ranAfterTheFailures = true;
      });
      sign.enqueueMessage("boom", {});
      sign.enqueueMessage("boom", {});
      const survivor = sign.enqueueMessage("fine", {});

      const result = await drainRegistryQueue("kitaqsign");

      assert.equal(result.acked, 3, "ハンドラの失敗でキューを止めないこと");
      assert.equal(result.handlerFailures, 2);
      assert.equal(sign.queueLength(), 0);
      assert.equal(ranAfterTheFailures, true,
        "先行メッセージの失敗が後続の処理を止めないこと");
      assert.equal((await storedMessage("kitaqsign", survivor))?.handled,
        "done");
    });

    it("records why a handler failed, so it can be retried", async () => {
      registerPollHandler("boom", async () => {
        throw new Error("handler exploded");
      });
      const id = sign.enqueueMessage("boom", {});

      await drainRegistryQueue("kitaqsign");

      const stored = await storedMessage("kitaqsign", id);
      assert.equal(stored?.handled, "failed");
      assert.match(String(stored?.handlerError), /handler exploded/);
      assert.equal(stored?.acked, true,
        "業務処理の失敗と ack を混ぜないこと（仕様書 §3.7）");
    });
  });

  describe("a blocked queue (spec 3.7 の落とし穴)", () => {
    it("stores the message before acking it", async () => {
      const id = sign.enqueueMessage("transfer.request", {});
      sign.ackFails = true;

      const result = await drainRegistryQueue("kitaqsign");

      assert.equal(result.stoppedBecause, "error");
      assert.equal(result.acked, 0);
      const stored = await storedMessage("kitaqsign", id);
      assert.ok(stored, "ack に失敗しても内容は残っていること");
      assert.equal(stored?.acked, false);
    });

    it("leaves an unackable message in the queue for the next run",
      async () => {
        sign.enqueueMessage("transfer.request", {});
        sign.ackFails = true;
        await drainRegistryQueue("kitaqsign");
        assert.equal(sign.queueLength(), 1);

        sign.ackFails = false;
        const retry = await drainRegistryQueue("kitaqsign");

        assert.equal(retry.acked, 1);
        assert.equal(sign.queueLength(), 0);
      });

    it("does not duplicate a message that was redelivered", async () => {
      const id = sign.enqueueMessage("transfer.request", {});
      sign.ackFails = true;
      await drainRegistryQueue("kitaqsign");

      sign.ackFails = false;
      await drainRegistryQueue("kitaqsign");

      const stored = await db().collection(COLLECTIONS.pollMessages).get();
      assert.equal(stored.size, 1);
      assert.equal((await storedMessage("kitaqsign", id))?.acked, true);
    });

    it("gives up rather than spinning on a queue that will not advance",
      async () => {
        sign.enqueueMessage("stuck", {});
        sign.enqueueMessage("behind-it", {});
        // Ack answers 200 but removes nothing, so poll keeps returning the
        // same head. Without the guard this would loop to the run's cap.
        sign.ackSilentlyDoesNothing = true;

        const result = await drainRegistryQueue("kitaqsign",
          {maxMessages: 50});

        assert.equal(result.stoppedBecause, "stuck");
        assert.ok(result.polled <= 2, `polled=${result.polled}`);
      });

    it("reports a poll failure without acking anything", async () => {
      sign.enqueueMessage("transfer.request", {});
      sign.pollFails = true;

      const result = await drainRegistryQueue("kitaqsign");

      assert.equal(result.stoppedBecause, "error");
      assert.equal(result.polled, 0);
      assert.equal(result.acked, 0);
      assert.equal(sign.queueLength(), 1);
    });
  });

  describe("draining both registries", () => {
    it("returns one result per registry", async () => {
      sign.enqueueMessage("a", {});
      nic.enqueueMessage("b", {});

      const results = await drainAllQueues();

      assert.equal(results.length, 2);
      assert.deepEqual(results.map((r) => r.registry).sort(),
        ["kitaqnic", "kitaqsign"]);
      assert.ok(results.every((r) => r.acked === 1));
    });

    it("keeps draining one registry when the other is down", async () => {
      sign.pollFails = true;
      nic.enqueueMessage("still-works", {});

      const results = await drainAllQueues();

      const signResult = results.find((r) => r.registry === "kitaqsign");
      const nicResult = results.find((r) => r.registry === "kitaqnic");
      assert.equal(signResult?.stoppedBecause, "error");
      assert.equal(nicResult?.acked, 1,
        "片方の障害でもう片方の通知を止めないこと");
    });
  });
});
