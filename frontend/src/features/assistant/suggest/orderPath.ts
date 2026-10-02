/**
 * Builds the `/domains/new` link for an availability-verified assistant
 * candidate (assistant-chat-design.md §4.2).
 *
 * This re-implements the exact acceptance rule `parseOrderableDomain` uses
 * (`frontend/src/features/orders/orderFormModel.ts:130-141`) rather than
 * importing it: `OrderApplicationPage`'s order page renders a hard error
 * banner whenever a domain's TLD has no pricing entry, so a link built by
 * the assistant must never land there. Since the input here is always an
 * `AssistantDomainCandidate.domain` built by `domainSuggestion.ts` from an
 * availability-verified rule/AI candidate - never anything the LLM wrote
 * directly (§9.3: the LLM never writes a URL, path, or domain the app acts
 * on) - re-deriving the same "non-empty label + priced TLD" rule locally
 * keeps this module free of any dependency on the orders feature while
 * staying provably in lockstep with it (see the shared-behaviour tests
 * below, which assert against the same `getTldPricing` source of truth
 * `parseOrderableDomain` reads from).
 */
import { getTldPricing } from '../../domains/tldData'

export function orderPathForDomain(domain: string): string | null {
  const normalized = domain.trim().toLowerCase()
  const dotIndex = normalized.indexOf('.')
  if (!normalized || dotIndex <= 0 || dotIndex === normalized.length - 1) return null

  const tld = normalized.slice(dotIndex)
  if (!getTldPricing(tld)) return null

  return `/domains/new?domain=${encodeURIComponent(normalized)}`
}
