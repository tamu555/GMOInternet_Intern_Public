/**
 * Native <select> styled to match this project's shadcn <Input>
 * (h-10 / same border + focus ring — see src/components/ui/input.tsx).
 *
 * Some selects in the signup wizard stay NATIVE on purpose: the flow tests
 * drive them with userEvent.selectOptions, which only works on a real
 * <select>. This class is what keeps them visually indistinguishable from the
 * shadcn controls around them.
 */
export const NATIVE_SELECT_CLASS =
  'h-10 min-w-0 rounded-none border border-input bg-transparent px-3.5 py-1 text-base text-foreground transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm'
