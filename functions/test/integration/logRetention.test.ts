/**
 * Log retention (capacity control for the two append-only collections).
 *
 * The point under test is not "old rows get deleted" but the tiering: the
 * rows that exist to be read back late — failed registry commands (spec 7.2)
 * and unprocessed poll messages — must survive the bulk sweep. Since
 * `purgeAgedLogs` now filters on `ok`/`handled` inside the query itself
 * (see `src/domain/logRetention.ts`), the surviving rows here are not just
 * left undeleted — they are never read in the first place.
 *
 * Both queries need a composite index (`firestore.indexes.json`), but the
 * Firestore emulator does not enforce indexes, so a missing index would not
 * fail here — only against the real service.
 */
import {after, before, describe, it} from "node:test";
import assert from "node:assert/strict";
import {Timestamp} from "firebase-admin/firestore";
import {
  HAS_EMULATOR,
  SKIP_REASON,
  requireEmulator,
} from "../helpers/testEnv";
import {COLLECTIONS, db} from "../../src/config/firebase";
import {
  BULK_RETENTION_MS,
  FAILURE_RETENTION_MS,
  purgeAgedLogs,
} from "../../src/domain/logRetention";

describe("logRetention", {skip: HAS_EMULATOR ? false : SKIP_REASON}, () => {
  const NOW = new Date("2026-08-27T12:00:00Z");
  const MARK = "retention-test";
  const ids: FirebaseFirestore.DocumentReference[] = [];

  /**
   * Seeds one registryLogs row.
   *
   * @param {string} id Document id, unique per case.
   * @param {number} ageMs How old the row is relative to NOW.
   * @param {boolean} ok Whether the command it records succeeded.
   * @return {Promise<void>} Resolves once written.
   */
  async function seedLog(
    id: string,
    ageMs: number,
    ok: boolean,
  ): Promise<void> {
    const ref = db().collection(COLLECTIONS.registryLogs).doc(`${MARK}-${id}`);
    ids.push(ref);
    await ref.set({
      registry: "kitaqsign",
      command: "domain:check",
      ok,
      uid: MARK,
      requestedAt: Timestamp.fromMillis(NOW.getTime() - ageMs),
    });
  }

  /**
   * Seeds one pollMessages row.
   *
   * @param {string} id Document id, unique per case.
   * @param {number} ageMs How old the row is relative to NOW.
   * @param {string} handled Processing outcome recorded on the row.
   * @return {Promise<void>} Resolves once written.
   */
  async function seedMessage(
    id: string,
    ageMs: number,
    handled: string,
  ): Promise<void> {
    const ref = db().collection(COLLECTIONS.pollMessages).doc(`${MARK}-${id}`);
    ids.push(ref);
    await ref.set({
      registry: "kitaqsign",
      msgType: "domain:transfer",
      handled,
      acked: true,
      receivedAt: Timestamp.fromMillis(NOW.getTime() - ageMs),
    });
  }

  before(async () => {
    await requireEmulator();
  });

  after(async () => {
    await Promise.all(ids.map((ref) => ref.delete().catch(() => undefined)));
  });

  it("keeps the investigation trail while sweeping the bulk", async () => {
    const HOUR = BULK_RETENTION_MS;
    const DAY = FAILURE_RETENTION_MS;

    await seedLog("ok-fresh", HOUR / 2, true);
    await seedLog("ok-aged", HOUR * 2, true);
    await seedLog("fail-aged", HOUR * 2, false);
    await seedLog("fail-ancient", DAY + HOUR, false);
    await seedMessage("done-fresh", HOUR / 2, "done");
    await seedMessage("done-aged", HOUR * 2, "done");
    await seedMessage("failed-aged", HOUR * 2, "failed");
    await seedMessage("unhandled-aged", HOUR * 2, "unhandled");

    await purgeAgedLogs(NOW);

    const alive = async (id: string): Promise<boolean> =>
      (await db().collection(
        id.startsWith("m:") ?
          COLLECTIONS.pollMessages :
          COLLECTIONS.registryLogs,
      ).doc(`${MARK}-${id.replace("m:", "")}`).get()).exists;

    assert.equal(await alive("ok-fresh"), true,
      "1時間未満の成功行は残ること");
    assert.equal(await alive("ok-aged"), false,
      "1時間を過ぎた成功行は消えること");
    assert.equal(await alive("fail-aged"), true,
      "失敗行は1時間では消えないこと（調査キー・仕様書7.2）");
    assert.equal(await alive("fail-ancient"), false,
      "失敗行も24時間で消えること");
    assert.equal(await alive("m:done-fresh"), true);
    assert.equal(await alive("m:done-aged"), false,
      "処理済み通知は1時間で消えること");
    assert.equal(await alive("m:failed-aged"), true,
      "処理に失敗した通知はリプレイ用に残ること");
    assert.equal(await alive("m:unhandled-aged"), true,
      "未対応の通知種別はリプレイ用に残ること");
  });

  it("reports what it removed", async () => {
    await seedLog("count-a", BULK_RETENTION_MS * 3, true);
    await seedMessage("count-b", BULK_RETENTION_MS * 3, "done");

    const summary = await purgeAgedLogs(NOW);

    assert.ok(summary.registryLogsDeleted >= 1);
    assert.ok(summary.pollMessagesDeleted >= 1);
  });

  it("is idempotent: a second sweep finds nothing new", async () => {
    await purgeAgedLogs(NOW);
    const summary = await purgeAgedLogs(NOW);
    assert.equal(summary.registryLogsDeleted, 0);
    assert.equal(summary.pollMessagesDeleted, 0);
  });
});
