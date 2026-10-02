/**
 * In-memory stand-in for the member table, persisted to localStorage so a
 * reload keeps the accounts you registered (needed to exercise FIG.7).
 *
 * This is a mock: passwords are stored as-is. The real backend hashes them with
 * bcrypt (spec §6.8) - nothing here describes production behaviour.
 */
export type MockUser = {
  id: string
  email: string
  password: string
  displayName: string
  /**
   * Deterministic per-registry contact id (spec §5.1: "U" + zero-padded member
   * id). Kept here to document what the backend derives at registration time.
   */
  contactId: string
  /** FIG.5: both registries created, or only one of them. */
  contactStatus: 'both_ready' | 'partial'
}

type TokenPayload = { sub: string; email: string; issuedAt: number }

const USERS_KEY = 'registrar.mock.users'
const REVOKED_KEY = 'registrar.mock.revokedTokens'

const SEED_USERS: MockUser[] = [
  {
    id: '1',
    email: 'demo@example.com',
    password: 'password123',
    displayName: 'Taro Test',
    contactId: 'U000001',
    contactStatus: 'both_ready',
  },
]

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Ignore: the in-memory copy still serves this tab.
  }
}

let users: MockUser[] = readJson(USERS_KEY, SEED_USERS)
let revokedTokens: string[] = readJson(REVOKED_KEY, [])

function persistUsers(): void {
  writeJson(USERS_KEY, users)
}

export function listUsers(): readonly MockUser[] {
  return users
}

export function findUserByEmail(email: string): MockUser | undefined {
  const normalized = email.trim().toLowerCase()
  return users.find((user) => user.email.toLowerCase() === normalized)
}

/*
 * `createUser`/`contactIdFor` and the whole "Registration wizard (signup
 * flow)" pending-signup section that used to live here (PendingSignup,
 * SIGNUP_DEV_CODE, upsertPendingSignup, findPendingSignup,
 * markPendingSignupVerified, removePendingSignup, resetPendingSignups) were
 * REMOVED: the auth/signup surface no longer goes through MSW at all
 * (api/authApi.ts, api/signupApi.ts talk to real Firebase Auth + Callables +
 * the Cookie session). `signupApi.ts` keeps its own client-side-only
 * `SIGNUP_DEV_CODE` for the mocked verification-code step (spec-decided,
 * no server round-trip) - see that file's doc comment.
 */

export function resetUsers(): void {
  users = SEED_USERS
  revokedTokens = []
  persistUsers()
  writeJson(REVOKED_KEY, revokedTokens)
}

function encodePayload(payload: TokenPayload): string {
  const bytes = new TextEncoder().encode(JSON.stringify(payload))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function decodePayload(encoded: string): TokenPayload | null {
  try {
    const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0))
    return JSON.parse(new TextDecoder().decode(bytes)) as TokenPayload
  } catch {
    return null
  }
}

/** Shaped like a JWT (header.payload.signature) but not signed - it is a mock. */
export function issueToken(user: MockUser): string {
  const payload: TokenPayload = { sub: user.id, email: user.email, issuedAt: Date.now() }
  return `mock.${encodePayload(payload)}.unsigned`
}

export function revokeToken(token: string): void {
  if (revokedTokens.includes(token)) return
  revokedTokens = [...revokedTokens, token]
  writeJson(REVOKED_KEY, revokedTokens)
}

export function bearerTokenFrom(request: Request): string | null {
  const header = request.headers.get('Authorization')
  if (!header?.startsWith('Bearer ')) return null
  return header.slice('Bearer '.length)
}

// --- Owned domains (FIG.8 dashboard demo) ---------------------------------

/**
 * Mock owned-domain record, seeded per §3.5 display state. Since the callable
 * migration, the my-page list/detail come from the real callables — MSW
 * keeps ONLY the read-only seed list behind GET /api/domains for the FIG.8
 * bearer-token demo (pages/DashboardPage.tsx). Orders and transfer requests
 * moved to src/test/fakeBackend.ts (the functions-stubs codebase that once
 * carried them is deleted).
 *
 * Mock simplification: domains are not keyed by userId — every authenticated
 * member sees the same demo portfolio. Ownership checks are a backend concern
 * (§7.3) that this mock does not reproduce.
 */
export type MockDomain = {
  name: string
  registry: 'kitaqsign' | 'kitaqnic'
  statuses: string[]
  rgpStatuses: string[]
  exDate: string
  registeredAt: string
  autoRenew: boolean
  nameservers: string[]
  authInfo: string
  restorableUntil?: string
  autoRenewCancelableUntil?: string
}

const DOMAINS_KEY = 'registrar.mock.domains'

function isoDaysFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()
}

const DEFAULT_NAMESERVERS = ['ns1.teamc-dns.example', 'ns2.teamc-dns.example']

function seedDomains(): MockDomain[] {
  return [
    {
      name: 'teamc-demo.com',
      registry: 'kitaqsign',
      statuses: ['ok'],
      rgpStatuses: [],
      exDate: isoDaysFromNow(320),
      registeredAt: isoDaysFromNow(-45),
      autoRenew: true,
      nameservers: DEFAULT_NAMESERVERS,
      authInfo: 'K9#mQ2xTz8LpVr4N!bW7sD1e',
    },
    {
      name: 'teamc-portfolio.site',
      registry: 'kitaqnic',
      statuses: ['clientTransferProhibited', 'clientUpdateProhibited'],
      rgpStatuses: [],
      exDate: isoDaysFromNow(210),
      registeredAt: isoDaysFromNow(-155),
      autoRenew: true,
      nameservers: DEFAULT_NAMESERVERS,
      authInfo: 'Xp3!vLm9Qc6Rt2Zy8Ka5#dF1',
    },
    {
      name: 'teamc-shop.store',
      registry: 'kitaqnic',
      statuses: ['ok'],
      rgpStatuses: [],
      // 期限間近 + 自動更新OFF: the list must visibly warn (§6.4).
      exDate: isoDaysFromNow(24),
      registeredAt: isoDaysFromNow(-341),
      autoRenew: false,
      nameservers: DEFAULT_NAMESERVERS,
      authInfo: 'Wq8*nB4Jt7Xe2Vs6Mh1$cR9y',
    },
    {
      name: 'teamc-easy.net',
      registry: 'kitaqsign',
      statuses: ['inactive'],
      rgpStatuses: [],
      exDate: isoDaysFromNow(350),
      registeredAt: isoDaysFromNow(-15),
      autoRenew: true,
      nameservers: [],
      authInfo: 'Df5!kP1Yw9Sg3Nz7Lb2%vT6u',
    },
    {
      name: 'teamc-blog.online',
      registry: 'kitaqnic',
      statuses: ['ok'],
      // §3.6: auto-renewed 5 days ago -> autoRenewPeriod for 45 days.
      rgpStatuses: ['autoRenewPeriod'],
      exDate: isoDaysFromNow(360),
      registeredAt: isoDaysFromNow(-370),
      autoRenew: true,
      nameservers: DEFAULT_NAMESERVERS,
      authInfo: 'Gm2#hV7Rc4Tq9Xw1Zk6!pJ3s',
      autoRenewCancelableUntil: isoDaysFromNow(40),
    },
    {
      name: 'teamc-moving.xyz',
      registry: 'kitaqnic',
      statuses: ['pendingTransfer'],
      rgpStatuses: [],
      exDate: isoDaysFromNow(110),
      registeredAt: isoDaysFromNow(-255),
      autoRenew: true,
      nameservers: DEFAULT_NAMESERVERS,
      authInfo: 'Bt6!wN3Fh8Kd5Qy2Sv9*mX4z',
    },
    {
      name: 'teamc-old.icu',
      registry: 'kitaqnic',
      // RGP: delete sets pendingDelete *and* redemptionPeriod; only the
      // latter makes 復旧 possible (45 days, both registries).
      statuses: ['pendingDelete'],
      rgpStatuses: ['redemptionPeriod'],
      exDate: isoDaysFromNow(-7),
      registeredAt: isoDaysFromNow(-372),
      autoRenew: false,
      nameservers: DEFAULT_NAMESERVERS,
      authInfo: 'Jr4$cZ8Vp1Ln6Ty3Wb7!qG2k',
      // 22 days into the 45-day window.
      restorableUntil: isoDaysFromNow(23),
    },
  ]
}

let domains: MockDomain[] = readJson(DOMAINS_KEY, null as MockDomain[] | null) ?? seedDomains()

function persistDomains(): void {
  writeJson(DOMAINS_KEY, domains)
}

// First run: persist the seeds so reloads stay consistent.
persistDomains()

export function listDomains(): readonly MockDomain[] {
  return domains
}

/** Returns the user a token belongs to, or null when it is invalid/revoked. */
export function resolveToken(token: string | null): MockUser | null {
  if (!token || revokedTokens.includes(token)) return null
  const [prefix, encodedPayload] = token.split('.')
  if (prefix !== 'mock' || !encodedPayload) return null
  const payload = decodePayload(encodedPayload)
  if (!payload) return null
  return users.find((user) => user.id === payload.sub) ?? null
}
