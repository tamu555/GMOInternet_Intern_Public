/**
 * `rotateAuthInfo` — 移管用の認証コードの再生成 (spec 3.9 / 6.6).
 *
 * Two properties are worth a test each, and they pull in opposite directions.
 *
 * The member has to *get* the new code: it is minted once, cannot be read
 * back, and is what they are about to paste into another registrar's transfer
 * form. And nobody else may get it: minting a transfer key for a domain is as
 * good as handing the domain over, so the ownership gate has to hold before
 * the registry is ever asked, and the value must not settle anywhere it could
 * later be read from — not the mirror, not the registry log.
 */
import {after, before, beforeEach, describe, it} from "node:test";
import assert from "node:assert/strict";
import {
  HAS_EMULATOR,
  SKIP_REASON,
  activeMemberUid,
  callAs,
  expectHttpsError,
  requireEmulator,
  testIdempotencyKey,
  testUid,
  useStubRegistries,
} from "../helpers/testEnv";
import {StubRegistry} from "../helpers/stubRegistry";
import {
  cleanupTestData,
  snapshotCounters,
  type CounterSnapshot,
} from "../helpers/firestoreCleanup";
import {createOrder} from "../../src/api/createOrder";
import {rotateAuthInfo} from "../../src/api/rotateAuthInfo";
import {resetTldCache} from "../../src/bridge/registryRouter";
import {COLLECTIONS, db} from "../../src/config/firebase";

/** Shape the Callable answers with (domain/rotateAuthInfo.ts). */
interface RotationResponse {
  domainName: string;
  registry: string;
  authInfo: string;
  rotatedAt: string;
  message: string;
}

describe("rotateAuthInfo", {skip: HAS_EMULATOR ? false : SKIP_REASON}, () => {
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
    await cleanupTestData(uids, counters);
    await sign.stop();
    await nic.stop();
  });

  beforeEach(() => {
    sign.reset();
    nic.reset();
    resetTldCache();
  });

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
   * Registers a domain through the real order flow.
   *
   * @param {string} uid Owner.
   * @param {string} name Domain name.
   * @return {Promise<void>} Resolves once the domain exists.
   */
  async function register(uid: string, name: string): Promise<void> {
    await callAs(createOrder, {
      domainName: name,
      idempotencyKey: testIdempotencyKey(),
    }, uid);
  }

  /**
   * Reads the Firestore mirror of one member's domain.
   *
   * @param {string} uid Owner.
   * @param {string} name Domain name.
   * @return {Promise<FirebaseFirestore.DocumentData | undefined>} Stored doc.
   */
  async function mirrorOf(
    uid: string,
    name: string,
  ): Promise<FirebaseFirestore.DocumentData | undefined> {
    const doc = await db().collection(COLLECTIONS.domains)
      .doc(`${uid}__${name}`).get();
    return doc.data();
  }

  describe("access control (spec 7.3)", () => {
    it("rejects an anonymous caller", async () => {
      const code = await expectHttpsError(
        callAs(rotateAuthInfo, {domainName: "anon.com"}),
      );
      assert.equal(code, "unauthenticated");
    });

    it("rejects a signed-in caller with no user document", async () => {
      // Regression for requireActiveUser (src/auth/callerGuard.ts): a valid
      // ID token alone must not be enough to reach this Callable.
      const code = await expectHttpsError(
        callAs(rotateAuthInfo, {domainName: "no-user-doc.com"}, testUid()),
      );
      assert.equal(code, "permission-denied");
    });

    it("refuses a domain the caller never registered", async () => {
      const code = await expectHttpsError(
        callAs(rotateAuthInfo, {domainName: "never-mine.com"},
          await freshUid()),
      );
      assert.equal(code, "permission-denied");
    });

    it("refuses another member's domain without touching the registry",
      async () => {
        const owner = await freshUid();
        const intruder = await freshUid();
        await register(owner, "not-yours.com");
        const before = sign.getDomain("not-yours.com")?.authInfo;

        const code = await expectHttpsError(
          callAs(rotateAuthInfo, {domainName: "not-yours.com"}, intruder),
        );

        assert.equal(code, "permission-denied");
        assert.equal(
          sign.countCalls("POST", "/domains/not-yours.com/rotate-auth-info"),
          0, "所有権チェックがレジストリより手前で効くこと");
        assert.equal(sign.getDomain("not-yours.com")?.authInfo, before,
          "他人の操作で移管パスフレーズが変わらないこと");
      });

    it("answers a missing and a foreign domain identically", async () => {
      // Telling the two apart would let a caller enumerate which names other
      // members hold (ownership.ts's uniform-failure rule).
      const owner = await freshUid();
      const intruder = await freshUid();
      await register(owner, "enumerate-me.com");

      const missing = await expectHttpsError(
        callAs(rotateAuthInfo, {domainName: "no-such-name.com"}, intruder),
      );
      const foreign = await expectHttpsError(
        callAs(rotateAuthInfo, {domainName: "enumerate-me.com"}, intruder),
      );

      assert.equal(missing, foreign);
    });
  });

  describe("happy path", () => {
    it("hands back a new code and invalidates the old one", async () => {
      const uid = await freshUid();
      await register(uid, "rotate-me.com");
      const before = sign.getDomain("rotate-me.com")?.authInfo as string;

      const result = await callAs<RotationResponse>(
        rotateAuthInfo, {domainName: "rotate-me.com"}, uid);

      assert.equal(result.domainName, "rotate-me.com");
      assert.equal(result.registry, "kitaqsign");
      assert.ok(result.authInfo.length > 0);
      assert.notEqual(result.authInfo, before,
        "再生成したのに同じコードが返らないこと");
      // The registry now checks transfers against the value we just handed
      // over, which is the whole point of the command.
      assert.equal(sign.getDomain("rotate-me.com")?.authInfo, result.authInfo);
    });

    it("says so, in the words the screen shows", async () => {
      const uid = await freshUid();
      await register(uid, "worded-rotate.com");

      const result = await callAs<RotationResponse>(
        rotateAuthInfo, {domainName: "worded-rotate.com"}, uid);

      assert.equal(
        result.message,
        "認証コード（AuthCode）を再生成しました。以前のコードは使えません。",
      );
    });

    it("mints a different code every time", async () => {
      const uid = await freshUid();
      await register(uid, "twice.com");

      const first = await callAs<RotationResponse>(
        rotateAuthInfo, {domainName: "twice.com"}, uid);
      const second = await callAs<RotationResponse>(
        rotateAuthInfo, {domainName: "twice.com"}, uid);

      assert.notEqual(first.authInfo, second.authInfo);
      assert.equal(sign.getDomain("twice.com")?.authInfo, second.authInfo,
        "最後に発行したコードだけが有効であること");
    });

    it("accepts the name in any case, as every other command does",
      async () => {
        const uid = await freshUid();
        await register(uid, "mixed-case.com");

        const result = await callAs<RotationResponse>(
          rotateAuthInfo, {domainName: "MIXED-CASE.COM"}, uid);

        assert.equal(result.domainName, "mixed-case.com");
      });

    it("routes to the registry that holds the TLD", async () => {
      const uid = await freshUid();
      await register(uid, "nic-side.shop");

      const result = await callAs<RotationResponse>(
        rotateAuthInfo, {domainName: "nic-side.shop"}, uid);

      assert.equal(result.registry, "kitaqnic");
      assert.equal(nic.getDomain("nic-side.shop")?.authInfo, result.authInfo);
      assert.equal(
        sign.countCalls("POST", "/domains/nic-side.shop/rotate-auth-info"), 0);
    });

    it("uses a clTRID that names the domain and the command", async () => {
      const uid = await freshUid();
      await register(uid, "traced-rotate.com");

      await callAs(rotateAuthInfo, {domainName: "traced-rotate.com"}, uid);

      const call = sign.calls.find((entry) =>
        entry.path === "/domains/traced-rotate.com/rotate-auth-info");
      assert.match(call?.clTRID ?? "", /^DOM-ROTATE-TRACED-ROTATE-COM-/);
    });
  });

  describe("the new code is never kept anywhere (spec 7.3)", () => {
    it("stores no copy on the mirror, and clears the stale one", async () => {
      const uid = await freshUid();
      await register(uid, "no-copy.com");
      const created = await mirrorOf(uid, "no-copy.com");
      assert.equal(typeof created?.authInfo, "string",
        "前提: 登録時のコードがミラーに残っていること");

      const result = await callAs<RotationResponse>(
        rotateAuthInfo, {domainName: "no-copy.com"}, uid);

      const stored = await mirrorOf(uid, "no-copy.com");
      assert.equal(stored?.authInfo, null,
        "無効になったコードを保持し続けないこと");
      assert.notEqual(stored?.authInfo, result.authInfo,
        "新しいコードを保存しないこと");
      assert.ok(stored?.authInfoRotatedAt, "再生成日時だけは記録すること");
    });

    it("keeps the rest of the mirror as it was", async () => {
      const uid = await freshUid();
      await register(uid, "untouched.com");
      const created = await mirrorOf(uid, "untouched.com");

      await callAs(rotateAuthInfo, {domainName: "untouched.com"}, uid);

      const stored = await mirrorOf(uid, "untouched.com");
      assert.equal(stored?.lifecycle, created?.lifecycle);
      assert.equal(stored?.registry, created?.registry);
      assert.equal(stored?.registrant, created?.registrant);
      assert.equal(stored?.autoRenew, created?.autoRenew);
    });

    it("never writes the code into the registry log", async () => {
      // The log is the one place every command leaves a trace, and it is read
      // by people debugging, not by the member. A passphrase in there would
      // outlive the rotation it belongs to.
      const uid = await freshUid();
      await register(uid, "not-logged.com");

      const result = await callAs<RotationResponse>(
        rotateAuthInfo, {domainName: "not-logged.com"}, uid);

      const logs = await db().collection(COLLECTIONS.registryLogs)
        .where("uid", "==", uid).get();
      assert.ok(logs.docs.length > 0, "前提: ログが書かれていること");
      for (const doc of logs.docs) {
        assert.equal(JSON.stringify(doc.data()).includes(result.authInfo),
          false, `registryLogs/${doc.id} に認証コードが混入している`);
      }
    });
  });

  describe("registry refusals", () => {
    it("reports a domain sponsored by another registrar as not allowed",
      async () => {
        // 403: the domain was transferred away. The registrant on it is still
        // this member's, so the ownership pre-check passes and only the
        // registry can say no — exactly as `restoreDomain` handles it.
        const uid = await freshUid();
        await register(uid, "moved-away.com");
        const ourRegistrant =
          sign.getDomain("moved-away.com")?.registrant as string;
        sign.seedDomain("moved-away.com", ourRegistrant, [], "OTHER-REG");

        const code = await expectHttpsError(
          callAs(rotateAuthInfo, {domainName: "moved-away.com"}, uid),
        );

        assert.equal(code, "permission-denied");
      });

    it("leaves no rotation marker behind when the registry refused",
      async () => {
        const uid = await freshUid();
        await register(uid, "refused-marker.com");
        const ourRegistrant =
          sign.getDomain("refused-marker.com")?.registrant as string;
        sign.seedDomain("refused-marker.com", ourRegistrant, [], "OTHER-REG");

        await expectHttpsError(
          callAs(rotateAuthInfo, {domainName: "refused-marker.com"}, uid),
        );

        const stored = await mirrorOf(uid, "refused-marker.com");
        assert.equal(stored?.authInfoRotatedAt, undefined,
          "失敗した再生成を成功として記録しないこと");
        assert.equal(typeof stored?.authInfo, "string",
          "有効なままのコードを消さないこと");
      });

    it("reports a name the registry no longer has as not found", async () => {
      const uid = await freshUid();
      await register(uid, "vanished.com");
      sign.expireGracePeriod("vanished.com");

      const code = await expectHttpsError(
        callAs(rotateAuthInfo, {domainName: "vanished.com"}, uid),
      );

      assert.equal(code, "not-found");
    });

    it("rejects a malformed name before any registry call", async () => {
      const uid = await freshUid();
      const code = await expectHttpsError(
        callAs(rotateAuthInfo, {domainName: "no-tld"}, uid),
      );
      assert.equal(code, "invalid-argument");
    });
  });
});
