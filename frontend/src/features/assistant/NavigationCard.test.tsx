import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NavigationCard } from './NavigationCard'
import type { NavigationSuggestion } from './types'

afterEach(cleanup)

const DNS_RECORDS_NAVIGATION: NavigationSuggestion = {
  routeId: 'DNS_RECORDS',
  resolvedPath: '/domains/example.com/dns?mode=records',
  title: 'DNS設定（レコード設定モード）',
  description: 'DNSレコード（A・AAAA・CNAME・MX・TXTなど）の確認・変更ができます。レシピからお使いのサービスを選ぶこともできます。',
}

describe('NavigationCard', () => {
  it('renders the route title and description', () => {
    render(<NavigationCard navigation={DNS_RECORDS_NAVIGATION} onNavigate={vi.fn()} />)

    expect(screen.getByText(DNS_RECORDS_NAVIGATION.title)).toBeInTheDocument()
    expect(screen.getByText(DNS_RECORDS_NAVIGATION.description)).toBeInTheDocument()
  })

  it('renders the Playbook guidance and warnings when `intent` resolves to a Playbook that has them', () => {
    const navigation: NavigationSuggestion = {
      ...DNS_RECORDS_NAVIGATION,
      // CHANGE_NAMESERVER's Playbook carries the mandatory NAMESERVER_CHANGE_WARNING.
      intent: 'CHANGE_NAMESERVER',
    }

    render(<NavigationCard navigation={navigation} onNavigate={vi.fn()} />)

    expect(screen.getByText('DNS設定のネームサーバー変更モードから変更できます。')).toBeInTheDocument()
    expect(
      screen.getByText('ネームサーバーを変更すると、このサービスで設定したDNSレコードは使われなくなります。メールも止まります。'),
    ).toBeInTheDocument()
  })

  it('renders no guidance/warnings when `intent` is undefined', () => {
    render(<NavigationCard navigation={DNS_RECORDS_NAVIGATION} onNavigate={vi.fn()} />)

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('calls onNavigate with the navigation object when the CTA is clicked', async () => {
    const user = userEvent.setup()
    const onNavigate = vi.fn()
    render(<NavigationCard navigation={DNS_RECORDS_NAVIGATION} onNavigate={onNavigate} />)

    await user.click(screen.getByRole('button', { name: 'DNS設定（レコード設定モード）へ進む' }))

    expect(onNavigate).toHaveBeenCalledWith(DNS_RECORDS_NAVIGATION)
  })

  it('never renders an href, and never leaks resolvedPath into any DOM attribute', () => {
    const { container } = render(<NavigationCard navigation={DNS_RECORDS_NAVIGATION} onNavigate={vi.fn()} />)

    expect(container.querySelectorAll('[href]')).toHaveLength(0)

    for (const element of container.querySelectorAll('*')) {
      for (const attribute of Array.from(element.attributes)) {
        expect(attribute.value).not.toContain(DNS_RECORDS_NAVIGATION.resolvedPath)
      }
    }
  })
})
