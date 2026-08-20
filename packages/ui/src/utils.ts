export type ClassName = string | false | null | undefined;

export const cx = (...classes: ClassName[]) => classes.filter(Boolean).join(' ');

export const focusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background';
