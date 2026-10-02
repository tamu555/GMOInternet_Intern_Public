/**
 * Domain transfer, both directions (spec 6.6, FIG.3 下帯).
 *
 *   移管IN  — we are the gaining registrar: request -> (their answer) -> ours
 *   移管OUT — we are the losing registrar: their request -> approve / reject
 *
 * Everything the stub does here follows the two OpenAPI documents: `request`
 * answers 202 with a *pending* transfer, a wrong passphrase answers 401 +
 * 2202, and only the registrar on the right side of a transfer may approve,
 * reject or cancel it (403 otherwise). The stub plays レジストラB — the other
 * registrar spec test 6 drives by hand — through `transferAs`.
 *
 * The three things worth proving are all about not losing a domain:
 *
 *   1. a wrong AuthCode is reported as a wrong AuthCode, not as a server fault
 *      (spec 6.7 maps 2202 to its own wording, and it is the mistake members
 *      actually make);
 *   2. a re-submitted transfer form never raises a second live request;
 *   3. only the owner can answer a transfer request for their domain, and the
 *      ownership check runs before any registry command goes out (spec 7.3).
 */
import {after, before, beforeEach, describe, it} from "node:test";
import assert from "node:assert/strict";
import {
  HAS_EMULATOR,
  SKIP_REASON,
  TEST_REGISTRAR_ID,
  activeMemberUid,
  callAs,
  expectHttpsError,
  requireEmulator,
  testIdempotencyKey,
  testUid,
  useStubRegistries,
} from "../helpers/testEnv";
import {StubRegistry, TRANSFER_MSG_TYPE} from "../helpers/stubRegistry";
import {
  cleanupTestData,
  snapshotCounters,
  type CounterSnapshot,
} from "../helpers/firestoreCleanup";
import {createOrder} from "../../src/api/createOrder";
import {deleteDomain as deleteDomainCallable} from
  "../../src/api/deleteDomain";
import {
  cancelTransfer,
  listTransfers,
  requestTransfer,
  respondTransfer,
} from "../../src/api/transferCallables";
import {resetTldCache} from "../../src/bridge/registryRouter";
import {COLLECTIONS, db} from "../../src/config/firebase";
import {
  clearPollHandlers,
  drainRegistryQueue,
} from "../../src/domain/pollWorker";
import {reconcilePendingTransfers} from
  "../../src/domain/transferReconciler";
import {
  getOwnedDomain,
  listOwnedDomains,
} from "../../src/domain/domainRepository";
import {assertOwnsDomain, OwnershipError} from "../../src/domain/ownership";
import {registerTransferPollHandlers} from
  "../../src/domain/transferNotifications";

/** X-Registrar-Id of the other registrar in these tests (レジストラB). */
const OTHER_REGISTRAR = "KITAQ-OTHER-002";

/** Passphrase the other registrar's domains carry in the stub. */
const THEIR_AUTH_INFO = "their-auth-code";

/** Shape every transfer Callable answers with. */
interface TransferResponse {
  domainName: string;
  registry: string;
  direction: "in" | "out";
  state: "pending" | "completed" | "rejected" | "cancelled" | "failed";
  gainingRegistrar: string | null;
  losingRegistrar: string | null;
  requestedAt: string | null;
  autoApproveAt: string | null;
  recovered: boolean;
  message: string;
}

describe("domain transfer", {skip: HAS_EMULATOR ? false : SKIP_REASON}, () => {
  const sign = new StubRegistry("KQSGN", [".com", ".net"]);
  const nic = new StubRegistry("KQNIC", [".shop"]);
  let counters: CounterSnapshot;
  const uids: string[] = [];

  before(async () => {
    await requireEmulator();
    useStubRegistries(await sign.start(), await nic.start());
    counters = await snapshotCounters();
  });

  after(async () => {
    await clearStoredMessages();
    await cleanupTestData(uids, counters);
    await sign.stop();
    await nic.stop();
  });

  beforeEach(async () => {
    sign.reset();
    nic.reset();
    resetTldCache();
    clearPollHandlers();
    registerTransferPollHandlers();
    await clearStoredMessages();
  });

  /**
   * Empties the poll-message mirror, which only the worker ever writes.
   *
   * @return {Promise<void>} Resolves once cleared.
   */
  async function clearStoredMessages(): Promise<void> {
    const stored = await db().collection(COLLECTIONS.pollMessages).get();
    await Promise.all(stored.docs.map((doc) => doc.ref.delete()));
  }

  /**
   * Allocates an active-member uid that will be cleaned up afterwards.
   *
   * @return {Promise<string>} Test uid backed by an active user document.
   */
  async function freshUid(): Promise<string> {
    const uid = await activeMemberUid();
    uids.push(uid);
    return uid;
  }

  /**
   * Reads the stored transfer record for one member's domain.
   *
   * @param {string} uid Owner.
   * @param {string} name Domain name.
   * @return {Promise<FirebaseFirestore.DocumentData | undefined>} The record.
   */
  async function storedTransfer(
    uid: string,
    name: string,
  ): Promise<FirebaseFirestore.DocumentData | undefined> {
    const doc = await db().collection(COLLECTIONS.transfers)
      .doc(`${uid}__${name}`).get();
    return doc.data();
  }

  /**
   * Reads the domain mirror for one member's domain.
   *
   * @param {string} uid Owner.
   * @param {string} name Domain name.
   * @return {Promise<FirebaseFirestore.DocumentData | undefined>} The record.
   */
  async function storedDomain(
    uid: string,
    name: string,
  ): Promise<FirebaseFirestore.DocumentData | undefined> {
    const doc = await db().collection(COLLECTIONS.domains)
      .doc(`${uid}__${name}`).get();
    return doc.data();
  }

  /**
   * Puts a domain in the stub that another registrar sponsors, the way テスト6
   * seeds レジストラB's portfolio.
   *
   * @param {string} name Domain name.
   * @return {void}
   */
  function seedTheirDomain(name: string): void {
    sign.seedDomain(name, "C-OTHER-0001", ["ns1.theirs.example"],
      OTHER_REGISTRAR, THEIR_AUTH_INFO);
  }

  /**
   * Registers a domain through this service, so the member is its owner and
   * we are the sponsoring registrar.
   *
   * @param {string} uid Owner.
   * @param {string} name Domain name.
   * @return {Promise<void>} Resolves once registered.
   */
  async function registerOurDomain(
    uid: string,
    name: string,
  ): Promise<void> {
    await callAs(createOrder, {
      domainName: name,
      idempotencyKey: testIdempotencyKey(),
    }, uid);
  }

  /**
   * Drains whatever the stub registry queued for us, through the real poll
   * worker. The stub queues the documented notification itself, to the
   * documented side only, so a test never has to hand-build one.
   *
   * @return {Promise<void>} Resolves once the queue is drained.
   */
  async function deliverQueuedNotifications(): Promise<void> {
    await drainRegistryQueue("kitaqsign");
  }

  /**
   * Delivers one hand-built notification, for the shapes the registry is not
   * documented to send (a legacy spelling, or a payload we only tolerate).
   *
   * @param {string} msgType Message type the registry used.
   * @param {Record<string, unknown>} payload Message payload.
   * @return {Promise<void>} Resolves once the queue is drained.
   */
  async function deliverNotification(
    msgType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    sign.enqueueMessage(msgType, payload);
    await drainRegistryQueue("kitaqsign");
  }

  describe("移管IN: requesting a domain from another registrar", () => {
    it("surfaces a registry outage as retryable, not as a permission error",
      async () => {
        // A 503 (or the circuit breaker skipping the command) used to reach
        // the wizard as 「移管処理を完了できませんでした。[403]」 — a message
        // that tells the member to give up, when retrying is exactly what
        // works once the registry recovers.
        const uid = await freshUid();
        seedTheirDomain("flaky-registry.com");
        sign.failNextTransfers(1, 503);

        const code = await expectHttpsError(callAs(requestTransfer, {
          domainName: "flaky-registry.com",
          authInfo: THEIR_AUTH_INFO,
        }, uid));

        assert.equal(code, "unavailable",
          "再試行可能なエラーとして返すこと（403にしない）");
      });

    it("sends transfer/request with the AuthCode and records it as pending",
      async () => {
        const uid = await freshUid();
        seedTheirDomain("wanted.com");

        const result = await callAs<TransferResponse>(requestTransfer, {
          domainName: "wanted.com",
          authInfo: THEIR_AUTH_INFO,
        }, uid);

        assert.equal(result.state, "pending");
        assert.equal(result.direction, "in");
        assert.equal(result.gainingRegistrar, TEST_REGISTRAR_ID);
        assert.equal(result.losingRegistrar, OTHER_REGISTRAR);
        assert.equal(result.recovered, false);

        assert.equal(
          sign.countCalls("POST", "/domains/wanted.com/transfer/request"), 1);
        assert.ok(sign.getDomain("wanted.com")?.status
          .includes("pendingTransfer"));

        const stored = await storedTransfer(uid, "wanted.com");
        assert.equal(stored?.state, "pending");
        assert.equal(stored?.direction, "in");
        assert.equal(stored?.holderToken, null, "処理後は claim を離すこと");
      });

    it("computes the 20-minute auto-approve deadline (spec 6.6.1)",
      async () => {
        const uid = await freshUid();
        seedTheirDomain("deadline.com");

        const result = await callAs<TransferResponse>(requestTransfer, {
          domainName: "deadline.com",
          authInfo: THEIR_AUTH_INFO,
        }, uid);

        assert.ok(result.requestedAt);
        assert.ok(result.autoApproveAt);
        const gap = Date.parse(result.autoApproveAt as string) -
          Date.parse(result.requestedAt as string);
        assert.equal(gap, 20 * 60 * 1000);
      });

    it("never puts the AuthCode in the request path or the log", async () => {
      const uid = await freshUid();
      seedTheirDomain("secret.com");
      await callAs(requestTransfer, {
        domainName: "secret.com",
        authInfo: THEIR_AUTH_INFO,
      }, uid);

      const call = sign.calls.find((entry) =>
        entry.path === "/domains/secret.com/transfer/request");
      assert.equal(call?.path.includes(THEIR_AUTH_INFO), false);
      assert.equal((call?.clTRID ?? "").includes(THEIR_AUTH_INFO), false);
      // It belongs in the body and nowhere else.
      assert.equal((call?.body as {authInfo: string}).authInfo,
        THEIR_AUTH_INFO);

      const logs = await db().collection(COLLECTIONS.registryLogs)
        .where("uid", "==", uid).get();
      assert.ok(logs.size > 0, "ログが書かれていること");
      for (const doc of logs.docs) {
        assert.equal(JSON.stringify(doc.data()).includes(THEIR_AUTH_INFO),
          false, "authInfo をログに残さないこと");
      }
    });

    it("reports a wrong AuthCode as a wrong AuthCode (2202, spec 6.7)",
      async () => {
        const uid = await freshUid();
        seedTheirDomain("mistyped.com");

        const code = await expectHttpsError(callAs(requestTransfer, {
          domainName: "mistyped.com",
          authInfo: "definitely-not-it",
        }, uid));

        // Not "internal": the member mistyped a field they can fix.
        assert.equal(code, "invalid-argument");
        assert.equal(sign.getDomain("mistyped.com")?.transfer, null,
          "拒否された申請でレジストリ側の状態を変えないこと");
        const stored = await storedTransfer(uid, "mistyped.com");
        assert.equal(stored?.state, "failed");
      });

    it("lets a failed attempt be retried with the right AuthCode",
      async () => {
        const uid = await freshUid();
        seedTheirDomain("second-try.com");
        await expectHttpsError(callAs(requestTransfer, {
          domainName: "second-try.com",
          authInfo: "wrong",
        }, uid));

        const result = await callAs<TransferResponse>(requestTransfer, {
          domainName: "second-try.com",
          authInfo: THEIR_AUTH_INFO,
        }, uid);

        assert.equal(result.state, "pending");
      });

    it("answers a re-submitted form from the record, without a second " +
      "registry call", async () => {
      const uid = await freshUid();
      seedTheirDomain("double-submit.com");
      const data = {
        domainName: "double-submit.com",
        authInfo: THEIR_AUTH_INFO,
      };

      const first = await callAs<TransferResponse>(requestTransfer, data, uid);
      const second = await callAs<TransferResponse>(requestTransfer, data, uid);

      assert.equal(first.state, "pending");
      assert.equal(second.state, "pending");
      assert.equal(
        sign.countCalls("POST", "/domains/double-submit.com/transfer/request"),
        1,
        "二重送信で移管申請を2件出さないこと");
    });

    it("refuses a domain the member already holds here", async () => {
      const uid = await freshUid();
      await registerOurDomain(uid, "already-mine.com");

      const code = await expectHttpsError(callAs(requestTransfer, {
        domainName: "already-mine.com",
        authInfo: THEIR_AUTH_INFO,
      }, uid));

      assert.equal(code, "failed-precondition");
      assert.equal(
        sign.countCalls("POST",
          "/domains/already-mine.com/transfer/request"), 0,
        "自分のドメインには移管コマンドを出さないこと");
    });

    it("refuses a TLD neither registry serves", async () => {
      const code = await expectHttpsError(callAs(requestTransfer, {
        domainName: "nowhere.invalidtld",
        authInfo: THEIR_AUTH_INFO,
      }, await freshUid()));
      assert.equal(code, "invalid-argument");
    });

    it("refuses an anonymous caller", async () => {
      const code = await expectHttpsError(
        callAs(requestTransfer, {domainName: "anon.com", authInfo: "x"}),
      );
      assert.equal(code, "unauthenticated");
    });

    it("rejects a signed-in caller with no user document", async () => {
      // Regression for requireActiveUser (src/auth/callerGuard.ts): a valid
      // ID token alone must not be enough to reach this Callable.
      seedTheirDomain("no-user-doc.com");
      const code = await expectHttpsError(
        callAs(requestTransfer, {
          domainName: "no-user-doc.com",
          authInfo: THEIR_AUTH_INFO,
        }, testUid()),
      );
      assert.equal(code, "permission-denied");
    });

    it("rejects a missing AuthCode before reaching the registry", async () => {
      const uid = await freshUid();
      seedTheirDomain("no-code.com");

      const code = await expectHttpsError(
        callAs(requestTransfer, {domainName: "no-code.com"}, uid));

      assert.equal(code, "invalid-argument");
      assert.equal(
        sign.countCalls("POST", "/domains/no-code.com/transfer/request"), 0);
    });

    it("uses a clTRID that names the domain and the operation", async () => {
      const uid = await freshUid();
      seedTheirDomain("traced.com");
      await callAs(requestTransfer, {
        domainName: "traced.com",
        authInfo: THEIR_AUTH_INFO,
      }, uid);

      const call = sign.calls.find((entry) =>
        entry.path === "/domains/traced.com/transfer/request");
      assert.match(call?.clTRID ?? "", /^DOM-TRANSFER-TRACED-COM-REQUEST-/);
    });

    it("routes the whole transfer to the registry that serves the TLD, from " +
      "request to cancel", async () => {
      // Regression: a follow-up command must go to the registry the transfer
      // was raised on. Sending `cancel` to the other one would answer 404 and
      // leave a live transfer request running against a domain the member
      // believes they withdrew.
      const uid = await freshUid();
      nic.seedDomain("wanted.shop", "C-OTHER-0001", [], OTHER_REGISTRAR,
        THEIR_AUTH_INFO);

      await callAs(requestTransfer, {
        domainName: "wanted.shop",
        authInfo: THEIR_AUTH_INFO,
      }, uid);
      await callAs(cancelTransfer, {domainName: "wanted.shop"}, uid);

      assert.equal(
        nic.countCalls("POST", "/domains/wanted.shop/transfer/request"), 1);
      assert.equal(
        nic.countCalls("POST", "/domains/wanted.shop/transfer/cancel"), 1);
      assert.equal(sign.calls.filter((call) =>
        call.path.startsWith("/domains/wanted.shop")).length, 0,
      "もう一方のレジストリへ送らないこと");
      assert.equal((await storedTransfer(uid, "wanted.shop"))?.registry,
        "kitaqnic");
    });
  });

  describe("移管IN: cancelling our own request", () => {
    it("withdraws the request and clears pendingTransfer", async () => {
      const uid = await freshUid();
      seedTheirDomain("changed-mind.com");
      await callAs(requestTransfer, {
        domainName: "changed-mind.com",
        authInfo: THEIR_AUTH_INFO,
      }, uid);

      const result = await callAs<TransferResponse>(
        cancelTransfer, {domainName: "changed-mind.com"}, uid);

      assert.equal(result.state, "cancelled");
      assert.equal(sign.getDomain("changed-mind.com")?.transfer, null);
      assert.equal(
        sign.getDomain("changed-mind.com")?.status.includes("pendingTransfer"),
        false);
      assert.equal((await storedTransfer(uid, "changed-mind.com"))?.state,
        "cancelled");
    });

    it("refuses when there is nothing to cancel", async () => {
      const code = await expectHttpsError(callAs(
        cancelTransfer, {domainName: "never-asked.com"}, await freshUid()));
      assert.equal(code, "failed-precondition");
    });

    it("refuses to cancel a transfer that is already settled", async () => {
      const uid = await freshUid();
      seedTheirDomain("settled.com");
      await callAs(requestTransfer, {
        domainName: "settled.com",
        authInfo: THEIR_AUTH_INFO,
      }, uid);
      await callAs(cancelTransfer, {domainName: "settled.com"}, uid);

      const code = await expectHttpsError(
        callAs(cancelTransfer, {domainName: "settled.com"}, uid));
      assert.equal(code, "failed-precondition");
      assert.equal(
        sign.countCalls("POST", "/domains/settled.com/transfer/cancel"), 1,
        "二重取消でコマンドを二度出さないこと");
    });

    it("cannot cancel another member's transfer", async () => {
      const owner = await freshUid();
      const intruder = await freshUid();
      seedTheirDomain("not-your-transfer.com");
      await callAs(requestTransfer, {
        domainName: "not-your-transfer.com",
        authInfo: THEIR_AUTH_INFO,
      }, owner);

      const code = await expectHttpsError(callAs(
        cancelTransfer, {domainName: "not-your-transfer.com"}, intruder));

      assert.equal(code, "failed-precondition");
      assert.ok(sign.getDomain("not-your-transfer.com")?.transfer,
        "他人の移管申請を取り消させないこと");
    });
  });

  describe("移管OUT: answering a request for one of our domains", () => {
    /**
     * Registers a domain, has レジストラB ask for it, and delivers the
     * resulting notification the way the poll worker would.
     *
     * @param {string} uid Owner.
     * @param {string} name Domain name.
     * @return {Promise<void>} Resolves once the record is pending.
     */
    async function incomingRequest(
      uid: string,
      name: string,
    ): Promise<void> {
      await registerOurDomain(uid, name);
      assert.equal(sign.transferAs(name, "request", OTHER_REGISTRAR), 202);
      // `request` is delivered to the losing registrar — us — by the stub,
      // in the documented `{op, domain, counterpartyRegistrar}` shape.
      await deliverQueuedNotifications();
    }

    it("turns a poll notification into a pending outbound transfer",
      async () => {
        const uid = await freshUid();
        await incomingRequest(uid, "leaving.com");

        const stored = await storedTransfer(uid, "leaving.com");
        assert.equal(stored?.state, "pending");
        assert.equal(stored?.direction, "out");
        // counterpartyRegistrar is relative: a `request` reaches the losing
        // side, so the counterparty is the gaining registrar and we are the
        // losing one.
        assert.equal(stored?.gainingRegistrar, OTHER_REGISTRAR);
        assert.equal(stored?.losingRegistrar, TEST_REGISTRAR_ID);
        assert.ok(stored?.autoApproveAt, "自動承認の期限を出すこと");

        const listed = await callAs<{transfers: TransferResponse[]}>(
          listTransfers, {}, uid);
        assert.equal(listed.transfers.length, 1);
        assert.equal(listed.transfers[0].domainName, "leaving.com");
        assert.equal(listed.transfers[0].direction, "out");
      });

    it("shows pendingTransfer on the domain once the notification lands",
      async () => {
        const uid = await freshUid();
        await incomingRequest(uid, "pending-shown.com");

        const domain = await storedDomain(uid, "pending-shown.com");
        assert.ok((domain?.status as string[]).includes("pendingTransfer"));
      });

    it("approving hands the domain over and empties it from the list",
      async () => {
        const uid = await freshUid();
        await incomingRequest(uid, "handed-over.com");

        const result = await callAs<TransferResponse>(respondTransfer, {
          domainName: "handed-over.com",
          action: "approve",
        }, uid);

        assert.equal(result.state, "completed");
        assert.equal(sign.getDomain("handed-over.com")?.sponsor,
          OTHER_REGISTRAR, "レジストリ側のスポンサーが移ること");

        const domain = await storedDomain(uid, "handed-over.com");
        assert.equal(domain?.lifecycle, "gone");
        assert.ok(domain?.transferredAt);
        assert.equal(domain?.autoRenew, false,
          "手放したドメインを自動更新し続けないこと");
      });

    it("rejecting keeps the domain and clears pendingTransfer", async () => {
      const uid = await freshUid();
      await incomingRequest(uid, "staying.com");

      const result = await callAs<TransferResponse>(respondTransfer, {
        domainName: "staying.com",
        action: "reject",
      }, uid);

      assert.equal(result.state, "rejected");
      assert.equal(sign.getDomain("staying.com")?.sponsor, TEST_REGISTRAR_ID);
      const domain = await storedDomain(uid, "staying.com");
      assert.equal(domain?.lifecycle, "active");
      assert.equal((domain?.status as string[]).includes("pendingTransfer"),
        false, "拒否後は一覧から「手続き中」を消すこと");
    });

    it("refuses to answer for another member's domain, before any command " +
      "goes out (spec 7.3)", async () => {
      const owner = await freshUid();
      const intruder = await freshUid();
      await incomingRequest(owner, "not-yours-to-give.com");

      const code = await expectHttpsError(callAs(respondTransfer, {
        domainName: "not-yours-to-give.com",
        action: "approve",
      }, intruder));

      assert.equal(code, "permission-denied");
      assert.equal(sign.countCalls("POST",
        "/domains/not-yours-to-give.com/transfer/approve"), 0,
      "所有権チェックがレジストリより手前で効くこと");
      assert.equal(sign.getDomain("not-yours-to-give.com")?.sponsor,
        TEST_REGISTRAR_ID, "他人の操作でドメインを手放さないこと");
    });

    it("refuses an action other than approve / reject", async () => {
      const uid = await freshUid();
      await incomingRequest(uid, "bad-action.com");

      const code = await expectHttpsError(callAs(respondTransfer, {
        domainName: "bad-action.com",
        action: "cancel",
      }, uid));

      assert.equal(code, "invalid-argument");
      assert.equal(sign.countCalls("POST",
        "/domains/bad-action.com/transfer/cancel"), 0);
    });

    it("refuses a second answer to an already-settled request", async () => {
      const uid = await freshUid();
      await incomingRequest(uid, "answered-once.com");
      await callAs(respondTransfer, {
        domainName: "answered-once.com",
        action: "reject",
      }, uid);

      const code = await expectHttpsError(callAs(respondTransfer, {
        domainName: "answered-once.com",
        action: "approve",
      }, uid));

      assert.equal(code, "failed-precondition");
      assert.equal(sign.countCalls("POST",
        "/domains/answered-once.com/transfer/approve"), 0);
    });

    it("cannot be withdrawn with cancelTransfer: that is the gaining side's " +
      "command", async () => {
      // Regression: `cancel` belongs to the registrar that *asked*. Issuing it
      // as the losing side would be refused by the registry (403) after we had
      // already claimed the record — and, worse, could be read as a way for
      // the losing side to make a request go away.
      const uid = await freshUid();
      await incomingRequest(uid, "wrong-command.com");

      const code = await expectHttpsError(
        callAs(cancelTransfer, {domainName: "wrong-command.com"}, uid));

      assert.equal(code, "failed-precondition");
      assert.equal(sign.countCalls("POST",
        "/domains/wrong-command.com/transfer/cancel"), 0);
      assert.equal((await storedTransfer(uid, "wrong-command.com"))?.state,
        "pending", "申請を勝手に消さないこと");
    });

    it("refuses when no request is outstanding at all", async () => {
      const uid = await freshUid();
      await registerOurDomain(uid, "nobody-asked.com");

      const code = await expectHttpsError(callAs(respondTransfer, {
        domainName: "nobody-asked.com",
        action: "approve",
      }, uid));

      assert.equal(code, "failed-precondition");
    });
  });

  describe("the poll queue settles what we cannot (spec 3.7 / 6.6.1)", () => {
    it("completes an inbound transfer and puts the domain on the list",
      async () => {
        const uid = await freshUid();
        seedTheirDomain("arriving.com");
        await callAs(requestTransfer, {
          domainName: "arriving.com",
          authInfo: THEIR_AUTH_INFO,
        }, uid);

        // レジストラB approves on their side; we only ever hear about it,
        // as an `approve` addressed to the gaining registrar (us).
        assert.equal(sign.transferAs("arriving.com", "approve",
          OTHER_REGISTRAR), 200);
        await deliverQueuedNotifications();

        const transfer = await storedTransfer(uid, "arriving.com");
        assert.equal(transfer?.state, "completed");
        assert.equal(transfer?.gainingRegistrar, TEST_REGISTRAR_ID);
        assert.equal(transfer?.losingRegistrar, OTHER_REGISTRAR,
          "counterpartyRegistrar を移管元として記録すること");
        const domain = await storedDomain(uid, "arriving.com");
        assert.equal(domain?.lifecycle, "active");
        assert.equal(domain?.registry, "kitaqsign");
        assert.equal(typeof domain?.autoRenew, "boolean",
          "listDomains が読める形で書くこと");
        assert.deepEqual(domain?.nameservers, ["ns1.theirs.example"]);
      });

    it("completes an inbound transfer even when the approve notification " +
      "stays queued (deadline probe finds the transferPeriod stamp)",
    async () => {
      // The `approve` notification is documented to reach us eventually, but
      // the reconciler is the backstop for when it does not — the same
      // `transferPeriod` RGP stamp that proves an outbound transfer landed
      // also proves an inbound one did, without waiting on the poll queue.
      const uid = await freshUid();
      seedTheirDomain("queued-approve.com");
      await callAs(requestTransfer, {
        domainName: "queued-approve.com",
        authInfo: THEIR_AUTH_INFO,
      }, uid);

      assert.equal(
        sign.transferAs("queued-approve.com", "approve", OTHER_REGISTRAR),
        200);
      // Deliberately not delivered: deliverQueuedNotifications() is skipped
      // so the approve message stays on the queue, unread by us.

      const summary = await reconcilePendingTransfers();

      assert.ok(summary.completed >= 1);
      assert.equal(
        (await storedTransfer(uid, "queued-approve.com"))?.state,
        "completed", "registrant の一致ではなく transferPeriod で決着すること");
      const domain = await storedDomain(uid, "queued-approve.com");
      assert.equal(domain?.lifecycle, "active");
    });

    it("leaves an inbound transfer pending inside the reject slack, then " +
      "rejects it once the slack has passed", async () => {
      // The losing side rejects, but — same gap as above — a `reject`
      // notification is also addressed to the gaining side only, so it may
      // simply not have arrived yet. One full poll cycle past the deadline
      // (INBOUND_REJECT_SLACK_MS) is given before giving up on it.
      const uid = await freshUid();
      seedTheirDomain("slow-reject.com");
      await callAs(requestTransfer, {
        domainName: "slow-reject.com",
        authInfo: THEIR_AUTH_INFO,
      }, uid);
      sign.transferAs("slow-reject.com", "reject", OTHER_REGISTRAR);
      // Not delivered here either.

      const ref = db().collection(COLLECTIONS.transfers)
        .doc(`${uid}__slow-reject.com`);
      await ref.update({
        autoApproveAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      });
      await reconcilePendingTransfers();
      assert.equal((await storedTransfer(uid, "slow-reject.com"))?.state,
        "pending", "スラック内はまだ決着させないこと");

      await ref.update({
        autoApproveAt: new Date(Date.now() - 15 * 60_000).toISOString(),
      });
      const summary = await reconcilePendingTransfers();

      assert.ok(summary.closed >= 1);
      assert.equal((await storedTransfer(uid, "slow-reject.com"))?.state,
        "rejected");
      assert.equal(await storedDomain(uid, "slow-reject.com"), undefined,
        "拒否された移管でドメインを一覧に出さないこと");
    });

    it("records the losing side's rejection without our doing anything",
      async () => {
        const uid = await freshUid();
        seedTheirDomain("refused.com");
        await callAs(requestTransfer, {
          domainName: "refused.com",
          authInfo: THEIR_AUTH_INFO,
        }, uid);

        sign.transferAs("refused.com", "reject", OTHER_REGISTRAR);
        await deliverQueuedNotifications();

        assert.equal((await storedTransfer(uid, "refused.com"))?.state,
          "rejected");
        const domain = await storedDomain(uid, "refused.com");
        assert.equal(domain, undefined,
          "引き取れなかったドメインを一覧に出さないこと");
      });

    it("still understands a registry that uses a per-operation msgType",
      async () => {
        // The documented type is `domain:transfer` + `payload.op`, but the
        // field is a free string: a registry spelling the operation into the
        // type must not go unhandled (the fallback path in classifyEvent).
        const uid = await freshUid();
        seedTheirDomain("legacy-spelling.com");
        await callAs(requestTransfer, {
          domainName: "legacy-spelling.com",
          authInfo: THEIR_AUTH_INFO,
        }, uid);

        // No `op`, no counterparty: everything has to come from the type.
        await deliverNotification("TRANSFER_REJECT", {
          domain: "legacy-spelling.com",
        });

        assert.equal((await storedTransfer(uid, "legacy-spelling.com"))?.state,
          "rejected");
      });

    it("reconciles an auto-approved outbound transfer the registry never " +
      "told us about (20分自動承認の通知は gaining にしか届かない)",
    async () => {
      // Documented routing: an `approve` — including the one the registry
      // sends on the losing registrar's behalf after 20 minutes — is
      // delivered to the *gaining* side only. Nothing tells us the domain
      // left; the reconciler notices by re-reading `domain:info` and finding
      // the `transferPeriod` RGP stamp where `pendingTransfer` used to be.
      const uid = await freshUid();
      await registerOurDomain(uid, "auto-approved.com");
      sign.transferAs("auto-approved.com", "request", OTHER_REGISTRAR);
      await deliverQueuedNotifications();

      // 20 minutes later the registry approves on our behalf.
      sign.transferAs("auto-approved.com", "approve", TEST_REGISTRAR_ID);
      await deliverQueuedNotifications();

      assert.equal(sign.getDomain("auto-approved.com")?.sponsor,
        OTHER_REGISTRAR, "レジストリ側では移管が成立していること");
      assert.equal(sign.queueLength(), 0, "losing 側には通知が積まれないこと");
      assert.equal((await storedTransfer(uid, "auto-approved.com"))?.state,
        "pending", "通知が無い以上、reconcile 前は pending のままであること");

      const summary = await reconcilePendingTransfers();

      // The run may also settle strays from earlier tests; what matters is
      // that at least this one completed, and precisely how it ended.
      assert.ok(summary.completed >= 1);
      assert.equal((await storedTransfer(uid, "auto-approved.com"))?.state,
        "completed");
      assert.equal(
        (await storedDomain(uid, "auto-approved.com"))?.lifecycle,
        "gone", "一覧から「使用可能」として消えること");

      // What the screens are allowed to see and do from here on.
      const listed = (await listOwnedDomains(uid))
        .find((item) => item.name === "auto-approved.com");
      assert.equal(listed?.lifecycle, "gone",
        "一覧では 使用不可 セクションに入ること");
      assert.equal(listed?.goneReason, "transferred",
        "行のラベルは「移管済み」になること");
      assert.equal(await getOwnedDomain(uid, "auto-approved.com"), null,
        "詳細画面のライブ info は not-found として扱われること" +
        "（再取得した他人のデータを見せない）");
      await assert.rejects(
        assertOwnsDomain(uid, "auto-approved.com"),
        OwnershipError,
        "更新系の共通所有権チェックが gone を弾くこと");
    });

    it("reconciles a rejection that happened behind our back, keeping the " +
      "domain", async () => {
      // The losing side can also answer from the registry console; `reject`
      // notifications go to the gaining side only. The window closed, the
      // domain is still here, no `transferPeriod` — so the record closes as
      // cancelled and the member keeps the name.
      const uid = await freshUid();
      await registerOurDomain(uid, "declined-elsewhere.com");
      sign.transferAs("declined-elsewhere.com", "request", OTHER_REGISTRAR);
      await deliverQueuedNotifications();

      sign.transferAs("declined-elsewhere.com", "reject", TEST_REGISTRAR_ID);
      await deliverQueuedNotifications();

      // The record's deadline is our own clock plus 20 minutes; the window
      // has to be over before a silent rejection may be settled.
      await db().collection(COLLECTIONS.transfers)
        .doc(`${uid}__declined-elsewhere.com`)
        .update({
          autoApproveAt: new Date(Date.now() - 60_000).toISOString(),
        });
      const summary = await reconcilePendingTransfers();

      assert.ok(summary.closed >= 1);
      assert.equal(
        (await storedTransfer(uid, "declined-elsewhere.com"))?.state,
        "cancelled");
      assert.equal(
        (await storedDomain(uid, "declined-elsewhere.com"))?.lifecycle,
        "active", "拒否で終わった移管はドメインを奪わないこと");
    });

    it("leaves a transfer the registry still shows as pending alone",
      async () => {
        const uid = await freshUid();
        await registerOurDomain(uid, "still-waiting.com");
        sign.transferAs("still-waiting.com", "request", OTHER_REGISTRAR);
        await deliverQueuedNotifications();

        await reconcilePendingTransfers();

        assert.equal(
          (await storedTransfer(uid, "still-waiting.com"))?.state,
          "pending");
      });

    it("completes an outbound transfer if an approve does reach the losing " +
      "side", async () => {
      // Undocumented, but harmless to support: an `approve` that arrives
      // where no inbound record exists is matched against the domain we
      // actually hold, which is the only transfer it can be about.
      const uid = await freshUid();
      await registerOurDomain(uid, "handed-over-by-poll.com");
      sign.transferAs("handed-over-by-poll.com", "request", OTHER_REGISTRAR);
      await deliverQueuedNotifications();

      sign.transferAs("handed-over-by-poll.com", "approve", TEST_REGISTRAR_ID);
      await deliverNotification(TRANSFER_MSG_TYPE, {
        op: "approve",
        domain: "handed-over-by-poll.com",
        counterpartyRegistrar: OTHER_REGISTRAR,
      });

      assert.equal(
        (await storedTransfer(uid, "handed-over-by-poll.com"))?.state,
        "completed");
      assert.equal(
        (await storedDomain(uid, "handed-over-by-poll.com"))?.lifecycle,
        "gone");
    });

    it("does not reopen a settled transfer when an old request message is " +
      "redelivered", async () => {
      const uid = await freshUid();
      await registerOurDomain(uid, "redelivered.com");
      sign.transferAs("redelivered.com", "request", OTHER_REGISTRAR);
      await deliverQueuedNotifications();
      await callAs(respondTransfer, {
        domainName: "redelivered.com",
        action: "reject",
      }, uid);

      // A redelivery is the *same* message — same id — coming round again
      // after a failed ack. Replay it under its original id.
      const delivered = (await storedTransfer(uid, "redelivered.com"))
        ?.lastPollMessageId as string;
      const originalId = Number(delivered.split("__")[1]);
      sign.enqueueMessage(TRANSFER_MSG_TYPE, {
        op: "request",
        domain: "redelivered.com",
        counterpartyRegistrar: OTHER_REGISTRAR,
      }, originalId);
      await drainRegistryQueue("kitaqsign");

      assert.equal((await storedTransfer(uid, "redelivered.com"))?.state,
        "rejected", "決着済みの移管を古い通知で復活させないこと");
    });

    it("revives a stale gone mirror when the registry delivers a request " +
      "for a domain that came back to us", async () => {
      // a.com's real-world path: transferred away (mirror → gone), later
      // returned to our sponsorship via the registry console, then a new
      // transfer request arrives. The request reaching OUR queue is proof we
      // sponsor the name again; dropping it left the member with no approval
      // alert while the 20-minute auto-approve clock ran.
      const uid = await freshUid();
      await registerOurDomain(uid, "came-back.com");
      sign.transferAs("came-back.com", "request", OTHER_REGISTRAR);
      await deliverQueuedNotifications();
      sign.transferAs("came-back.com", "approve", TEST_REGISTRAR_ID);
      await deliverQueuedNotifications();
      await reconcilePendingTransfers();
      assert.equal((await storedDomain(uid, "came-back.com"))?.lifecycle,
        "gone", "前段: 移管OUTでミラーが gone になっていること");

      // The console hands the domain back to us, registrant unchanged.
      const domain = sign.getDomain("came-back.com");
      assert.ok(domain);
      domain.sponsor = TEST_REGISTRAR_ID;

      sign.transferAs("came-back.com", "request", OTHER_REGISTRAR);
      await deliverQueuedNotifications();

      const record = await storedTransfer(uid, "came-back.com");
      assert.equal(record?.state, "pending",
        "申請が承認画面に出る状態になること");
      assert.equal(record?.direction, "out");
      assert.notEqual((await storedDomain(uid, "came-back.com"))?.lifecycle,
        "gone", "ミラーが実態に合わせて復活していること");
    });

    it("keeps ignoring a request for a gone name someone else now holds",
      async () => {
        const uid = await freshUid();
        await registerOurDomain(uid, "not-back.com");
        sign.transferAs("not-back.com", "request", OTHER_REGISTRAR);
        await deliverQueuedNotifications();
        sign.transferAs("not-back.com", "approve", TEST_REGISTRAR_ID);
        await deliverQueuedNotifications();
        await reconcilePendingTransfers();

        // The name is re-registered by a different registrant; a stray
        // request notification must not resurrect the old member's mirror.
        const domain = sign.getDomain("not-back.com");
        assert.ok(domain);
        domain.sponsor = TEST_REGISTRAR_ID;
        domain.registrant = "U999999";

        sign.transferAs("not-back.com", "request", OTHER_REGISTRAR);
        await deliverQueuedNotifications();

        assert.equal((await storedDomain(uid, "not-back.com"))?.lifecycle,
          "gone", "他人の registrant では復活させないこと");
        assert.equal((await storedTransfer(uid, "not-back.com"))?.state,
          "completed", "古い完了記録が申請として再オープンされないこと");
      });

    it("reopens as a fresh outbound transfer when a *new* request arrives " +
      "for a name whose previous transfer already settled", async () => {
      // The member gained the domain earlier (record: in / completed). Now
      // another registrar asks for it. That is not a redelivery — new
      // message, new id — and refusing it would leave the member with no
      // approval screen while the 20-minute clock runs (the bug where the
      // domain then silently left but still showed as 使用可能).
      const uid = await freshUid();
      seedTheirDomain("boomerang.com");
      await callAs(requestTransfer, {
        domainName: "boomerang.com",
        authInfo: THEIR_AUTH_INFO,
      }, uid);
      sign.transferAs("boomerang.com", "approve", OTHER_REGISTRAR);
      await deliverQueuedNotifications();
      assert.equal((await storedTransfer(uid, "boomerang.com"))?.state,
        "completed", "前段: 移管INが完了していること");

      // Months later, someone requests it away from us.
      sign.transferAs("boomerang.com", "request", OTHER_REGISTRAR);
      await deliverQueuedNotifications();

      const reopened = await storedTransfer(uid, "boomerang.com");
      assert.equal(reopened?.state, "pending",
        "新しい申請として pending に戻ること（承認画面に出る前提）");
      assert.equal(reopened?.direction, "out");

      // And the normal losing-side answer works on the reopened record.
      await callAs(respondTransfer, {
        domainName: "boomerang.com",
        action: "approve",
      }, uid);
      assert.equal((await storedTransfer(uid, "boomerang.com"))?.state,
        "completed");
      assert.equal((await storedDomain(uid, "boomerang.com"))?.lifecycle,
        "gone", "承認後は一覧から「使用可能」として消えること");
    });

    it("sweeps a pendingDelete mirror whose grace period silently ended",
      async () => {
        // TODO §3: the registry purges without a notification. The same
        // reconcile run re-reads pendingDelete mirrors.
        const uid = await freshUid();
        await registerOurDomain(uid, "quietly-purged.com");
        await callAs(deleteDomainCallable, {domainName: "quietly-purged.com"},
          uid);
        assert.equal(
          (await storedDomain(uid, "quietly-purged.com"))?.lifecycle,
          "pendingDelete");
        sign.expireGracePeriod("quietly-purged.com");

        const summary = await reconcilePendingTransfers();

        assert.ok(summary.mirrorsGone >= 1);
        assert.equal(
          (await storedDomain(uid, "quietly-purged.com"))?.lifecycle,
          "gone");
        const listed = (await listOwnedDomains(uid))
          .find((item) => item.name === "quietly-purged.com");
        assert.equal(listed?.goneReason, "unrecoverable",
          "移管ではない消滅は「復旧不可」と表示されること");
      });

    it("never reads a request as an approval, whatever else the payload says",
      async () => {
        // Regression: the pre-`op` heuristic matched "approve" anywhere in
        // the message, so a request whose status mentioned approval could
        // hand the domain away on screen. `op` is now the discriminator.
        const uid = await freshUid();
        await registerOurDomain(uid, "not-approved.com");
        sign.transferAs("not-approved.com", "request", OTHER_REGISTRAR);
        await drainRegistryQueue("kitaqsign");

        await deliverNotification(TRANSFER_MSG_TYPE, {
          op: "request",
          domain: "not-approved.com",
          counterpartyRegistrar: OTHER_REGISTRAR,
          status: "pendingApproval",
        });

        assert.equal((await storedTransfer(uid, "not-approved.com"))?.state,
          "pending");
        assert.equal((await storedDomain(uid, "not-approved.com"))?.lifecycle,
          "active", "申請の通知でドメインを手放さないこと");
      });

    it("ignores a request notification for a domain we do not hold",
      async () => {
        // `request` only ever reaches the losing registrar, so a name we do
        // not hold is not ours to act on — and must never be pinned on
        // whichever member happens to have an inbound record for it.
        const other = await freshUid();
        seedTheirDomain("strangers.com");
        await callAs(requestTransfer, {
          domainName: "strangers.com",
          authInfo: THEIR_AUTH_INFO,
        }, other);
        await drainRegistryQueue("kitaqsign");

        await deliverNotification(TRANSFER_MSG_TYPE, {
          op: "request",
          domain: "strangers.com",
          counterpartyRegistrar: OTHER_REGISTRAR,
        });

        const stored = await storedTransfer(other, "strangers.com");
        assert.equal(stored?.state, "pending");
        assert.equal(stored?.direction, "in",
          "losing 宛の通知を他人の移管INに紐づけないこと");
      });

    it("keeps the queue moving for a transfer message it cannot parse",
      async () => {
        sign.enqueueMessage(TRANSFER_MSG_TYPE, {op: "request"});
        const drain = await drainRegistryQueue("kitaqsign");

        assert.equal(drain.acked, 1);
        assert.equal(drain.handlerFailures, 0,
          "解釈できない通知でキューを止めないこと");
        assert.equal(sign.queueLength(), 0);
      });
  });
});
