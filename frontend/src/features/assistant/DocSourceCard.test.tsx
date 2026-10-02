import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DocSourceCard, SearchQueryCard } from './DocSourceCard'
import { findDocSource } from './docs/docSources'
import { searchUrlForQuery } from './docs/docResolver'

afterEach(cleanup)

const SOURCE = findDocSource('vercel-custom-domain')!

describe('DocSourceCard', () => {
  it('renders the title, publisher, and hostname before the click', () => {
    render(<DocSourceCard source={SOURCE} />)

    expect(screen.getAllByText('Vercel: 独自ドメインの追加と設定方法').length).toBeGreaterThan(0)
    expect(screen.getByText('Vercel Inc.')).toBeInTheDocument()
    expect(screen.getByText(/vercel\.com/)).toBeInTheDocument()
  })

  it('opens with the registry url exactly, target="_blank", and rel containing noopener+noreferrer', () => {
    render(<DocSourceCard source={SOURCE} />)

    const link = screen.getByRole('link', { name: /Vercel: 独自ドメインの追加と設定方法/ })
    expect(link).toHaveAttribute('href', SOURCE.url)
    expect(link).toHaveAttribute('target', '_blank')
    const rel = link.getAttribute('rel') ?? ''
    expect(rel).toContain('noopener')
    expect(rel).toContain('noreferrer')
  })

  it('shows a language badge for an English-language source and not for a Japanese one', () => {
    const { rerender } = render(<DocSourceCard source={SOURCE} />) // language: 'en'
    expect(screen.getByText('EN')).toBeInTheDocument()

    const jaSource = findDocSource('glossary-dns')!
    rerender(<DocSourceCard source={jaSource} />)
    expect(screen.queryByText('EN')).not.toBeInTheDocument()
  })
})

describe('SearchQueryCard', () => {
  const query = 'ネームサーバー 変更方法'

  it('shows the query text and a link built with searchUrlForQuery(query)', () => {
    render(<SearchQueryCard query={query} />)

    expect(screen.getByText(query)).toBeInTheDocument()
    const link = screen.getByRole('link', { name: /Googleで検索する/ })
    expect(link).toHaveAttribute('href', searchUrlForQuery(query))
    expect(link).toHaveAttribute('target', '_blank')
    const rel = link.getAttribute('rel') ?? ''
    expect(rel).toContain('noopener')
    expect(rel).toContain('noreferrer')
  })

  describe('copy button', () => {
    const originalClipboard = navigator.clipboard

    afterEach(() => {
      Object.defineProperty(navigator, 'clipboard', { value: originalClipboard, configurable: true })
    })

    it('writes the query text via navigator.clipboard.writeText when available', async () => {
      // `userEvent.setup()` installs its OWN `navigator.clipboard` stub as
      // part of setup (see `@testing-library/user-event`'s
      // `attachClipboardStubToView`) - it must run BEFORE we spy, or our spy
      // would be discarded the moment `setup()` overwrites the property.
      const user = userEvent.setup()
      const writeTextSpy = vi.spyOn(navigator.clipboard, 'writeText')

      render(<SearchQueryCard query={query} />)
      await user.click(screen.getByRole('button', { name: /コピー/ }))

      expect(writeTextSpy).toHaveBeenCalledWith(query)
    })

    it('does not throw when navigator.clipboard is undefined (jsdom / insecure context)', () => {
      // Deliberately `fireEvent.click`, not `userEvent`'s `user.click`:
      // `userEvent.setup()` always (re)installs its own clipboard stub, which
      // would silently undo the `undefined` this test needs to exercise.
      Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })

      render(<SearchQueryCard query={query} />)

      expect(() => fireEvent.click(screen.getByRole('button', { name: /コピー/ }))).not.toThrow()
    })
  })
})

describe('long titles wrap instead of overflowing (regression)', () => {
  // ⚠️ The reported bug: `buttonVariants`' base classes include
  // `whitespace-nowrap`, `shrink-0` and a fixed `h-8`, all of which assume a
  // short label. A doc title is a whole Japanese sentence, so the link rendered
  // as one unbroken line that pushed past this card and the chat column around
  // it. jsdom has no layout engine, so the class contract is what is asserted.
  const LONG_SOURCE = findDocSource('sakura-rental-zone-edit')!

  it('the link is allowed to wrap and to grow taller than one line', () => {
    render(<DocSourceCard source={LONG_SOURCE} />)
    const link = screen.getByRole('link', { name: new RegExp(LONG_SOURCE.title) })
    const className = link.getAttribute('class') ?? ''
    expect(className).toContain('whitespace-normal')
    expect(className).toContain('break-words')
    expect(className).toContain('h-auto')
    expect(className).toContain('max-w-full')
    // The base class must not also still be in effect for this button.
    expect(className).not.toMatch(/(^|\s)whitespace-nowrap(\s|$)/)
  })

  it('the search query text can wrap too', () => {
    render(<SearchQueryCard query={'エックスサーバー ネームサーバー 変更方法 とても長いクエリ'} />)
    const queryText = screen.getByText('エックスサーバー ネームサーバー 変更方法 とても長いクエリ')
    expect(queryText.getAttribute('class') ?? '').toContain('break-words')
  })
})
