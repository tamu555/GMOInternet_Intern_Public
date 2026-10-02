/**
 * Cloud Functions entry point.
 *
 * `config/options` must be imported first: it calls `setGlobalOptions`, which
 * has to run before any function is defined, otherwise the region and
 * instance cap are not applied.
 */
import "./config/options";

export {cleanupAbandonedGoogleSignups} from "./auth/cleanup.js";
export {
  deleteAccountWithGoogle,
  deleteAccountWithPassword,
  purgeAccount,
  restoreAccount,
  submitAdditionalInfo,
} from "./auth/account-lifecycle.js";
export {registerWithEmailPassword} from "./auth/registration.js";
export {
  resendEmailVerificationCode,
  startEmailVerification,
  verifyEmailCode,
} from "./auth/verification.js";
export {
  issueCsrfToken,
  sessionLogin,
  sessionLogout,
  sessionMe,
} from "./auth/session.js";

export {searchDomains} from "./api/searchDomains";
export {listTlds} from "./api/listTlds";
export {getMyProfile} from "./api/getMyProfile";
export {updateMyProfile} from "./api/updateMyProfile";
export {createOrder} from "./api/createOrder";
export {updateDomain} from "./api/updateDomain";
export {updateAutoRenew} from "./api/updateAutoRenew";
export {updateContact} from "./api/updateContact";
export {updateHost} from "./api/updateHost";
export {createHost} from "./api/createHost";
export {renewOrder} from "./api/renewOrder";
export {getOrder} from "./api/getOrder";
export {listDomains} from "./api/listDomains";
export {getDomainInfo} from "./api/getDomainInfo";
export {deleteDomain} from "./api/deleteDomain";
export {
  listDnsRecords,
  resolveDns,
  saveDnsRecords,
} from "./api/dnsRecords";
export {restoreDomain} from "./api/restoreDomain";
export {rotateAuthInfo} from "./api/rotateAuthInfo";
export {
  cancelTransfer,
  getTransferStatus,
  listTransfers,
  requestTransfer,
  respondTransfer,
} from "./api/transferCallables";
export {
  addWatch,
  cancelWatch,
  listWatches,
} from "./api/watchCallables";
export {drainPollQueue} from "./api/drainPollQueue";
export {runExpirySweep} from "./api/runExpirySweep";
export {devForceRegistry503} from "./api/devForceRegistry503";
export {devRegistryMaintenance} from "./api/devRegistryMaintenance";
export {devSetDomainExpiry} from "./api/devSetDomainExpiry";
export {pollWorker} from "./jobs/pollWorker";
export {expiryWorker} from "./jobs/expiryWorker";
